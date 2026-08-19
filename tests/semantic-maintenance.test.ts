import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeCanonical } from "@urdira/canonical";
import { createDurableStorage, type ContentAddressedStore, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { createHttpEmbeddingProvider, createLocalHashProvider, reconcileSemanticProjection, type ResolvedSemanticProvider, type SemanticReconcilerContentReader } from "../packages/engine/src/index.js";

// `reconcileSemanticProjection` is typed against `@urdira/storage`'s
// published (dist) `WorkspaceDatabase` declaration, since that is the real
// dependency `packages/engine` declares. This test file, like the rest of
// `tests/`, imports storage directly from `src` for whitebox access. Within
// `tsconfig.tests.json`'s single flat program, those are two distinct
// declarations of the same runtime class, so a private field makes them
// nominally incompatible even though the object is identical at runtime --
// see the identical note in `tests/lexical-maintenance.test.ts`.
function asEngineWorkspaceDatabase(database: WorkspaceDatabase): Parameters<typeof reconcileSemanticProjection>[0]["database"] {
  return database as unknown as Parameters<typeof reconcileSemanticProjection>[0]["database"];
}

// D-slice sibling of `tests/lexical-maintenance.test.ts`: `reconcileSemanticProjection`
// (`packages/engine/src/semantic-reconciler.ts`) is the async, post-ready
// semantic maintenance pass the daemon submits after every successful scan.
// It reads directly from `artifact_versions`/`source_artifacts`/
// `vector_projection_rows` and writes through `WorkspaceProjectionRepository.putVectors`
// plus raw `vector_projection_rows` UPDATEs for closures -- these tests
// exercise it directly against a real `WorkspaceDatabase` and a real CAS.

const now = "2026-08-13T00:00:00.000Z";

function workspaceRegistration(workspaceId: string) {
  return { workspace_id: workspaceId, canonical_root: `/${workspaceId}`, display_root: `/${workspaceId}`, source_provider_bindings: [], status: "registered" as const, registered_at: now };
}

async function withWorkspace(workspaceId: string, test: (opened: WorkspaceDatabase, cas: ContentAddressedStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-semantic-maintenance-"));
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
// `artifact_versions` rows directly -- with foreign keys off -- exactly
// mirroring `tests/lexical-maintenance.test.ts`'s `seedTextVersion`. Text
// content is written through the REAL CAS so `reconcileSemanticProjection`
// reads bytes back through a real content reader and `putVectors`'s owner
// lookup finds a real, matching `artifact_versions` row.
async function seedTextVersion(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string, options: { readonly artifactId: string; readonly artifactVersionId: string; readonly text: string; readonly validFromGeneration: number; readonly validToGeneration?: number; readonly displayPath?: string }): Promise<void> {
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, 'physical_file', ?)", [options.artifactId, workspaceId, options.artifactId, options.artifactId, options.displayPath ?? options.artifactId, new Uint8Array([1])]);
  const blob = await cas.put(new TextEncoder().encode(options.text), { media_type: "text/plain; charset=utf-8" });
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, 'utf-8', 'text', 'digest', 'obs-1', ?, ?, ?)",
    [options.artifactVersionId, workspaceId, options.artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, options.validFromGeneration, options.validToGeneration ?? null, new Uint8Array([1])],
  );
}

/** A version whose declared `encoding` is `binary` -- `reconcileSemanticProjection` must never embed it. */
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

// Decision 17 (entity-grain semantic documents) fixture helpers -- mirror
// `tests/phase-canonical-query-data-port.test.ts`'s `recordPayload`/
// `insertRecordOccurrence` exactly: `record_occurrences.record_payload`
// stores `encodeCanonical({ body })`, the minimal wrapper
// `decodeEntityRecordBody` (`semantic-reconciler.ts`) decodes back down to
// just `body`.
function entityRecordPayload(body: Readonly<Record<string, unknown>>): Uint8Array {
  return encodeCanonical({ body });
}

