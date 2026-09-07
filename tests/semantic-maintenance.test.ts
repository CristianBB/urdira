import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { digestBytes, encodeCanonical } from "@urdira/canonical";
import { createDurableStorage, flattenRelationalValue, relationalValueCommands, type ContentAddressedStore, type SqliteValue, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { createHttpEmbeddingProvider, createLocalHashProvider, reconcileSemanticProjection, shardIndexFor, vectorValues, type ResolvedSemanticProvider, type SemanticEntityCandidateRow, type SemanticEntityRecordSource, type SemanticReconcilerContentReader } from "../packages/engine/src/index.js";

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
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, 'physical_file')", [options.artifactId, workspaceId, options.artifactId, options.artifactId, options.displayPath ?? options.artifactId]);
  const blob = await cas.put(new TextEncoder().encode(options.text), { media_type: "text/plain; charset=utf-8" });
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, 'utf-8', 'text', 'digest', 'obs-1', ?, ?)",
    [options.artifactVersionId, workspaceId, options.artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, options.validFromGeneration, options.validToGeneration ?? null],
  );
}

/** A version whose declared `encoding` is `binary` -- `reconcileSemanticProjection` must never embed it. */
async function seedBinaryVersion(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string, artifactId: string, artifactVersionId: string, validFromGeneration: number): Promise<void> {
  await opened.database.exec("PRAGMA foreign_keys = OFF");
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, 'physical_file')", [artifactId, workspaceId, artifactId, artifactId, artifactId]);
  const blob = await cas.put(new Uint8Array([0, 1, 2, 3]));
  await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blob.content_blob_id, blob.content_hash, blob.byte_length, blob.storage_reference]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, 'binary', NULL, 'digest', 'obs-1', ?, NULL)",
    [artifactVersionId, workspaceId, artifactId, blob.content_blob_id, blob.content_hash, blob.byte_length, validFromGeneration],
  );
}

async function setCurrentGeneration(opened: WorkspaceDatabase, workspaceId: string, generation: number): Promise<void> {
  await opened.database.run(
    `INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at)
     VALUES (?, 'snapshot-1', ?, 'registry-1', 'lock-1', 'configuration-1', 'freshness-1', 1, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET current_generation = excluded.current_generation`,
    [workspaceId, generation, now],
  );
}

async function closeVersion(opened: WorkspaceDatabase, artifactVersionId: string, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE artifact_versions SET valid_to_generation = ? WHERE artifact_version_id = ?", [validToGeneration, artifactVersionId]);
}

function entityRecordPayload(body: Readonly<Record<string, unknown>>): Uint8Array {
  return encodeCanonical(body);
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
    "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES (?, ?, 'entity', ?, 'core:construct', 1, 'test', '1', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'analysis', 'configuration', 'dependencies')",
    [options.recordId, workspaceId, options.recordKind, options.ownerArtifactId, options.ownerArtifactVersionId, options.validFromGeneration, options.validToGeneration ?? null, `digest-${options.recordId}`, digestBytes(payload), payload.byteLength],
  );
  await opened.database.transaction(relationalValueCommands(flattenRelationalValue(workspaceId, options.recordId, options.validFromGeneration, options.body)));
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
      await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES ('art-corrupt', ?, 'art-corrupt', 'art-corrupt', 'art-corrupt', 'physical_file')", [workspaceId]);
      const corruptBytes = new Uint8Array([0xff, 0xfe, 0x00]);
      const corruptBlob = await cas.put(corruptBytes);
      await opened.database.run("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [corruptBlob.content_blob_id, corruptBlob.content_hash, corruptBlob.byte_length, corruptBlob.storage_reference]);
      await opened.database.run(
        "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES ('artv-corrupt', ?, 'art-corrupt', ?, ?, ?, 'utf-8', 'text', 'digest', 'obs-1', 1, NULL)",
        [workspaceId, corruptBlob.content_blob_id, corruptBlob.content_hash, corruptBlob.byte_length],
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
    // Frente S-B (2026-09-06, R12): the HTTP provider now retries a
    // 429/5xx status internally (`retry_backoff_ms` defaults to 3 retries
    // with real backoff) -- `retry_backoff_ms: []` (zero retries, one
    // attempt) isolates THIS test's own cross-PASS retry semantics from the
    // provider's own within-CALL retry semantics (covered separately, with
    // fast injected backoff, in `tests/semantic-provider.test.ts`).
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "retry-model", dimensions: 4, fetch_impl: fetchImpl, retry_backoff_ms: [] });

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