async function seedEntityRecord(opened: WorkspaceDatabase, workspaceId: string, options: {
  readonly recordId: string;
  readonly recordKind: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  readonly validFromGeneration: number;
  readonly validToGeneration?: number;
  readonly body: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const payload = entityRecordPayload(options.body);
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run(
    "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES (?, ?, 'entity', ?, 'core:construct', 1, 'test', '1', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 'payload-digest', ?, ?, NULL, ?)",
    [options.recordId, workspaceId, options.recordKind, options.ownerArtifactId, options.ownerArtifactVersionId, options.validFromGeneration, options.validToGeneration ?? null, `digest-${options.recordId}`, payload.byteLength, payload, payload],
  );
}

async function closeEntityRecord(opened: WorkspaceDatabase, recordId: string, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE record_occurrences SET valid_to_generation = ? WHERE record_id = ?", [validToGeneration, recordId]);
}

/** Padding well past decision 17's 120-character minimum span, embedded inside a comment so it never changes a snippet's parseable shape. */
const ENTITY_SPAN_PADDING = "x".repeat(150);

// `type` (not `interface`) so this structurally satisfies `SqliteDatabase.all`'s
// `Record<string, unknown>` constraint -- TypeScript only infers the implicit
// index signature for object-literal type aliases (same note as `RecordRow` in
// `canonical-query-data-port.ts` and the row types in `lexical-reconciler.ts`).
type VectorRow = {
  readonly projection_record_id: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation: number | null;
  readonly profile_id: string;
  readonly executable_binding_id: string;
  readonly dimensions: number;
};

async function vectorRows(opened: WorkspaceDatabase, artifactVersionId: string): Promise<readonly VectorRow[]> {
  return opened.database.all<VectorRow>(
    "SELECT projection_record_id, valid_from_generation, valid_to_generation, profile_id, executable_binding_id, dimensions FROM vector_projection_rows WHERE owner_artifact_version_id = ? ORDER BY valid_from_generation",
    [artifactVersionId],
  );
}

async function openVectorRow(opened: WorkspaceDatabase, artifactVersionId: string): Promise<VectorRow | undefined> {
  const rows = await vectorRows(opened, artifactVersionId);
  return rows.find((row) => row.valid_to_generation === null);
}

// Decision 17 (entity-grain semantic documents) added a second pass to
// `reconcileSemanticProjection` that always runs alongside the artifact
// pass; none of these tests seed any `record_occurrences` rows, so the
// entity pass always finds zero candidates and every entity-grain count
// stays at its zero default -- these fields are REQUIRED (not optional) on
// `ReconcileSemanticProjectionResult` (the shape legitimately grew: this
// reconciler now genuinely does a second, always-attempted pass every run),
// so every `toEqual({ ...emptyResult, ... })` assertion below needs them
// listed here once rather than repeated at every call site.
const emptyResult = {
  closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, skipped_empty: 0, failed: 0,
  entity_inserted: 0, entity_closed: 0, entity_skipped_oversized: 0, entity_skipped_undecodable: 0, entity_skipped_ineligible: 0, entity_skipped_empty: 0, entity_failed: 0,
};

describe("reconcileSemanticProjection", () => {
  it("embeds every visible non-binary version, skips binary versions, marks the generation+profile complete, and is idempotent on immediate re-run; then closes stale vectors and inserts replacements after a generation bump", async () => {
    const workspaceId = "ws-semantic-reconcile";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: "function parseAlphaContent() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-2", artifactVersionId: "artv-2", text: "class BetaContentManager {}", validFromGeneration: 1 });
      await seedBinaryVersion(opened, cas, workspaceId, "art-3", "artv-3", 1);
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(first).toEqual({ generation: 1, ...emptyResult, inserted: 2, marker_written: true });

      const row1 = await openVectorRow(opened, "artv-1");
      const row2 = await openVectorRow(opened, "artv-2");
      expect(row1).toBeDefined();
      expect(row2).toBeDefined();
      expect(row1?.valid_from_generation).toBe(1);
      expect(row1?.profile_id).toBe(provider.profile.embedding_profile_id);
      expect(row1?.executable_binding_id).toBe(provider.binding.executable_binding_digest);
      expect(row1?.dimensions).toBe(provider.profile.dimensions);
      expect(await openVectorRow(opened, "artv-3")).toBeUndefined();

      // `putVectors` actually wrote real, readable vector bytes -- not just a
      // row shell -- and they round-trip through `readVector`'s digest check.
      const vectorBytes = await opened.projections.readVector(row1!.projection_record_id);
      expect(vectorBytes.byteLength).toBe(provider.profile.dimensions * 4);
      expect(vectorBytes.some((byte) => byte !== 0)).toBe(true);

      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 1, profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, document_grains: ["artifact", "entity"], entity_policy_digest: expect.stringMatching(/^sha256:/) });

      // Idempotent: the fast path (matching generation + profile + binding) inserts/closes nothing new.
      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(second).toEqual({ generation: 1, ...emptyResult, marker_written: true });

      // Simulate a rescan that changed art-1's content: close its version,
      // publish a new one, and bump the workspace's current generation --
      // mirroring `tests/lexical-maintenance.test.ts`'s identical scenario.
      await closeVersion(opened, "artv-1", 2);
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1-v2", text: "function parseAlphaContentV2() {}", validFromGeneration: 2 });
      await setCurrentGeneration(opened, workspaceId, 2);

      const third = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(third).toEqual({ generation: 2, ...emptyResult, closed: 1, inserted: 1, marker_written: true });

      const closedRows1 = await vectorRows(opened, "artv-1");
      expect(closedRows1).toHaveLength(1);
      expect(closedRows1[0]?.valid_to_generation).toBe(2);

      const row1v2 = await openVectorRow(opened, "artv-1-v2");
      expect(row1v2?.valid_from_generation).toBe(2);
      expect(await openVectorRow(opened, "artv-2")).toBeDefined();
      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 2, profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest, document_grains: ["artifact", "entity"], entity_policy_digest: expect.stringMatching(/^sha256:/) });
    });
  });

  it("closes every old-profile vector at the current generation and rebuilds under a swapped provider", async () => {
    const workspaceId = "ws-semantic-profile-swap";
    const providerA = createLocalHashProvider();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const providerB: ResolvedSemanticProvider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "swap-model", dimensions: 4, fetch_impl: fetchImpl });

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: "function parseSwapContent() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-2", artifactVersionId: "artv-2", text: "class SwapContentManager {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const initial = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider: providerA });
      expect(initial).toEqual({ generation: 1, ...emptyResult, inserted: 2, marker_written: true });

      // The swap happens at the SAME generation the provider-A rows were
      // written under -- the common real-world case (generation only moves on
      // content changes, and a provider swap changes no content). This is
      // exactly the shape that permanently failed before projection record
      // ids were scoped by vector space (see
      // `semanticVectorProjectionRecordId`'s doc comment): observed live as
      // all 975 inserts failing forever on an already-ready workspace.
      const swapped = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider: providerB });
      expect(swapped).toEqual({ generation: 1, ...emptyResult, closed: 2, inserted: 2, marker_written: true });

      const rows1 = await vectorRows(opened, "artv-1");
      expect(rows1).toHaveLength(2);
      const closedA = rows1.find((row) => row.profile_id === providerA.profile.embedding_profile_id);
      const openB = rows1.find((row) => row.profile_id === providerB.profile.embedding_profile_id);
      expect(closedA?.valid_to_generation).toBe(1);
      expect(closedA?.valid_from_generation).toBe(1);
      expect(openB?.valid_to_generation).toBeNull();
      // Back-dated to the version's own generation, exactly like a
      // never-embedded fresh insert -- the vector-space-scoped id makes the
      // old current-generation workaround unnecessary.
      expect(openB?.valid_from_generation).toBe(1);
      expect(openB?.executable_binding_id).toBe(providerB.binding.executable_binding_digest);
      expect(openB?.dimensions).toBe(4);

      const bytesB = await opened.projections.readVector(openB!.projection_record_id);
      expect(bytesB.byteLength).toBe(16);

      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 1, profile_id: providerB.profile.embedding_profile_id, executable_binding_id: providerB.binding.executable_binding_digest, document_grains: ["artifact", "entity"], entity_policy_digest: expect.stringMatching(/^sha256:/) });

      // Swap BACK to provider A, still at the same generation: the fresh
      // embed collides with provider A's own closed row (same scoped id,
      // same back-dated generation, byte-identical vector) and must REOPEN
      // it rather than fail -- the residual collision case described in the
      // insert loop's `catch`.
      const swappedBack = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider: providerA });
      expect(swappedBack).toEqual({ generation: 1, ...emptyResult, closed: 2, inserted: 2, marker_written: true });
      const rows1Back = await vectorRows(opened, "artv-1");
      expect(rows1Back).toHaveLength(2);
      const reopenedA = rows1Back.find((row) => row.profile_id === providerA.profile.embedding_profile_id);
      const closedB = rows1Back.find((row) => row.profile_id === providerB.profile.embedding_profile_id);
      expect(reopenedA?.valid_to_generation).toBeNull();
      expect(closedB?.valid_to_generation).toBe(1);
      expect(await opened.projections.semanticIndexState()).toEqual({ completed_generation: 1, profile_id: providerA.profile.embedding_profile_id, executable_binding_id: providerA.binding.executable_binding_digest, document_grains: ["artifact", "entity"], entity_policy_digest: expect.stringMatching(/^sha256:/) });
    });
  });

  it("skips a version whose declared byte length exceeds max_document_bytes without ever reading its content, skips a version whose declared encoding disagrees with its actual undecodable bytes, and skips a version whose decodable text has no embeddable token", async () => {
    const workspaceId = "ws-semantic-skips";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-big", artifactVersionId: "artv-big", text: "this text is longer than the tiny cap used below", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-empty", artifactVersionId: "artv-empty", text: "  !  ", validFromGeneration: 1 });

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
      const content: SemanticReconcilerContentReader = {
        async read(hash) {
          const bigRow = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM artifact_versions WHERE artifact_version_id = 'artv-big'");
          if (hash === bigRow?.content_hash) readCalledForBigFile = true;
          return cas.read(hash);
        },
      };

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, provider, max_document_bytes: 5 });
      expect(result.skipped_oversized).toBe(1);
      expect(result.skipped_undecodable).toBe(1);
      expect(result.skipped_empty).toBe(1);
      expect(result.inserted).toBe(0);
      expect(result.marker_written).toBe(true);
      expect(readCalledForBigFile).toBe(false);
      expect(await openVectorRow(opened, "artv-big")).toBeUndefined();
      expect(await openVectorRow(opened, "artv-corrupt")).toBeUndefined();
      expect(await openVectorRow(opened, "artv-empty")).toBeUndefined();
    });
  });

  it("retries a row whose provider call failed on a prior pass", async () => {
    const workspaceId = "ws-semantic-provider-retry";
    let calls = 0;
    // Fails the first TWO calls, not just the first one: the reconciler now
    // always tries the provider's batched `generateVectors` first (even for
    // a lone pending document, a one-element batch) and falls back to
    // `generateVector` for that same document when the batch call rejects --
    // see `embedAndCommitBatch`'s doc comment (`semantic-reconciler.ts`).
    // For THIS provider, both paths hit the same HTTP endpoint, so one
    // genuinely failing pass now costs up to two calls (the batch attempt
    // plus its per-document fallback) before `failed` is recorded, not one.
    // Failing calls 1-2 keeps this test's ORIGINAL intent intact: pass one
    // still fails outright (both its attempts fail) and pass two -- a
    // completely separate `reconcileSemanticProjection` invocation -- still
    // succeeds, exercising genuine CROSS-PASS retry rather than the
    // within-pass fallback recovery covered separately below by "falls back
    // to per-document generateVector calls when generateVectors rejects a
    // batch, isolating exactly the poison document".
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: [{ embedding: [0, 1, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "retry-model", dimensions: 4, fetch_impl: fetchImpl });

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-flaky", artifactVersionId: "artv-flaky", text: "function flakyProviderContent() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(first).toEqual({ generation: 1, ...emptyResult, failed: 1, marker_written: false });
      expect(await openVectorRow(opened, "artv-flaky")).toBeUndefined();
      // A failed pass never writes the marker, matching the "generation moved" case's reasoning.
      expect(await opened.projections.semanticIndexState()).toBeUndefined();

      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(second).toEqual({ generation: 1, ...emptyResult, inserted: 1, marker_written: true });
      expect(await openVectorRow(opened, "artv-flaky")).toBeDefined();
    });
  });

  it("does not write the completion marker when the workspace's current generation moves during the pass, but still commits whatever it found", async () => {
    const workspaceId = "ws-semantic-marker-race";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-race", artifactVersionId: "artv-race", text: "function raceConditionContent() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      let reads = 0;
      const content: SemanticReconcilerContentReader = {
        async read(hash) {
          reads += 1;
          if (reads === 1) await setCurrentGeneration(opened, workspaceId, 7);
          return cas.read(hash);
        },
      };

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, provider });
      expect(result.generation).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.marker_written).toBe(false);
      expect(await openVectorRow(opened, "artv-race")).toBeDefined();
      expect(await opened.projections.semanticIndexState()).toBeUndefined();
    });
  });

  it("stops promptly on abort mid-pass, leaving already-committed rows intact and the marker unwritten", async () => {
    const workspaceId = "ws-semantic-abort";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-abort-1", artifactVersionId: "artv-abort-1", text: "function abortContentOne() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-abort-2", artifactVersionId: "artv-abort-2", text: "function abortContentTwo() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      let reads = 0;
      const content: SemanticReconcilerContentReader = {
        async read(hash) {
          reads += 1;
          return cas.read(hash);
        },
      };
      const shouldAbort = () => reads >= 1;

      // `embed_batch_size: 1` pins this test to the PRE-batching
      // abort-checkpoint granularity: with batches of exactly one document,
      // "check between batches" (the new default) is once again "check
      // before every document's own read", exactly reproducing this test's
      // original per-document expectations. The batch-scoped abort
      // checkpoint introduced by batching -- checked once per BATCH rather
      // than once per document -- is covered separately below by "checks the
      // preemption signal between batches, not between documents within one
      // batch".
      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, provider, embed_batch_size: 1, should_abort: shouldAbort });
      expect(result.aborted).toBe(true);
      expect(result.marker_written).toBe(false);
      expect(result.inserted).toBe(1);
      // Exactly one of the two versions got embedded before the abort fired
      // on the second row's checkpoint -- both are valid artifact_ids, so
      // just assert the total committed count rather than which specific one.
      const committed = [await openVectorRow(opened, "artv-abort-1"), await openVectorRow(opened, "artv-abort-2")].filter((row) => row !== undefined);
      expect(committed).toHaveLength(1);
      expect(await opened.projections.semanticIndexState()).toBeUndefined();

      // A subsequent, unobstructed pass picks up exactly where the aborted one left off.
      const resumed = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(resumed).toEqual({ generation: 1, ...emptyResult, inserted: 1, marker_written: true });
      expect(await openVectorRow(opened, "artv-abort-1")).toBeDefined();
      expect(await openVectorRow(opened, "artv-abort-2")).toBeDefined();
    });
  });

  it("checks the preemption signal BETWEEN batches, not between documents within one batch: a full batch commits together even though the abort signal already flipped right after its own embed call", async () => {
    const workspaceId = "ws-semantic-batch-abort-boundary";
    const base = createLocalHashProvider();
    let embedCalls = 0;
    const provider: ResolvedSemanticProvider = {
      profile: base.profile,
      binding: {
        runtime_binding_id: base.binding.runtime_binding_id,
        executable_binding_digest: base.binding.executable_binding_digest,
        generateVector: base.binding.generateVector,
        generateVectors: async (inputs) => {
          embedCalls += 1;
          return Promise.all(inputs.map((input) => base.binding.generateVector(input)));
        },
      },
    };
    const shouldAbort = () => embedCalls >= 1;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-boundary-1", artifactVersionId: "artv-boundary-1", text: "function boundaryContentOne() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-boundary-2", artifactVersionId: "artv-boundary-2", text: "function boundaryContentTwo() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-boundary-3", artifactVersionId: "artv-boundary-3", text: "function boundaryContentThree() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, embed_batch_size: 2, should_abort: shouldAbort });
      expect(result.aborted).toBe(true);
      expect(result.marker_written).toBe(false);
      // The FIRST batch (2 of the 3 documents) had already been dispatched
      // to generateVectors -- and both its writes committed -- by the time
      // the abort signal flips; only the 3rd document's own trailing batch
      // ever observes it.
      expect(embedCalls).toBe(1);
      expect(result.inserted).toBe(2);
      expect(await openVectorRow(opened, "artv-boundary-1")).toBeDefined();
      expect(await openVectorRow(opened, "artv-boundary-2")).toBeDefined();
      expect(await openVectorRow(opened, "artv-boundary-3")).toBeUndefined();
    });
  });

  it("embeds every pending document in ONE generateVectors call when the binding implements it, never falling back to per-document generateVector calls", async () => {
    const workspaceId = "ws-semantic-batch-happy-path";
    const base = createLocalHashProvider();
    let generateVectorCalls = 0;
    let generateVectorsCalls = 0;
    const provider: ResolvedSemanticProvider = {
      profile: base.profile,
      binding: {
        runtime_binding_id: base.binding.runtime_binding_id,
        executable_binding_digest: base.binding.executable_binding_digest,
        generateVector: async (input) => { generateVectorCalls += 1; return base.binding.generateVector(input); },
        generateVectors: async (inputs) => { generateVectorsCalls += 1; return Promise.all(inputs.map((input) => base.binding.generateVector(input))); },
      },
    };

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-happy-1", artifactVersionId: "artv-happy-1", text: "function happyContentOne() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-happy-2", artifactVersionId: "artv-happy-2", text: "function happyContentTwo() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-happy-3", artifactVersionId: "artv-happy-3", text: "function happyContentThree() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result).toEqual({ generation: 1, ...emptyResult, inserted: 3, marker_written: true });
      expect(generateVectorsCalls).toBe(1);
      expect(generateVectorCalls).toBe(0);
    });
  });

  it("falls back to per-document generateVector calls when generateVectors rejects a batch, isolating exactly the poison document: the other documents in the same batch still succeed, and the poison one is recorded failed and retried next pass", async () => {
    const workspaceId = "ws-semantic-batch-poison";
    const base = createLocalHashProvider();
    const poisonText = "function poisonDocumentContent() {}";
    let generateVectorCalls = 0;
    let generateVectorsCalls = 0;
    let poisonFixed = false;
    const provider: ResolvedSemanticProvider = {
      profile: base.profile,
      binding: {
        runtime_binding_id: base.binding.runtime_binding_id,
        executable_binding_digest: base.binding.executable_binding_digest,
        generateVector: async (input) => {
          generateVectorCalls += 1;
          if (input.text === poisonText && !poisonFixed) throw new Error("poison document rejected by the provider");
          return base.binding.generateVector(input);
        },
        generateVectors: async (inputs) => {
          generateVectorsCalls += 1;
          // Simulates a batch endpoint that rejects the WHOLE request
          // whenever any single input in it is malformed/poison -- exactly
          // the real-world shape the spec's per-document fallback exists to
          // isolate.
          if (inputs.some((input) => input.text === poisonText) && !poisonFixed) throw new Error("batch embedding request rejected");
          return Promise.all(inputs.map((input) => base.binding.generateVector(input)));
        },
      },
    };

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-good-1", artifactVersionId: "artv-good-1", text: "function goodContentOne() {}", validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-poison", artifactVersionId: "artv-poison", text: poisonText, validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-good-2", artifactVersionId: "artv-good-2", text: "function goodContentTwo() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider, embed_batch_size: 3 });
      expect(generateVectorsCalls).toBe(1);
      // Fallback isolation: exactly 3 per-document generateVector calls for
      // the one rejected batch -- not just 1 for the poison document alone.
      expect(generateVectorCalls).toBe(3);
      expect(first).toEqual({ generation: 1, ...emptyResult, inserted: 2, failed: 1, marker_written: false });
      expect(await openVectorRow(opened, "artv-good-1")).toBeDefined();
      expect(await openVectorRow(opened, "artv-good-2")).toBeDefined();
      expect(await openVectorRow(opened, "artv-poison")).toBeUndefined();
      // A failed pass never writes the marker -- same reasoning as the
      // existing HTTP-provider retry test above.
      expect(await opened.projections.semanticIndexState()).toBeUndefined();

      // Fix the poison document (simulating the underlying condition
      // clearing) and rerun: it is retried and now succeeds, and ONLY now
      // does the pass write the completion marker.
      poisonFixed = true;
      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider, embed_batch_size: 3 });
      expect(second).toEqual({ generation: 1, ...emptyResult, inserted: 1, marker_written: true });
      expect(await openVectorRow(opened, "artv-poison")).toBeDefined();
    });
  });

  it("produces byte-identical persisted vectors, digests, and rows for a single-call batched embed vs a fully sequential (no generateVectors) run, for the deterministic hash provider", async () => {
    const docs = [
      { artifactId: "art-batch-1", artifactVersionId: "artv-batch-1", text: "function parseBatchAlphaContent() {}" },
      { artifactId: "art-batch-2", artifactVersionId: "artv-batch-2", text: "class BatchBetaContentManager {}" },
      { artifactId: "art-batch-3", artifactVersionId: "artv-batch-3", text: "function computeBatchGammaTotal() {}" },
    ];
    const base = createLocalHashProvider();
    // No `generateVectors` at all -- forces the reconciler onto its
    // per-document `generateVector` fallback path regardless of batch size,
    // which is the "fully sequential" baseline this test compares against.
    const sequentialOnlyProvider: ResolvedSemanticProvider = {
      profile: base.profile,
      binding: { runtime_binding_id: base.binding.runtime_binding_id, executable_binding_digest: base.binding.executable_binding_digest, generateVector: base.binding.generateVector },
    };

    async function runAndCollect(workspaceId: string, provider: ResolvedSemanticProvider): Promise<Map<string, { readonly vector: Uint8Array; readonly digest: string }>> {
      const collected = new Map<string, { readonly vector: Uint8Array; readonly digest: string }>();
      await withWorkspace(workspaceId, async (opened, cas) => {
        for (const doc of docs) await seedTextVersion(opened, cas, workspaceId, { artifactId: doc.artifactId, artifactVersionId: doc.artifactVersionId, text: doc.text, validFromGeneration: 1 });
        await setCurrentGeneration(opened, workspaceId, 1);
        const engineDatabase = asEngineWorkspaceDatabase(opened);
        const result = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
        expect(result.inserted).toBe(docs.length);
        expect(result.marker_written).toBe(true);
        for (const doc of docs) {
          const row = await openVectorRow(opened, doc.artifactVersionId);
          const digestRow = await opened.database.get<{ vector_digest: string }>(
            "SELECT vector_digest FROM vector_projection_rows WHERE projection_record_id = ? AND valid_from_generation = ?",
            [row!.projection_record_id, row!.valid_from_generation],
          );
          const vector = await opened.projections.readVector(row!.projection_record_id);
          collected.set(doc.artifactId, { vector, digest: digestRow!.vector_digest });
        }
      });
      return collected;
    }

    // `base` (createLocalHashProvider()'s own instance, generateVectors
    // included) embeds all 3 docs in ONE `generateVectors` call, since the
    // default batch size (16) comfortably covers them.
    const batchedResults = await runAndCollect("ws-semantic-batch-vs-sequential-batched", base);
    const sequentialResults = await runAndCollect("ws-semantic-batch-vs-sequential-sequential", sequentialOnlyProvider);

    for (const doc of docs) {
      const sequential = sequentialResults.get(doc.artifactId)!;
      const batched = batchedResults.get(doc.artifactId)!;
      expect([...batched.vector]).toEqual([...sequential.vector]);
      expect(batched.digest).toBe(sequential.digest);
    }
  });

  it("is a no-op returning generation 0 for a workspace that has never published", async () => {
    const workspaceId = "ws-semantic-unpublished";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result).toEqual({ generation: 0, ...emptyResult, marker_written: false });
    });
  });
});