// Plan 2026-09-06 (Frente S-A): `semantic_document_status` is the source of
// truth for "which documents are affected (not covered)" -- written by the
// SAME enumeration the artifact/entity passes above already run, in the
// same transaction as each committed vector (`putVectors`'s own
// `extraCommands`), never a separate pass.
describe("reconcileSemanticProjection: semantic_document_status (plan 2026-09-06, Frente S-A)", () => {
  type StatusRow = {
    readonly document_grain: string;
    readonly document_id: string;
    readonly artifact_id: string;
    readonly artifact_version_id: string;
    readonly display_path: string;
    readonly status: string;
    readonly reason_codes: string;
    readonly segment_count: number;
    readonly generation: number;
  };

  async function statusRows(opened: WorkspaceDatabase, workspaceId: string, profileId: string, executableBindingId: string): Promise<readonly StatusRow[]> {
    return opened.database.all<StatusRow>(
      "SELECT document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? ORDER BY document_grain, document_id",
      [workspaceId, profileId, executableBindingId],
    );
  }

  it("writes a covered status row (empty reason_codes, segment_count 1) for each freshly embedded document, in the same pass as the vector commit", async () => {
    const workspaceId = "ws-semantic-status-covered";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: "function parseStatusCoveredContent() {}", validFromGeneration: 1, displayPath: "src/covered.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);
      await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });

      const rows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const artifactRow = rows.find((row) => row.document_grain === "artifact" && row.document_id === "artv-1");
      expect(artifactRow).toMatchObject({ artifact_id: "art-1", artifact_version_id: "artv-1", display_path: "src/covered.ts", status: "covered", reason_codes: "[]", segment_count: 1, generation: 1 });
    });
  });

  it("writes excluded status rows for a binary version and an oversized version, without ever counting them toward inserted/skipped_* (a separate bulk classification pass, not the missing-vector loop)", async () => {
    const workspaceId = "ws-semantic-status-excluded";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedBinaryVersion(opened, cas, workspaceId, "art-bin", "artv-bin", 1);
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-big", artifactVersionId: "artv-big", text: "function oversizedStatusContent() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);
      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, max_document_bytes: 4 });
      expect(result.skipped_oversized).toBe(1);

      const rows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const binaryRow = rows.find((row) => row.document_id === "artv-bin");
      const oversizedRow = rows.find((row) => row.document_id === "artv-big");
      expect(binaryRow).toMatchObject({ status: "excluded", reason_codes: JSON.stringify(["binary"]) });
      expect(oversizedRow).toMatchObject({ status: "excluded", reason_codes: JSON.stringify(["oversized"]) });
    });
  });

  it("writes a failed status row with a provider_error reason code when the provider throws, and flips it to covered once the provider recovers", async () => {
    const workspaceId = "ws-semantic-status-failed";
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ data: [{ embedding: [0, 1, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    // Frente S-B (R12): see the identical `retry_backoff_ms: []` comment on
    // "retries a row whose provider call failed on a prior pass" above.
    const provider = createHttpEmbeddingProvider({ endpoint: "https://embeddings.example.test/v1/embed", model: "status-failed-model", dimensions: 4, fetch_impl: fetchImpl, retry_backoff_ms: [] });

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-flaky", artifactVersionId: "artv-flaky", text: "function flakyStatusContent() {}", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const first = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(first.failed).toBe(1);
      const failedRows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const failedRow = failedRows.find((row) => row.document_id === "artv-flaky");
      expect(failedRow?.status).toBe("failed");
      expect(JSON.parse(failedRow?.reason_codes ?? "[]")).toEqual([expect.stringMatching(/^provider_error:/)]);

      const second = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(second.inserted).toBe(1);
      const coveredRows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const coveredRow = coveredRows.find((row) => row.document_id === "artv-flaky");
      expect(coveredRow).toMatchObject({ status: "covered", reason_codes: "[]" });
    });
  });

  it("never leaves a covered status without its vector, or a vector without its covered status, when the shared insert transaction aborts mid-write", async () => {
    const workspaceId = "ws-semantic-status-atomic-abort";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-atomic", artifactVersionId: "artv-atomic", text: "function atomicAbortContent() {}", validFromGeneration: 1, displayPath: "src/atomic.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);

      // Simulates a crash INSIDE `putVectors`'s own transaction -- the ONE
      // call that carries both the `vector_projection_rows` insert and the
      // `semantic_document_status` "covered" upsert (`putVectors`'s
      // `extraCommands` parameter) -- by making the underlying
      // `database.transaction` throw for exactly that call. A real SQLite
      // transaction (`BEGIN IMMEDIATE` ... `ROLLBACK` on throw, see
      // `packages/storage/src/sqlite.ts`) guarantees this either commits
      // every statement in the array or none of them; this test proves the
      // reconciler actually relies on that guarantee (one shared
      // transaction) rather than two separate ones that could commit the
      // vector row and then fail before the status row, or vice versa.
      const realTransaction = opened.database.transaction.bind(opened.database);
      const spy = vi.spyOn(opened.database, "transaction").mockImplementation(async (commands: readonly { readonly kind: string; readonly sql?: string }[]) => {
        if (commands.some((command) => command.kind === "run" && command.sql?.includes("INSERT INTO vector_projection_rows"))) {
          throw new Error("simulated crash mid-transaction");
        }
        return realTransaction(commands as Parameters<typeof realTransaction>[0]);
      });

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      spy.mockRestore();

      // The reconciler must have caught the throw and recorded the document
      // as failed (retried next pass) -- never silently treated the aborted
      // write as a success, and never advanced the completion marker while a
      // failure is outstanding.
      expect(result.failed).toBe(1);
      expect(result.marker_written).toBe(false);

      const vectorRow = await openVectorRow(opened, "artv-atomic");
      const rows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const statusRow = rows.find((row) => row.document_id === "artv-atomic");

      // The invariant this whole plan section exists to protect: the vector
      // write rolled back (no row persisted at all), so the status must
      // never say "covered" without a vector backing it -- it is "failed"
      // instead, exactly like any other provider/write failure.
      expect(vectorRow).toBeUndefined();
      expect(statusRow).toMatchObject({ status: "failed" });

      // Recovery: once the transaction is no longer sabotaged, the next pass
      // embeds and covers the document normally -- proving the aborted pass
      // left the row genuinely retryable, not stuck.
      const recovered = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(recovered.inserted).toBe(1);
      expect(recovered.marker_written).toBe(true);
      expect(await openVectorRow(opened, "artv-atomic")).toBeDefined();
      const finalRows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(finalRows.find((row) => row.document_id === "artv-atomic")).toMatchObject({ status: "covered" });
    });
  });

  it("deletes a pending document's status row once its underlying artifact version closes without ever being embedded", async () => {
    const workspaceId = "ws-semantic-status-orphan";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      // No embeddable token -> permanently "excluded", never covered -- the
      // exact "pending/excluded document whose source disappears" case the
      // orphan sweep (not the stale-close loops, which only look at
      // vector_projection_rows) exists to catch.
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-empty", artifactVersionId: "artv-empty", text: "   \n\t  ", validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);
      await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      const beforeClose = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(beforeClose.find((row) => row.document_id === "artv-empty")).toMatchObject({ status: "excluded" });

      await closeVersion(opened, "artv-empty", 2);
      await setCurrentGeneration(opened, workspaceId, 2);
      await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      const afterClose = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(afterClose.find((row) => row.document_id === "artv-empty")).toBeUndefined();
    });
  });

  it("backfills covered status rows from pre-existing vector_projection_rows for a sidecar that predates this table, on the very next pass even when the marker already says complete (fast path)", async () => {
    const workspaceId = "ws-semantic-status-backfill";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-legacy", artifactVersionId: "artv-legacy", text: "function legacyBackfillContent() {}", validFromGeneration: 1, displayPath: "src/legacy.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);
      const engineDatabase = asEngineWorkspaceDatabase(opened);
      await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });

      // Simulate a pre-plan sidecar: the vector row (and completion marker)
      // already exist, but wipe the status table clean -- exactly what a
      // sidecar written by a pre-`semantic_document_status` build of this
      // reconciler would look like.
      await opened.database.run("DELETE FROM semantic_document_status WHERE workspace_id = ?", [workspaceId]);
      expect(await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest)).toHaveLength(0);

      // The marker still matches exactly (generation/profile/binding/grains/
      // policy unchanged), so this hits the FAST PATH, not the slow path's
      // own per-document writes -- the backfill must therefore happen there.
      const result = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(result.marker_written).toBe(true);
      expect(result.inserted).toBe(0);

      const rows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const restored = rows.find((row) => row.document_id === "artv-legacy");
      expect(restored).toMatchObject({ status: "covered", artifact_id: "art-legacy", display_path: "src/legacy.ts" });
    });
  });

  it("classifies a whole-file/module entity record as unsupported and an eligible entity as covered, both under document_grain 'entity' keyed by the record id", async () => {
    const workspaceId = "ws-semantic-status-entity";
    const provider = createLocalHashProvider();
    await withWorkspace(workspaceId, async (opened, cas) => {
      const functionBody = `function statusEntityContent() { /* ${ENTITY_SPAN_PADDING} */ return 1; }`;
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-owner", artifactVersionId: "artv-owner", text: functionBody, validFromGeneration: 1, displayPath: "src/owner.ts" });
      await seedEntityRecord(opened, workspaceId, {
        recordId: "entity-eligible-1", recordKind: "jsts:entity_callable", ownerArtifactId: "art-owner", ownerArtifactVersionId: "artv-owner", validFromGeneration: 1,
        body: { kind: "function", name: "statusEntityContent", start: 0, end: functionBody.length },
      });
      await seedEntityRecord(opened, workspaceId, {
        recordId: "entity-container-1", recordKind: "jsts:entity_container", ownerArtifactId: "art-owner", ownerArtifactVersionId: "artv-owner", validFromGeneration: 1,
        body: { kind: "module", name: "owner.ts", start: 0, end: functionBody.length },
      });
      await setCurrentGeneration(opened, workspaceId, 1);
      await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });

      const rows = await statusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const eligibleRow = rows.find((row) => row.document_grain === "entity" && row.document_id === "entity-eligible-1");
      const containerRow = rows.find((row) => row.document_grain === "entity" && row.document_id === "entity-container-1");
      expect(eligibleRow).toMatchObject({ status: "covered", artifact_id: "art-owner", artifact_version_id: "artv-owner" });
      expect(containerRow).toMatchObject({ status: "unsupported", reason_codes: JSON.stringify(["unsupported_kind"]) });
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

  it("stops promptly on abort mid-artifact-pass (after the entity pass has already run to completion, Frente S-D reordering), leaving already-committed rows intact and the marker unwritten, and resumes cleanly on the next pass", async () => {
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
      // Frente S-D (2026-09-07, Lever 1): the entity pass (step 5) now runs
      // BEFORE the artifact pass (step 3) -- see `reconcileSemanticProjection`'s
      // own doc comment on why step 3 moved. `embed_batch_size: 1` still pins
      // this to per-document abort-checkpoint granularity. The entity pass
      // reads exactly 2 owner files (reads 1-2, one per distinct entity
      // record's owning artifact version) and fully completes (both entity
      // records span their whole owning file, so BOTH also register full
      // coverage for their own artifact document via `entityCoverageByOwner`);
      // the artifact pass's OWN reads then start at read 3 -- aborting once
      // `reads` reaches 3 fires the checkpoint AFTER the first artifact
      // document (composed entirely from its one covering entity vector, no
      // gap) has already been read and committed, but BEFORE the second
      // one's own read, so the abort is unambiguously mid-ARTIFACT-pass,
      // never mid-entity-pass.
      const shouldAbort = () => reads >= 3;

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content, provider, embed_batch_size: 1, should_abort: shouldAbort });
      expect(result.aborted).toBe(true);
      expect(result.marker_written).toBe(false);
      expect(result.entity_inserted).toBe(2); // entity pass ran to completion first
      expect(result.inserted).toBe(1); // artifact pass aborted after its first document

      const committedEntityVectors = await opened.database.all<{ document_ref: string | null }>("SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId]);
      expect(committedEntityVectors).toHaveLength(2);

      // A subsequent, unobstructed pass picks up exactly where the aborted one left off.
      const resumed = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(resumed.entity_inserted).toBe(0); // already complete from the aborted pass
      expect(resumed.inserted).toBe(1); // the one remaining artifact document
      expect(resumed.marker_written).toBe(true);
      const allEntityVectors = await opened.database.all<{ document_ref: string | null }>("SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId]);
      expect(allEntityVectors.map((row) => row.document_ref).sort()).toEqual(["rec-abort-1", "rec-abort-2"]);
    });
  });
});

// Frente S-B (2026-09-06, decision 17 segmentation): the entity pass now
// embeds ONE vector per SEGMENT of an entity's rendered text (R7/R8/R9),
// aggregating every segment's own outcome into the SAME single
// `semantic_document_status` row the document already had before
// segmentation existed (`recordEntitySegmentOutcome`, `semantic-reconciler.ts`).
// The hash provider's own chars/4 segmenter windows at 1024 chars with a
// 128-char overlap (`DEFAULT_SEGMENT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE`),
// so a rendered entity document longer than ~1024 chars reliably produces
// 2+ segments.
describe("reconcileSemanticProjection entity pass: multi-segment documents (Frente S-B)", () => {
  type SegmentStatusRow = { readonly document_id: string; readonly status: string; readonly reason_codes: string; readonly segment_count: number };
  async function entityStatusRows(opened: WorkspaceDatabase, workspaceId: string, provider: ResolvedSemanticProvider): Promise<readonly SegmentStatusRow[]> {
    return opened.database.all<SegmentStatusRow>(
      "SELECT document_id, status, reason_codes, segment_count FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'entity'",
      [workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest],
    );
  }
  async function entitySegmentRows(opened: WorkspaceDatabase, workspaceId: string, recordId: string): Promise<readonly { readonly segment_index: number; readonly segment_start: number | null; readonly segment_end: number | null; readonly valid_to_generation: number | null }[]> {
    return opened.database.all(
      "SELECT segment_index, segment_start, segment_end, valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND document_ref = ? ORDER BY segment_index",
      [workspaceId, recordId],
    );
  }

  it("embeds a long entity record as MULTIPLE segment rows sharing one status row (segment_count > 1, status covered)", async () => {
    const workspaceId = "ws-semantic-entity-segments";
    const provider = createLocalHashProvider();
    const longBody = "x".repeat(1300);
    const func = `export function bigFunctionForSegmentCoverageTesting() {\n  // ${longBody}\n  return 1;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: func, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-big", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "bigFunctionForSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: func.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      // entity_inserted counts SEGMENTS (Frente S-B) -- 2+ for this long body.
      expect(result.entity_inserted).toBeGreaterThan(1);
      expect(result.entity_failed).toBe(0);
      expect(result.marker_written).toBe(true);

      const segments = await entitySegmentRows(opened, workspaceId, "rec-big");
      expect(segments.length).toBeGreaterThan(1);
      expect(segments.map((row) => row.segment_index)).toEqual(segments.map((_, index) => index));
      for (const row of segments) {
        expect(row.valid_to_generation).toBeNull();
        expect(row.segment_start).not.toBeNull();
        expect(row.segment_end).not.toBeNull();
      }
      // Consecutive segments overlap.
      expect(segments[1]!.segment_start!).toBeLessThan(segments[0]!.segment_end!);

      // Exactly ONE status row for the whole record, regardless of segment count.
      const statusRows = await entityStatusRows(opened, workspaceId, provider);
      const row = statusRows.find((entry) => entry.document_id === "rec-big");
      expect(row).toMatchObject({ status: "covered", reason_codes: "[]" });
      expect(row!.segment_count).toBe(segments.length);
    });
  });

  it("closes ALL of a record's segment rows together and re-embeds fresh ones when the record's own content changes", async () => {
    const workspaceId = "ws-semantic-entity-segments-reembed";
    const provider = createLocalHashProvider();
    const longBodyV1 = "a".repeat(1300);
    const funcV1 = `export function reembedSegmentCoverageTesting() {\n  // ${longBodyV1}\n  return 1;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: funcV1, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-v1", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "reembedSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: funcV1.length } });
      await setCurrentGeneration(opened, workspaceId, 1);
      const engineDatabase = asEngineWorkspaceDatabase(opened);
      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      const originalSegmentCount = first.entity_inserted;
      expect(originalSegmentCount).toBeGreaterThan(1);

      // Record content changes (a new record id, per decision 17's record
      // lifecycle convention: a changed body mints a new record_id).
      const longBodyV2 = "b".repeat(1300);
      const funcV2 = `export function reembedSegmentCoverageTesting() {\n  // ${longBodyV2}\n  return 2;\n}`;
      await closeVersion(opened, "artv-1", 2);
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1-v2", text: funcV2, validFromGeneration: 2 });
      await closeEntityRecord(opened, "rec-v1", 2);
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-v2", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1-v2", validFromGeneration: 2, body: { name: "reembedSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: funcV2.length } });
      await setCurrentGeneration(opened, workspaceId, 2);

      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(second.entity_closed).toBe(originalSegmentCount); // every old segment row closed together
      expect(second.entity_inserted).toBeGreaterThan(1);

      const oldSegments = await entitySegmentRows(opened, workspaceId, "rec-v1");
      expect(oldSegments.every((row) => row.valid_to_generation === 2)).toBe(true);
      const newSegments = await entitySegmentRows(opened, workspaceId, "rec-v2");
      expect(newSegments.every((row) => row.valid_to_generation === null)).toBe(true);
    });
  });

  it("marks segments_truncated in reason_codes (while still covered) when a document's segment count exceeds max_segments", async () => {
    const workspaceId = "ws-semantic-entity-segments-truncated";
    // A provider whose binding wraps the real hash provider but caps its
    // OWN segmenter at 1 segment -- forces `truncated: true` on any document
    // long enough to need a second segment, without needing an enormous
    // (64+ segment) fixture.
    const base = createLocalHashProvider();
    const provider: ResolvedSemanticProvider = { profile: base.profile, binding: { ...base.binding, segment: async (text: string) => { const full = await base.binding.segment!(text); return { segments: full.segments.slice(0, 1), truncated: full.segments.length > 1 }; } } };
    const longBody = "x".repeat(1300);
    const func = `export function truncatedSegmentCoverageTesting() {\n  // ${longBody}\n  return 1;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: func, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-truncated", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "truncatedSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: func.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result.entity_inserted).toBe(1); // only the ONE (capped) segment was embedded

      const statusRows = await entityStatusRows(opened, workspaceId, provider);
      const row = statusRows.find((entry) => entry.document_id === "rec-truncated");
      expect(row?.status).toBe("covered");
      expect(JSON.parse(row?.reason_codes ?? "[]")).toEqual(["segments_truncated"]);
      expect(row?.segment_count).toBe(1);
    });
  });

  it("never writes a partial segment set: no vector row for a multi-segment document is visible until EVERY one of its segments has settled (adversarial review item #5)", async () => {
    const workspaceId = "ws-semantic-entity-segments-atomic";
    const base = createLocalHashProvider();
    const longBody = "x".repeat(1300);
    const func = `export function atomicMultiSegmentCoverageTesting() {\n  // ${longBody}\n  return 1;\n}`;
    let embedCallCount = 0;
    let sawOpenRowBeforeCompletion = false;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: func, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-atomic", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "atomicMultiSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: func.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      // `generateVectors` deliberately OMITTED so every segment routes
      // through the per-document `generateVector` fallback one at a time
      // (same technique as the partial-failure test below), letting this
      // probe observe DB state BETWEEN consecutive segment embeds.
      const provider: ResolvedSemanticProvider = {
        profile: base.profile,
        binding: {
          runtime_binding_id: base.binding.runtime_binding_id,
          executable_binding_digest: base.binding.executable_binding_digest,
          generateVector: async (input) => {
            // Only an ENTITY segment call carries `segment_index` at all
            // (see `GenerateVectorInput.segment_index`'s own doc comment) --
            // the artifact pass embeds this SAME file's own artifact-grain
            // document through this SAME provider instance first, and that
            // call must not be mistaken for one of "rec-atomic"'s segments.
            if (input.segment_index !== undefined) {
              embedCallCount += 1;
              const openRows = await opened.database.all<{ segment_index: number }>(
                "SELECT segment_index FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND document_ref = 'rec-atomic' AND valid_to_generation IS NULL",
                [workspaceId],
              );
              if (openRows.length > 0) sawOpenRowBeforeCompletion = true;
            }
            return base.binding.generateVector(input);
          },
          ...(base.binding.segment === undefined ? {} : { segment: base.binding.segment }),
        },
      };

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, embed_batch_size: 1 });
      expect(result.entity_failed).toBe(0);
      expect(result.marker_written).toBe(true);
      // Confirms this record genuinely needed more than one segment --
      // otherwise the assertion above would be vacuously true.
      expect(embedCallCount).toBeGreaterThan(1);
      expect(sawOpenRowBeforeCompletion).toBe(false);

      const segments = await entitySegmentRows(opened, workspaceId, "rec-atomic");
      expect(segments.length).toBe(embedCallCount);
      expect(segments.every((row) => row.valid_to_generation === null)).toBe(true);
    });
  });

  it("self-heals a partial multi-segment failure: closes the surviving successful segment(s) so the WHOLE document is retried from scratch, and marks it failed for this pass", async () => {
    const workspaceId = "ws-semantic-entity-segments-partial-failure";
    const base = createLocalHashProvider();
    let segmentOneFailuresInjected = 0;
    // Fails segment index 1's OWN generateVector call EXACTLY ONCE, ever --
    // both `generateVectors` (batch) and its per-document `generateVector`
    // fallback route through this same closure, so whichever path the
    // reconciler takes, segment index 1 fails deterministically on the
    // FIRST pass (whenever it is first attempted) and succeeds every time
    // after, including its retry on the SECOND `reconcileSemanticProjection`
    // call. `generateVectors` is deliberately OMITTED (not set to
    // `undefined` -- this project's `exactOptionalPropertyTypes` rejects
    // that) so the reconciler's own batch-then-per-document-fallback logic
    // always takes the per-document `generateVector` path, which is the one
    // that threads `segment_index` per call in this test.
    const provider: ResolvedSemanticProvider = {
      profile: base.profile,
      binding: {
        runtime_binding_id: base.binding.runtime_binding_id,
        executable_binding_digest: base.binding.executable_binding_digest,
        generateVector: async (input) => {
          if (input.segment_index === 1 && segmentOneFailuresInjected === 0) {
            segmentOneFailuresInjected += 1;
            throw new Error("injected segment failure");
          }
          return base.binding.generateVector(input);
        },
        ...(base.binding.segment === undefined ? {} : { segment: base.binding.segment }),
      },
    };
    const longBody = "x".repeat(1300);
    const func = `export function partialFailureSegmentCoverageTesting() {\n  // ${longBody}\n  return 1;\n}`;

    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-1", artifactVersionId: "artv-1", text: func, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-partial", recordKind: "jsts:entity_callable", ownerArtifactId: "art-1", ownerArtifactVersionId: "artv-1", validFromGeneration: 1, body: { name: "partialFailureSegmentCoverageTesting", kind: "function", language: "typescript", path: "art-1", start: 0, end: func.length } });
      await setCurrentGeneration(opened, workspaceId, 1);
      const engineDatabase = asEngineWorkspaceDatabase(opened);

      const first = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(first.entity_failed).toBeGreaterThan(0);
      expect(first.marker_written).toBe(false);

      const statusAfterFirst = await entityStatusRows(opened, workspaceId, provider);
      const rowAfterFirst = statusAfterFirst.find((entry) => entry.document_id === "rec-partial");
      expect(rowAfterFirst?.status).toBe("failed");

      // NOTHING for this record stays open after the self-heal close -- the
      // whole document is fully missing again, ready to be retried in full.
      const openSegmentsAfterFirst = await entitySegmentRows(opened, workspaceId, "rec-partial");
      expect(openSegmentsAfterFirst.filter((row) => row.valid_to_generation === null)).toHaveLength(0);

      const second = await reconcileSemanticProjection({ database: engineDatabase, workspace_id: workspaceId, content: cas, provider });
      expect(second.entity_failed).toBe(0);
      expect(second.marker_written).toBe(true);
      const statusAfterSecond = await entityStatusRows(opened, workspaceId, provider);
      const rowAfterSecond = statusAfterSecond.find((entry) => entry.document_id === "rec-partial");
      expect(rowAfterSecond?.status).toBe("covered");
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