// Decision 17: entity-grain semantic documents. `reconcileSemanticProjection`
// grows a SECOND pass alongside the artifact pass above -- these tests cover
// eligibility, identity survival across a reused record, marker backfill for
// a pre-existing artifact-only marker, and abort mid-entity-pass.
describe("reconcileSemanticProjection entity pass (decision 17)", () => {
  it("embeds exactly the eligible entity records (top-level 120+ char function) and skips every ineligible one (short top-level const, indented method, parameter, whole-file module), writing grain/document_ref correctly", async () => {
    const workspaceId = "ws-semantic-entity-eligibility";
    const provider = createLocalHashProvider();
    const func = `export function sumManyValuesForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    const shortConst = "const short = 1;";
    // Indented (not top-level) AND padded well past 120 chars, so its
    // rejection is unambiguously due to POSITION, not span length --
    // isolating that reason from `shortConst`'s (span-only) rejection.
    const methodSource = `render(param) {\n    // ${ENTITY_SPAN_PADDING}\n    return param;\n  }`;
    const classDecl = `class Widget {\n  ${methodSource}\n}`;
    const text = [func, shortConst, classDecl].join("\n\n");
    const funcStart = text.indexOf(func);
    const constStart = text.indexOf(shortConst);
    const methodStart = text.indexOf(methodSource);
    const paramStart = text.indexOf("param", methodStart);

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-func", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "sumManyValuesForTestCoverage", kind: "function", language: "typescript", path: "art-1", start: funcStart, end: funcStart + func.length } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-const", recordKind: "jsts:entity_variable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "short", kind: "variable", language: "typescript", path: "art-1", start: constStart, end: constStart + shortConst.length } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-method", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "render", kind: "method", language: "typescript", path: "art-1", start: methodStart, end: methodStart + methodSource.length, qualified_name: "Widget.render" } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-param", recordKind: "jsts:entity_parameter", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "param", kind: "parameter", language: "typescript", path: "art-1", start: paramStart, end: paramStart + "param".length } });
      // Whole-file/module: record KIND is `jsts:entity_container`, which the
      // reconciler's own missing-entity SQL excludes entirely (never even
      // reaches the JS eligibility check) -- so it contributes to neither
      // `entity_inserted` nor `entity_skipped_ineligible` below.
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-module", recordKind: "jsts:entity_container", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "art-1", kind: "module", language: "typescript", path: "art-1", start: 0, end: text.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const result = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(result.entity_inserted).toBe(1);
      expect(result.entity_skipped_ineligible).toBe(3);
      expect(result.entity_failed).toBe(0);
      expect(result.marker_written).toBe(true);

      const entityRows = await opened.database.all<{ document_ref: string | null; valid_to_generation: number | null }>(
        "SELECT document_ref, valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity'", [workspaceId],
      );
      expect(entityRows).toHaveLength(1);
      expect(entityRows[0]?.document_ref).toBe("rec-func");
      expect(entityRows[0]?.valid_to_generation).toBeNull();

      // Every OTHER open vector row in the workspace is artifact-grain
      // (`document_grain IS NULL`) -- the one file's own artifact document.
      const artifactRows = await opened.database.all<{ document_grain: string | null }>(
        "SELECT document_grain FROM vector_projection_rows WHERE workspace_id = ? AND valid_to_generation IS NULL AND (document_grain IS NULL OR document_grain <> 'entity')", [workspaceId],
      );
      expect(artifactRows).toHaveLength(1);
    });
  });

  it("keeps an unchanged entity record's vector across a file edit that closes its owning artifact version, while closing and re-embedding the record that actually changed", async () => {
    const workspaceId = "ws-semantic-entity-reuse";
    const provider = createLocalHashProvider();
    const funcA = `export function alphaKeepFunctionForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    const funcBv1 = `export function betaChangeFunctionForTestCoverageOriginal() {\n  // ${ENTITY_SPAN_PADDING}\n  return 2;\n}`;
    const textV1 = [funcA, funcBv1].join("\n\n");
    const funcAStart = textV1.indexOf(funcA);
    const funcBv1Start = textV1.indexOf(funcBv1);

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: textV1, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-a", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "alphaKeepFunctionForTestCoverage", kind: "function", language: "typescript", path: "art-1", start: funcAStart, end: funcAStart + funcA.length } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-b", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "betaChangeFunctionForTestCoverageOriginal", kind: "function", language: "typescript", path: "art-1", start: funcBv1Start, end: funcBv1Start + funcBv1.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(first.entity_inserted).toBe(2);

      const recAVectorBefore = await opened.database.get<{ projection_record_id: string }>("SELECT projection_record_id FROM vector_projection_rows WHERE workspace_id = ? AND document_ref = 'rec-a' AND valid_to_generation IS NULL", [workspaceId]);
      expect(recAVectorBefore).toBeDefined();

      // Edit: close artv-1, publish artv-1-v2 with func B's text changed.
      // rec-a is REUSED -- same record_id, STILL pointing at the OLD owner
      // artv-1 (decision 17's "an unchanged record legitimately outlives its
      // original owner artifact version" -- `candidate-materialization.ts`
      // never re-points a reused record's owner columns). rec-b is closed
      // and replaced by rec-b-v2, owned by the new version.
      const funcBv2 = `export function betaChangeFunctionForTestCoverageEdited() {\n  // ${ENTITY_SPAN_PADDING}\n  return 3;\n}`;
      const textV2 = [funcA, funcBv2].join("\n\n");
      const funcBv2Start = textV2.indexOf(funcBv2);
      await closeVersion(opened, "artv-1", 2);
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1-v2", text: textV2, validFromGeneration: 2 });
      await closeEntityRecord(opened, "rec-b", 2);
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-b-v2", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1-v2", validFromGeneration: 2, body: { name: "betaChangeFunctionForTestCoverageEdited", kind: "function", language: "typescript", path: "art-1", start: funcBv2Start, end: funcBv2Start + funcBv2.length } });
      await setCurrentGeneration(opened, workspaceId, 2);

      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(second.entity_closed).toBe(1);
      expect(second.entity_inserted).toBe(1);

      // rec-a's vector survives byte-identical and OPEN -- no close, no
      // re-embed -- even though its owner artifact version (artv-1) just
      // closed. This is exactly the correctness property step 2's
      // `document_grain IS NULL` restriction protects: without it, step 2's
      // artifact_versions join would have closed this row too.
      const recAVectorAfter = await opened.database.get<{ projection_record_id: string; valid_to_generation: number | null }>("SELECT projection_record_id, valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND document_ref = 'rec-a'", [workspaceId]);
      expect(recAVectorAfter?.projection_record_id).toBe(recAVectorBefore?.projection_record_id);
      expect(recAVectorAfter?.valid_to_generation).toBeNull();

      const recBClosed = await opened.database.get<{ valid_to_generation: number | null }>("SELECT valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND document_ref = 'rec-b'", [workspaceId]);
      expect(recBClosed?.valid_to_generation).toBe(2);

      const recBv2Open = await opened.database.get<{ valid_to_generation: number | null }>("SELECT valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND document_ref = 'rec-b-v2'", [workspaceId]);
      expect(recBv2Open?.valid_to_generation).toBeNull();
    });
  });

  it("a pre-existing artifact-only marker triggers the entity backfill without touching (closing or re-embedding) already-covered artifact vectors", async () => {
    const workspaceId = "ws-semantic-entity-marker-backfill";
    const provider = createLocalHashProvider();
    const func = `export function backfillTargetFunctionForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: func, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-backfill", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "backfillTargetFunctionForTestCoverage", kind: "function", language: "typescript", path: "art-1", start: 0, end: func.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      // Simulate a pre-decision-17 daemon: the artifact document is already
      // embedded (via `putVectors` directly, bypassing the reconciler) and
      // its completion marker was written WITHOUT `document_grains` --
      // exactly what `markSemanticComplete` produces when that argument is
      // omitted (see that method's own doc comment).
      const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: func });
      await opened.projections.putVectors([{
        projection_record_id: "semantic-document:artv-1-pre-existing", owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1",
        profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest,
        dimensions: provider.profile.dimensions, element_type: provider.profile.element_type, vector: generated.vector,
        vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le", normalization: provider.profile.normalization as "none" | "l2",
        distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine", valid_from_generation: 1,
      }]);
      await opened.projections.markSemanticComplete({ completed_generation: 1, profile_id: provider.profile.embedding_profile_id, executable_binding_id: provider.binding.executable_binding_digest });
      expect((await opened.projections.semanticIndexState())?.document_grains).toBeUndefined();

      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const result = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      // Artifact side: nothing to do -- the pre-existing vector already
      // covers the only visible artifact version, so no close and no insert.
      expect(result.closed).toBe(0);
      expect(result.inserted).toBe(0);
      // Entity side: the backfill actually runs.
      expect(result.entity_inserted).toBe(1);
      expect(result.marker_written).toBe(true);

      const preExistingStillOpen = await opened.database.get<{ valid_to_generation: number | null }>("SELECT valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = 'semantic-document:artv-1-pre-existing'", [workspaceId]);
      expect(preExistingStillOpen?.valid_to_generation).toBeNull();

      expect((await opened.projections.semanticIndexState())?.document_grains).toEqual(["artifact", "entity"]);
    });
  });

  it("stops promptly on abort mid-entity-pass (after the artifact pass has already run to completion), leaving already-committed entity rows intact and the marker unwritten, and resumes cleanly on the next pass", async () => {
    const workspaceId = "ws-semantic-entity-abort";
    const provider = createLocalHashProvider();
    const funcOne = `export function abortEntityContentOneForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    const funcTwo = `export function abortEntityContentTwoForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 2;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-abort-1", artifactVersionId: "artv-abort-1", text: funcOne, validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-abort-2", artifactVersionId: "artv-abort-2", text: funcTwo, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-abort-1", recordKind: "jsts:entity_callable", ownerArtifactId: "art-abort-1", ownerArtifactVersionId: "artv-abort-1", validFromGeneration: 1, body: { name: "abortEntityContentOneForTestCoverage", kind: "function", language: "typescript", path: "art-abort-1", start: 0, end: funcOne.length } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-abort-2", recordKind: "jsts:entity_callable", ownerArtifactId: "art-abort-2", ownerArtifactVersionId: "artv-abort-2", validFromGeneration: 1, body: { name: "abortEntityContentTwoForTestCoverage", kind: "function", language: "typescript", path: "art-abort-2", start: 0, end: funcTwo.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      let reads = 0;
      const content: SemanticReconcilerContentReader = { async read(hash) { reads += 1; return cas.read(hash); } };
      // `embed_batch_size: 1` pins this to per-document abort-checkpoint
      // granularity (see the existing artifact-pass abort test's identical
      // reasoning). The artifact pass reads exactly 2 files (reads 1-2); the
      // entity pass's OWN, separate file reads start at read 3 -- aborting
      // once `reads` reaches 3 fires the checkpoint AFTER the first entity
      // candidate has already been read and committed, but BEFORE the
      // second one's own read, so the abort is unambiguously mid-ENTITY-pass,
      // never mid-artifact-pass.
      const shouldAbort = () => reads >= 3;

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, provider, embed_batch_size: 1, should_abort: shouldAbort });
      expect(result.aborted).toBe(true);
      expect(result.marker_written).toBe(false);
      expect(result.inserted).toBe(2); // artifact pass ran to completion first
      expect(result.entity_inserted).toBe(1);

      const committedEntityVectors = await opened.database.all<{ document_ref: string | null }>("SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId]);
      expect(committedEntityVectors).toHaveLength(1);

      // A subsequent, unobstructed pass picks up exactly where the aborted one left off.
      const resumed = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(resumed.entity_inserted).toBe(1);
      expect(resumed.marker_written).toBe(true);
      const allEntityVectors = await opened.database.all<{ document_ref: string | null }>("SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId]);
      expect(allEntityVectors.map((row) => row.document_ref).sort()).toEqual(["rec-abort-1", "rec-abort-2"]);
    });
  });
});

describe("decision 17 eligibility: top-level variables (line-based column-0 test)", () => {
  // Regression for the predicate that silently rejected 2,008 of the doc's
  // 2,544 measured eligible docs: a top-level `export const x = ...` entity's
  // `start` points at the VariableDeclaration node (`x`), AFTER the
  // `export const ` keywords -- so a "declaration starts at column 0" test
  // fails it even though its LINE is unindented. Eligibility must test the
  // LINE's leading character, exactly like the measurement bench did.
  it("embeds a 120+ char top-level const whose entity start sits after the declaration keywords, and still rejects an indented one", async () => {
    const workspaceId = "ws-semantic-entity-variable";
    const provider = createLocalHashProvider();
    const topLevelInitializer = `{ value: "${ENTITY_SPAN_PADDING}" }`;
    const topLevelDeclaration = `bigLookupTable = ${topLevelInitializer};`;
    const indentedDeclaration = `nestedLookupTable = ${topLevelInitializer};`;
    const text = `export const ${topLevelDeclaration}\nfunction wrap() {\n  const ${indentedDeclaration}\n  return nestedLookupTable;\n}\n`;
    const topStart = text.indexOf("bigLookupTable");
    const topEnd = topStart + topLevelDeclaration.length - 1;
    const nestedStart = text.indexOf("nestedLookupTable =");
    const nestedEnd = nestedStart + indentedDeclaration.length - 1;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-top-const", recordKind: "jsts:entity_variable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "bigLookupTable", kind: "variable", language: "typescript", path: "art-1", start: topStart, end: topEnd } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-nested-const", recordKind: "jsts:entity_variable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "nestedLookupTable", kind: "variable", language: "typescript", path: "art-1", start: nestedStart, end: nestedEnd } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result.entity_inserted).toBe(1);
      expect(result.entity_skipped_ineligible).toBe(1);
      const entityRows = await opened.database.all<{ document_ref: string | null }>(
        "SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId],
      );
      expect(entityRows.map((row) => row.document_ref)).toEqual(["rec-top-const"]);
    });
  });
});

describe("decision 17 schema migration (pre-migration database open)", () => {
  it("opens a database created before document_grain/document_ref/document_grains existed, adding them via ensureWorkspaceSchemaCompatibility rather than failing initializeSchema", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-semantic-migration-"));
    const storage = await createDurableStorage({ rootDir: root });
    try {
      await storage.catalog.registerWorkspace(workspaceRegistration("workspace-migration"));
      const opened = await storage.openWorkspace("workspace-migration");
      // Simulate a database created before decision 17 shipped: drop the
      // discriminator index FIRST (it references the columns), then the
      // columns themselves. This is exactly the state a real pre-17 database
      // is in on its first open after this change -- and the reason the
      // index must NOT live inline in WORKSPACE_SCHEMA: `initializeSchema`
      // replays that raw schema string on every open, before
      // `ensureWorkspaceSchemaCompatibility` has added the columns, so an
      // inline index referencing them would fail the open outright
      // (observed live against a real bench workspace).
      await opened.database.exec("DROP INDEX IF EXISTS vector_projection_document_ref_idx");
      await opened.database.exec("ALTER TABLE vector_projection_rows DROP COLUMN document_grain");
      await opened.database.exec("ALTER TABLE vector_projection_rows DROP COLUMN document_ref");
      await opened.database.exec("ALTER TABLE semantic_index_state DROP COLUMN document_grains");
      await opened.close();

      // Reopening replays initializeSchema (must not touch the missing
      // columns) and then ensureWorkspaceSchemaCompatibility (adds them and
      // recreates the index). Idempotent: a second reopen finds everything
      // present.
      const reopened = await storage.openWorkspace("workspace-migration");
      const vectorColumns = await reopened.database.all<{ name: string }>("PRAGMA table_info(vector_projection_rows)");
      expect(vectorColumns.some((column) => column.name === "document_grain")).toBe(true);
      expect(vectorColumns.some((column) => column.name === "document_ref")).toBe(true);
      const markerColumns = await reopened.database.all<{ name: string }>("PRAGMA table_info(semantic_index_state)");
      expect(markerColumns.some((column) => column.name === "document_grains")).toBe(true);
      const indexes = await reopened.database.all<{ name: string }>("PRAGMA index_list(vector_projection_rows)");
      expect(indexes.some((index) => index.name === "vector_projection_document_ref_idx")).toBe(true);
      await reopened.close();
      const reopenedAgain = await storage.openWorkspace("workspace-migration");
      await reopenedAgain.close();
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("decision 17 entity-eligibility policy digest (marker-level backfill trigger)", () => {
  it("re-runs the entity pass when a grain-complete marker was written under a different eligibility policy, without disturbing artifact vectors", async () => {
    const workspaceId = "ws-semantic-policy-digest";
    const provider = createLocalHashProvider();
    const declaration = `bigLookupTable = { value: "${ENTITY_SPAN_PADDING}" };`;
    const text = `export const ${declaration}\n`;
    const start = text.indexOf("bigLookupTable");
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-const", recordKind: "jsts:entity_variable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "bigLookupTable", kind: "variable", language: "typescript", path: "art-1", start, end: start + declaration.length - 1 } });
      await setCurrentGeneration(opened, workspaceId, 1);
      const engineDatabase = asEngineWorkspaceDatabase(opened);

      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(first.entity_inserted).toBe(1);
      expect(first.marker_written).toBe(true);

      // Same generation, same provider, same policy: the fast path holds.
      const fastPath = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(fastPath).toEqual({ ...first, closed: 0, inserted: 0, entity_inserted: 0 });

      // Simulate a marker written under an OLDER policy (e.g. the pre-fix
      // declaration-position predicate): grains still say complete, but the
      // stored policy digest differs -- exactly what a real workspace looks
      // like after a predicate revision ships. The fast path must fall
      // through and the entity pass must re-evaluate eligibility; the
      // already-correct vector row simply survives (nothing to close, its
      // document is already present), and artifact vectors are untouched.
      await opened.database.run("UPDATE semantic_index_state SET entity_policy_digest = 'sha256:old-policy' WHERE workspace_id = ?", [workspaceId]);
      const backfill = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(backfill.marker_written).toBe(true);
      expect(backfill.closed).toBe(0);
      const marker = await opened.projections.semanticIndexState();
      expect(marker?.entity_policy_digest).toMatch(/^sha256:/);
      expect(marker?.entity_policy_digest).not.toBe("sha256:old-policy");
    });
  });
});