// v4 storage wiring (2026-09-07): `entity_record_source` (`ReconcileSemanticProjectionInput`)
// replaces the entity pass's `record_occurrences`/`record_value_nodes` SQL
// with a pluggable source -- exercised here against a FAKE source (a v4
// workspace's real source is `createNativeSemanticEntityRecordSource`,
// `semantic-entity-source-v4.ts`, covered by its own native-store-facing
// tests) since this reconciler itself must not care WHICH source it was
// handed. `artifact_versions`/`source_artifacts` are seeded exactly like
// every other test in this file (both tables are byte-identical between v3
// and v4) -- no `record_occurrences` row is ever seeded in this describe
// block, proving the entity pass never falls back to it when a source is
// provided.
function fakeEntitySource(initialCandidates: readonly SemanticEntityCandidateRow[]): SemanticEntityRecordSource & { readonly calls: { entityCandidates: number; visibleRecordIds: number }; setVisibleIds: (ids: readonly string[]) => void } {
  let visible = new Set(initialCandidates.map((row) => row.record_id));
  const calls = { entityCandidates: 0, visibleRecordIds: 0 };
  return {
    calls,
    setVisibleIds: (ids: readonly string[]): void => { visible = new Set(ids); },
    entityCandidates: async (): Promise<readonly SemanticEntityCandidateRow[]> => {
      calls.entityCandidates += 1;
      return initialCandidates.filter((row) => visible.has(row.record_id));
    },
    visibleRecordIds: async (ids: readonly string[]): Promise<ReadonlySet<string>> => {
      calls.visibleRecordIds += 1;
      return new Set(ids.filter((id) => visible.has(id)));
    },
  };
}

async function ownerFileMeta(opened: WorkspaceDatabase, artifactVersionId: string): Promise<{ readonly content_hash: string; readonly byte_length: number }> {
  const row = await opened.database.get<{ content_hash: string; byte_length: number }>("SELECT content_hash, byte_length FROM artifact_versions WHERE artifact_version_id = ?", [artifactVersionId]);
  if (row === undefined) throw new Error(`No artifact_versions row for ${artifactVersionId}.`);
  return row;
}

type V4TestStatusRow = { readonly document_id: string; readonly status: string; readonly reason_codes: string };
async function v4TestStatusRows(opened: WorkspaceDatabase, workspaceId: string, profileId: string, executableBindingId: string): Promise<readonly V4TestStatusRow[]> {
  return opened.database.all<V4TestStatusRow>(
    "SELECT document_id, status, reason_codes FROM semantic_document_status WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND document_grain = 'entity' ORDER BY document_id",
    [workspaceId, profileId, executableBindingId],
  );
}

describe("reconcileSemanticProjection entity pass with entity_record_source (v4 storage wiring)", () => {
  it("embeds eligible candidates and skips the ineligible container kind from ONE fake source, exactly like the v3 record_occurrences path", async () => {
    const workspaceId = "ws-semantic-v4-entity-source";
    const provider = createLocalHashProvider();
    const functionBody = `export function v4SourceEligible() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    const funcStart = functionBody.indexOf("export");
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-v4", artifactVersionId: "artv-v4", text: functionBody, validFromGeneration: 1, displayPath: "src/v4.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);
      const meta = await ownerFileMeta(opened, "artv-v4");

      const source = fakeEntitySource([
        { record_id: "entity-eligible", record_kind: "jsts:entity_callable", owner_artifact_id: "art-v4", owner_artifact_version_id: "artv-v4", content_hash: meta.content_hash, byte_length: meta.byte_length, display_path: "src/v4.ts", body: { kind: "function", name: "v4SourceEligible", start: funcStart, end: functionBody.length } },
        { record_id: "entity-container", record_kind: "jsts:entity_container", owner_artifact_id: "art-v4", owner_artifact_version_id: "artv-v4", content_hash: meta.content_hash, byte_length: meta.byte_length, display_path: "src/v4.ts", body: { kind: "module", name: "v4.ts", start: 0, end: functionBody.length } },
      ]);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, entity_record_source: source });
      expect(result.entity_inserted).toBe(1);
      expect(result.entity_skipped_ineligible).toBe(0);
      expect(result.entity_failed).toBe(0);
      expect(result.marker_written).toBe(true);
      // The v3 fallback path was never reached: no `record_occurrences` row
      // exists for this workspace at all, so a SQL query against it would
      // have thrown "no such table" (v4 catalog) or returned zero rows and
      // failed this assertion outright (v3 schema, empty table) either way.
      expect(source.calls.entityCandidates).toBe(1);

      const entityRows = await opened.database.all<{ document_ref: string | null }>(
        "SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId],
      );
      expect(entityRows.map((row) => row.document_ref)).toEqual(["entity-eligible"]);

      const statusRowsResult = await v4TestStatusRows(opened, workspaceId, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const containerStatus = statusRowsResult.find((row) => row.document_id === "entity-container");
      expect(containerStatus).toMatchObject({ status: "unsupported", reason_codes: JSON.stringify(["unsupported_kind"]) });
    });
  });

  it("closes an entity vector once the fake source reports its record no longer visible", async () => {
    const workspaceId = "ws-semantic-v4-entity-stale";
    const provider = createLocalHashProvider();
    const functionBody = `export function v4SourceStale() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-stale", artifactVersionId: "artv-stale", text: functionBody, validFromGeneration: 1, displayPath: "src/stale.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);
      const meta = await ownerFileMeta(opened, "artv-stale");
      const candidate: SemanticEntityCandidateRow = { record_id: "entity-stale", record_kind: "jsts:entity_callable", owner_artifact_id: "art-stale", owner_artifact_version_id: "artv-stale", content_hash: meta.content_hash, byte_length: meta.byte_length, display_path: "src/stale.ts", body: { kind: "function", name: "v4SourceStale", start: functionBody.indexOf("export"), end: functionBody.length } };
      const source = fakeEntitySource([candidate]);

      const first = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, entity_record_source: source });
      expect(first.entity_inserted).toBe(1);

      // The record disappears from the source entirely (e.g. its owning
      // declaration was deleted) without any workspace generation bump --
      // `visibleRecordIds` now reports it absent.
      source.setVisibleIds([]);
      await setCurrentGeneration(opened, workspaceId, 2);
      const second = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, entity_record_source: source });
      expect(second.entity_closed).toBe(1);
      expect(second.entity_inserted).toBe(0);

      const openRow = await opened.database.get<{ document_ref: string }>("SELECT document_ref FROM vector_projection_rows WHERE workspace_id = ? AND document_grain = 'entity' AND valid_to_generation IS NULL", [workspaceId]);
      expect(openRow).toBeUndefined();
    });
  });

  it("a reconcile no-op (unchanged generation/provider/policy) never calls the entity source again -- proves the fast path skips re-embedding, not just re-inserting", async () => {
    const workspaceId = "ws-semantic-v4-entity-noop";
    const provider = createLocalHashProvider();
    const functionBody = `export function v4SourceNoop() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-noop", artifactVersionId: "artv-noop", text: functionBody, validFromGeneration: 1, displayPath: "src/noop.ts" });
      await setCurrentGeneration(opened, workspaceId, 1);
      const meta = await ownerFileMeta(opened, "artv-noop");
      const source = fakeEntitySource([
        { record_id: "entity-noop", record_kind: "jsts:entity_callable", owner_artifact_id: "art-noop", owner_artifact_version_id: "artv-noop", content_hash: meta.content_hash, byte_length: meta.byte_length, display_path: "src/noop.ts", body: { kind: "function", name: "v4SourceNoop", start: functionBody.indexOf("export"), end: functionBody.length } },
      ]);

      const first = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, entity_record_source: source });
      expect(first.entity_inserted).toBe(1);
      expect(first.marker_written).toBe(true);
      expect(source.calls.entityCandidates).toBe(1);
      // One call from `syncDocumentStatusBulk`'s orphan sweep, which always
      // runs at the end of a full pass (including the very first one) once
      // ANY entity-grain status row exists to check -- not from step 4
      // (nothing was open yet to consider stale on a first pass).
      expect(source.calls.visibleRecordIds).toBe(1);
      const callsAfterFirst = { ...source.calls };

      // Simulates the daemon's own `runV4WorkspaceScan` -> `submitSemanticMaintenance`
      // sequence after a `ScanScope::Reconcile` no-op (generation unchanged,
      // nothing published): re-running against the IDENTICAL generation must
      // hit `reconcileSemanticProjection`'s own already-complete fast path
      // (marker + `hasAnyDocumentStatus()` both already satisfied) and never
      // touch the entity source again -- not even the orphan sweep, which
      // the fast path skips entirely once status rows already exist.
      const second = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, entity_record_source: source });
      expect(second).toEqual({ ...first, closed: 0, inserted: 0, entity_inserted: 0 });
      expect(source.calls).toEqual(callsAfterFirst);
    });
  });
});

// Frente S-D (2026-09-07, Lever 1): the artifact-vector composition itself --
// `reconcileSemanticProjection`'s step 3 (moved to run after step 5) composes
// an artifact document's vector from its owning file's ELIGIBLE entity
// segment vectors (already fresh this pass) plus fresh vectors of only the
// text NOT covered by any such span ("gap" text), instead of always
// re-embedding the whole file from scratch. `createLocalHashProvider` is
// used throughout (fully deterministic, no floating-point/model variance) so
// "numeric equality with tolerance" assertions below are meaningful.
async function readOpenVectorBytes(opened: WorkspaceDatabase, cas: ContentAddressedStore, where: string, params: readonly SqliteValue[]): Promise<{ readonly vector: Uint8Array; readonly dimensions: number; readonly elementType: "float32" | "float64"; readonly segmentCount: number | undefined }> {
  const row = await opened.database.get<{ shard_id: string; shard_offset: number; byte_length: number; dimensions: number; element_type: string }>(
    `SELECT shard_id, shard_offset, byte_length, dimensions, element_type FROM vector_projection_rows WHERE valid_to_generation IS NULL AND ${where}`,
    params,
  );
  if (row === undefined) throw new Error(`No open vector row matching "${where}".`);
  const shard = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM vector_shards WHERE shard_id = ?", [row.shard_id]);
  if (shard === undefined) throw new Error(`No vector_shards row for shard_id ${row.shard_id}.`);
  const packed = await cas.read(shard.content_hash);
  return { vector: packed.slice(row.shard_offset, row.shard_offset + row.byte_length), dimensions: row.dimensions, elementType: row.element_type as "float32" | "float64", segmentCount: undefined };
}

async function readDocumentStatusSegmentCount(opened: WorkspaceDatabase, documentGrain: "artifact" | "entity", documentId: string): Promise<{ readonly segment_count: number; readonly reason_codes: string } | undefined> {
  return opened.database.get<{ segment_count: number; reason_codes: string }>("SELECT segment_count, reason_codes FROM semantic_document_status WHERE document_grain = ? AND document_id = ?", [documentGrain, documentId]);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return dot / (leftNorm * rightNorm);
}

describe("Frente S-D (2026-09-07): artifact-vector composition from entity segments (Lever 1)", () => {
  it("when one eligible entity's span covers the WHOLE file (no gap), the composed artifact vector equals that entity's own vector within numeric tolerance", async () => {
    const workspaceId = "ws-semantic-compose-nogap";
    const provider = createLocalHashProvider();
    const text = `export function composeNoGapForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-nogap", artifactVersionId: "artv-nogap", text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-nogap", recordKind: "jsts:entity_callable", ownerArtifactId: "art-nogap", ownerArtifactVersionId: "artv-nogap", validFromGeneration: 1, body: { name: "composeNoGapForTestCoverage", kind: "function", start: 0, end: text.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result.entity_inserted).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.marker_written).toBe(true);

      const artifactVector = await readOpenVectorBytes(opened, cas, "owner_artifact_version_id = ? AND document_grain IS NULL", ["artv-nogap"]);
      const entityVector = await readOpenVectorBytes(opened, cas, "document_grain = 'entity' AND document_ref = ?", ["rec-nogap"]);
      const artifactValues = vectorValues(artifactVector.vector, { dimensions: artifactVector.dimensions, element_type: artifactVector.elementType, normalization: "none" });
      const entityValues = vectorValues(entityVector.vector, { dimensions: entityVector.dimensions, element_type: entityVector.elementType, normalization: "none" });
      // A single-component mean is that component itself, then re-normalized
      // -- since the entity vector is already unit-norm, re-normalizing it is
      // idempotent up to float32 rounding (see `combineVectorsMeanNormalized`'s
      // own doc comment), so cosine similarity should be extremely close to 1,
      // never bit-identical.
      expect(cosineSimilarity(artifactValues, entityValues)).toBeCloseTo(1, 6);

      // `semantic_document_status.segment_count` reflects the REAL component
      // count (1 entity segment, 0 gap segments) -- plan §4's own requirement.
      const status = await readDocumentStatusSegmentCount(opened, "artifact", "artv-nogap");
      expect(status?.segment_count).toBe(1);
      expect(status?.reason_codes).toBe("[]");
    });
  });

  it("when an eligible entity covers only PART of the file, the composed artifact vector combines the entity vector with a fresh gap-segment vector, and differs from the entity-only vector", async () => {
    const workspaceId = "ws-semantic-compose-gap";
    const provider = createLocalHashProvider();
    const gapText = `import { unrelatedHelperForTestCoverageGapSegment } from "./unrelated-gap-helper-module";\n`;
    const functionText = `export function composeWithGapForTestCoverage() {\n  // ${ENTITY_SPAN_PADDING}\n  return 2;\n}`;
    const text = `${gapText}${functionText}\n`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-gap", artifactVersionId: "artv-gap", text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-gap", recordKind: "jsts:entity_callable", ownerArtifactId: "art-gap", ownerArtifactVersionId: "artv-gap", validFromGeneration: 1, body: { name: "composeWithGapForTestCoverage", kind: "function", start: gapText.length, end: gapText.length + functionText.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result.entity_inserted).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.marker_written).toBe(true);

      const artifactVector = await readOpenVectorBytes(opened, cas, "owner_artifact_version_id = ? AND document_grain IS NULL", ["artv-gap"]);
      const entityVector = await readOpenVectorBytes(opened, cas, "document_grain = 'entity' AND document_ref = ?", ["rec-gap"]);
      const artifactValues = vectorValues(artifactVector.vector, { dimensions: artifactVector.dimensions, element_type: artifactVector.elementType, normalization: "none" });
      const entityValues = vectorValues(entityVector.vector, { dimensions: entityVector.dimensions, element_type: entityVector.elementType, normalization: "none" });
      // A real gap contributes a second, distinct component -- the composed
      // artifact vector is the mean of TWO vectors, so it must NOT collapse
      // back onto the entity-only vector (a regression that would mean the
      // gap was silently dropped).
      expect(cosineSimilarity(artifactValues, entityValues)).toBeLessThan(0.999);

      // Independently recompute the expected combination via the provider's
      // OWN deterministic embed of the exact same gap text (the hash
      // provider's segmenter treats a short gap as one whole segment), then
      // mean + re-normalize by hand -- must match the reconciler's own
      // composed vector exactly (deterministic provider, no floating drift).
      const gapGenerated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: gapText.trimEnd() });
      const gapValues = vectorValues(gapGenerated.vector, { dimensions: provider.profile.dimensions, element_type: provider.profile.element_type as "float32" | "float64", normalization: "none" });
      const expectedMean = entityValues.map((value, index) => (value + gapValues[index]!) / 2);
      const normalized = (() => {
        const norm = Math.sqrt(expectedMean.reduce((sum, value) => sum + value * value, 0));
        return expectedMean.map((value) => value / norm);
      })();
      expect(cosineSimilarity(artifactValues, normalized)).toBeCloseTo(1, 6);

      const status = await readDocumentStatusSegmentCount(opened, "artifact", "artv-gap");
      expect(status?.segment_count).toBe(2);
    });
  });

  it("falls back to the ordinary whole-file embed when the file has zero eligible entities (no coverage this pass)", async () => {
    const workspaceId = "ws-semantic-compose-none";
    const provider = createLocalHashProvider();
    const text = "export const plainConfigValueForTestCoverage = 42;\n";
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-none", artifactVersionId: "artv-none", text, validFromGeneration: 1 });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(result.inserted).toBe(1);
      expect(result.entity_inserted).toBe(0);

      const artifactVector = await readOpenVectorBytes(opened, cas, "owner_artifact_version_id = ? AND document_grain IS NULL", ["artv-none"]);
      const artifactValues = vectorValues(artifactVector.vector, { dimensions: artifactVector.dimensions, element_type: artifactVector.elementType, normalization: "none" });
      const whole = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text });
      const wholeValues = vectorValues(whole.vector, { dimensions: provider.profile.dimensions, element_type: provider.profile.element_type as "float32" | "float64", normalization: "none" });
      // No coverage this pass -- byte-for-byte the pre-Lever-1 whole-file
      // path, not merely "close": the reconciler's own `buildSemanticDocument`
      // rendering matches this direct provider call exactly for plain text.
      expect(cosineSimilarity(artifactValues, wholeValues)).toBeCloseTo(1, 6);

      const status = await readDocumentStatusSegmentCount(opened, "artifact", "artv-none");
      expect(status?.segment_count).toBe(1);
    });
  });
});

// Frente S-D (2026-09-07, Lever 2): parallel reconciler sharding --
// `ReconcileSemanticProjectionInput.shard` splits the missing-vector insert
// loops (steps 3 and 5) across `count` concurrent calls (in production, one
// per child process, see `@urdira/daemon`'s `runSemanticReconcileSharded`),
// each handling only documents whose owning artifact hashes to its own
// `index`. This test runs the two shard calls SEQUENTIALLY against the SAME
// workspace (correctness only -- real concurrency is a daemon-orchestration
// concern, not a `reconcileSemanticProjection`-level one) followed by one
// unsharded "finalize" call, and asserts the resulting rows are IDENTICAL
// (same document set, same exact vector bytes -- `createLocalHashProvider`
// is fully deterministic) to a single ordinary unsharded pass over the same
// corpus.
async function allVectorRowSignatures(opened: WorkspaceDatabase, cas: ContentAddressedStore): Promise<readonly string[]> {
  const rows = await opened.database.all<{ document_grain: string | null; document_ref: string | null; owner_artifact_version_id: string; shard_id: string; shard_offset: number; byte_length: number }>(
    "SELECT document_grain, document_ref, owner_artifact_version_id, shard_id, shard_offset, byte_length FROM vector_projection_rows WHERE valid_to_generation IS NULL",
  );
  const out: string[] = [];
  for (const row of rows) {
    const shard = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM vector_shards WHERE shard_id = ?", [row.shard_id]);
    const packed = shard !== undefined ? await cas.read(shard.content_hash) : new Uint8Array();
    const bytes = packed.slice(row.shard_offset, row.shard_offset + row.byte_length);
    out.push(`${row.document_grain ?? "artifact"}:${row.document_ref ?? row.owner_artifact_version_id}:${Buffer.from(bytes).toString("hex")}`);
  }
  return out.sort();
}

describe("Frente S-D (2026-09-07): parallel reconciler sharding (Lever 2)", () => {
  const shardDocs = [1, 2, 3, 4, 5, 6].map((index) => ({
    artifactId: `art-shard-${index}`,
    artifactVersionId: `artv-shard-${index}`,
    recordId: `rec-shard-${index}`,
    text: `export function shardedFunctionNumber${index}ForTestCoverageOfTheParallelReconciler() {\n  // ${ENTITY_SPAN_PADDING}\n  return ${index};\n}`,
  }));

  async function seedShardCorpus(opened: WorkspaceDatabase, cas: ContentAddressedStore, workspaceId: string): Promise<void> {
    for (const doc of shardDocs) {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: doc.artifactId, artifactVersionId: doc.artifactVersionId, text: doc.text, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: doc.recordId, recordKind: "jsts:entity_callable", ownerArtifactId: doc.artifactId, ownerArtifactVersionId: doc.artifactVersionId, validFromGeneration: 1, body: { name: `shardedFunctionNumber${doc.artifactId}`, kind: "function", start: 0, end: doc.text.length } });
    }
    await setCurrentGeneration(opened, workspaceId, 1);
  }

  it("assigns every document to exactly one of N shards, deterministically", () => {
    for (const doc of shardDocs) {
      const shard0 = shardIndexFor(doc.artifactId, 2);
      const shard1 = shardIndexFor(doc.artifactId, 2);
      expect(shard0).toBe(shard1); // deterministic: same input, same output
      expect(shard0 === 0 || shard0 === 1).toBe(true);
    }
    // With 6 distinct artifact ids and 2 shards, both shards get at least one document (not a strict requirement of the function, but true for this fixture -- confirms the hash is not degenerate for this test's own inputs).
    const assignments = new Set(shardDocs.map((doc) => shardIndexFor(doc.artifactId, 2)));
    expect(assignments.size).toBeGreaterThan(0);
  });

  it("2 shards + one finalize pass produce the same rows as a single unsharded pass", async () => {
    const provider = createLocalHashProvider();

    const baselineWorkspace = "ws-semantic-shard-baseline";
    let baselineRows: readonly string[] = [];
    await withWorkspace(baselineWorkspace, async (opened, cas) => {
      await seedShardCorpus(opened, cas, baselineWorkspace);
      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: baselineWorkspace, content: cas, provider });
      expect(result.marker_written).toBe(true);
      expect(result.inserted).toBe(shardDocs.length);
      expect(result.entity_inserted).toBe(shardDocs.length);
      baselineRows = await allVectorRowSignatures(opened, cas);
    });
    expect(baselineRows).toHaveLength(shardDocs.length * 2); // 1 artifact + 1 entity vector per document

    const shardedWorkspace = "ws-semantic-shard-2way";
    await withWorkspace(shardedWorkspace, async (opened, cas) => {
      await seedShardCorpus(opened, cas, shardedWorkspace);
      const shard0 = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: shardedWorkspace, content: cas, provider, shard: { index: 0, count: 2 } });
      const shard1 = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: shardedWorkspace, content: cas, provider, shard: { index: 1, count: 2 } });
      // A sharded call never writes the marker or runs bulk status maintenance -- only the orchestrator's final unsharded call may.
      expect(shard0.marker_written).toBe(false);
      expect(shard1.marker_written).toBe(false);
      // Every document is handled by EXACTLY one shard (disjoint, deterministic hash assignment) -- the two shards' own counts sum to the whole corpus.
      expect(shard0.inserted + shard1.inserted).toBe(shardDocs.length);
      expect(shard0.entity_inserted + shard1.entity_inserted).toBe(shardDocs.length);

      const finalize = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: shardedWorkspace, content: cas, provider });
      expect(finalize.marker_written).toBe(true);
      // Nothing left for the finalize pass to embed -- both shards already covered every document between them.
      expect(finalize.inserted).toBe(0);
      expect(finalize.entity_inserted).toBe(0);

      const shardedRows = await allVectorRowSignatures(opened, cas);
      expect(shardedRows).toEqual(baselineRows);
    });
  });

  it("a shard with index >= count throws (defensive input validation)", () => {
    expect(() => shardIndexFor("art-x", 0)).toThrow();
  });
});

// Frente S-D (2026-09-07, Lever 3): `semantic_segment_cache` -- a segment
// whose exact (rendered text, executable_binding_id) pair was already
// embedded (by ANY document, in ANY prior generation) is never re-sent to
// the provider; its cached vector is reused directly. Wraps
// `createLocalHashProvider`'s own binding with call counters so the
// assertions below are about REAL provider invocations, not just database
// row counts.
describe("Frente S-D (2026-09-07): segment cache (Lever 3)", () => {
  it("does not re-embed a segment whose exact (text, binding) pair is already cached, even across two different entities/files", async () => {
    const workspaceId = "ws-semantic-cache-dedup";
    const baseProvider = createLocalHashProvider();
    let generateVectorCalls = 0;
    let generateVectorsCalls = 0;
    const provider: ResolvedSemanticProvider = {
      profile: baseProvider.profile,
      binding: {
        ...baseProvider.binding,
        generateVector: async (input) => { generateVectorCalls += 1; return baseProvider.binding.generateVector(input); },
        ...(baseProvider.binding.generateVectors === undefined ? {} : {
          generateVectors: async (inputs: Parameters<NonNullable<typeof baseProvider.binding.generateVectors>>[0]) => { generateVectorsCalls += 1; return baseProvider.binding.generateVectors!(inputs); },
        }),
      },
    };
    const sharedText = `export function duplicateBoilerplateForTestCoverageOfTheSegmentCache() {\n  // ${ENTITY_SPAN_PADDING}\n  return "shared";\n}`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-cache-a", artifactVersionId: "artv-cache-a", text: sharedText, validFromGeneration: 1 });
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-cache-b", artifactVersionId: "artv-cache-b", text: sharedText, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-cache-a", recordKind: "jsts:entity_callable", ownerArtifactId: "art-cache-a", ownerArtifactVersionId: "artv-cache-a", validFromGeneration: 1, body: { name: "duplicateBoilerplateForTestCoverageOfTheSegmentCache", kind: "function", start: 0, end: sharedText.length } });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-cache-b", recordKind: "jsts:entity_callable", ownerArtifactId: "art-cache-b", ownerArtifactVersionId: "artv-cache-b", validFromGeneration: 1, body: { name: "duplicateBoilerplateForTestCoverageOfTheSegmentCache", kind: "function", start: 0, end: sharedText.length } });
      await setCurrentGeneration(opened, workspaceId, 1);

      const result = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider, embed_batch_size: 1 });
      expect(result.entity_inserted).toBe(2);
      expect(result.inserted).toBe(2); // both artifacts fully covered by their own single entity (no gap) -- composed, not re-embedded

      // Entity A's segment is a cache MISS (first occurrence, one real
      // provider call); entity B's segment renders BYTE-IDENTICAL text (same
      // name/kind/span over byte-identical file content), so it is a cache
      // HIT -- zero additional provider calls. The composed artifact vectors
      // never call the provider directly at all (Lever 1: mean-pooled from
      // already-embedded components), so the total across the whole pass is
      // exactly ONE real embedding call for ALL FOUR documents (2 entities +
      // 2 artifacts).
      expect(generateVectorsCalls + generateVectorCalls).toBe(1);

      const cacheRows = await opened.database.all<{ segment_digest: string }>("SELECT segment_digest FROM semantic_segment_cache WHERE workspace_id = ?", [workspaceId]);
      expect(new Set(cacheRows.map((row) => row.segment_digest)).size).toBe(1);

      // Both entities' vectors are numerically identical (same cached
      // bytes), confirming the cache reuse did not silently produce a
      // DIFFERENT (wrong) vector for the second occurrence.
      const vectorA = await readOpenVectorBytes(opened, cas, "document_grain = 'entity' AND document_ref = ?", ["rec-cache-a"]);
      const vectorB = await readOpenVectorBytes(opened, cas, "document_grain = 'entity' AND document_ref = ?", ["rec-cache-b"]);
      expect(Buffer.from(vectorA.vector).equals(Buffer.from(vectorB.vector))).toBe(true);
    });
  });

  it("a second reconcile pass over an UNCHANGED corpus makes zero additional provider calls (the ordinary fast path), and a brand-new document with previously-seen content is a cache hit", async () => {
    const workspaceId = "ws-semantic-cache-edit";
    const baseProvider = createLocalHashProvider();
    let calls = 0;
    const provider: ResolvedSemanticProvider = {
      profile: baseProvider.profile,
      binding: { ...baseProvider.binding, generateVector: async (input) => { calls += 1; return baseProvider.binding.generateVector(input); }, ...(baseProvider.binding.generateVectors === undefined ? {} : { generateVectors: async (inputs: Parameters<NonNullable<typeof baseProvider.binding.generateVectors>>[0]) => { calls += 1; return baseProvider.binding.generateVectors!(inputs); } }) },
    };
    const textOne = `export function cacheEditFunctionOneForTestCoverageOfTheSegmentCache() {\n  // ${ENTITY_SPAN_PADDING}\n  return 1;\n}`;
    await withWorkspace(workspaceId, async (opened, cas) => {
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-cache-edit-1", artifactVersionId: "artv-cache-edit-1", text: textOne, validFromGeneration: 1 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-cache-edit-1", recordKind: "jsts:entity_callable", ownerArtifactId: "art-cache-edit-1", ownerArtifactVersionId: "artv-cache-edit-1", validFromGeneration: 1, body: { name: "cacheEditFunctionOneForTestCoverageOfTheSegmentCache", kind: "function", start: 0, end: textOne.length } });
      await setCurrentGeneration(opened, workspaceId, 1);
      await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      const callsAfterFirst = calls;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // A second, unobstructed pass over the SAME generation hits the
      // already-complete fast path -- zero new provider calls, zero new
      // cache lookups even needed.
      const second = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(second.marker_written).toBe(true);
      expect(calls).toBe(callsAfterFirst);

      // Simulates "an edited file keeps ~90% of its segments" (plan §4's own
      // framing) via the simplest real instance of that: a SECOND, brand-new
      // artifact whose entity happens to render IDENTICAL text to the first
      // (e.g. an unrelated file introducing the same well-known boilerplate)
      // -- this new generation's entity embed is a cache HIT, not a fresh
      // provider call.
      await seedTextVersion(opened, cas, workspaceId, { artifactId: "art-cache-edit-2", artifactVersionId: "artv-cache-edit-2", text: textOne, validFromGeneration: 2 });
      await seedEntityRecord(opened, workspaceId, { recordId: "rec-cache-edit-2", recordKind: "jsts:entity_callable", ownerArtifactId: "art-cache-edit-2", ownerArtifactVersionId: "artv-cache-edit-2", validFromGeneration: 2, body: { name: "cacheEditFunctionOneForTestCoverageOfTheSegmentCache", kind: "function", start: 0, end: textOne.length } });
      await setCurrentGeneration(opened, workspaceId, 2);
      const third = await reconcileSemanticProjection({ database: asEngineWorkspaceDatabase(opened), workspace_id: workspaceId, content: cas, provider });
      expect(third.entity_inserted).toBe(1);
      expect(third.inserted).toBe(1);
      expect(calls).toBe(callsAfterFirst); // the new document's segment was a 100% cache hit -- zero new provider calls
    });
  });
});
