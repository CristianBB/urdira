import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import type { JsonValue, SourceProviderResponseEnvelope } from "@urdira/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenericSourceIndexer, sourceObservationBatchDigest, type ProviderObservation, type SourceIndexWorkspacePort } from "../packages/engine/src/index.js";
import { createDurableStorage, createFaultInjector, openSqliteDatabase } from "../packages/storage/src/index.js";

// Lexical projections (lexical_documents/lexical_trigrams) are no longer
// written by the scan path at all: they're built by an out-of-band
// post-ready reconcile job from committed artifact_versions content,
// decoupled entirely from GenericSourceIndexer (see the lexical-search
// design doc). This file exercises the source indexer's own correctness
// (artifacts, versions, tombstones, batches, watch events) and asserts on
// `artifact_versions`/CAS content directly instead of through
// `searchLiteral`; `putLexicalDocument`/`searchLiteral` behavior itself is
// covered by phase5.test.ts and phase5-review-fixes.test.ts.
function testIndexer(workspace: SourceIndexWorkspacePort): GenericSourceIndexer {
  return new GenericSourceIndexer(workspace);
}

type OpenedWorkspace = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>;

/** The currently-open (valid_to_generation IS NULL) artifact_versions row for `artifactId`, or undefined if absent. */
async function currentVersion(opened: OpenedWorkspace, artifactId: string): Promise<{ artifact_id: string; artifact_version_id: string; content_hash: string } | undefined> {
  return await opened.database.get<{ artifact_id: string; artifact_version_id: string; content_hash: string }>(
    "SELECT artifact_id, artifact_version_id, content_hash FROM artifact_versions WHERE artifact_id = ? AND valid_to_generation IS NULL",
    [artifactId],
  );
}

/** The artifact_versions row for `artifactId` visible at `generation`, or undefined if none is. */
async function versionAtGeneration(opened: OpenedWorkspace, artifactId: string, generation: number): Promise<{ artifact_id: string; artifact_version_id: string; content_hash: string } | undefined> {
  return await opened.database.get<{ artifact_id: string; artifact_version_id: string; content_hash: string }>(
    "SELECT artifact_id, artifact_version_id, content_hash FROM artifact_versions WHERE artifact_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)",
    [artifactId, generation, generation],
  );
}

const roots: string[] = [];
const instant = "2026-08-09T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryStorage() {
  const root = await mkdtemp(join(tmpdir(), "urdira-indexing-"));
  roots.push(root);
  return { root, storage: await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 }) };
}

function workspace(workspaceId: string) {
  return {
    workspace_id: workspaceId,
    canonical_root: `/${workspaceId}`,
    display_root: `/${workspaceId}`,
    source_provider_bindings: [],
    status: "registered",
    registered_at: instant,
  };
}

function providerObservation(
  workspaceId: string,
  batchId: string,
  uri: string,
  bytes: Uint8Array,
  metadata = `metadata:${uri}`,
  sourceProvider = "core:directory_source_provider",
): ProviderObservation {
  return {
    source_observation_id: `provider-observation:${batchId}:${uri}`,
    observation_batch_id: batchId,
    workspace_id: workspaceId,
    artifact_id: `provider-artifact:${uri}`,
    source_provider_binding_id: "binding:one",
    source_provider: sourceProvider,
    source_provider_version: "1",
    ordering_domain: "binding:one",
    observation_mode: "reconciliation",
    observed_state: "present",
    observed_content_hash: digestBytes(bytes),
    observed_metadata_digest: metadata,
    provider_event_token: `token:${batchId}:${uri}`,
    provider_sequence: `watermark:${batchId}`,
    observed_at: instant,
    received_at: instant,
    normalized_uri: uri,
    provider_version_token: `token:${batchId}:${uri}`,
  };
}

function envelope(
  workspaceId: string,
  call: string,
  outcome: string,
  payload?: JsonValue,
  componentId = "core:directory_source_provider",
): SourceProviderResponseEnvelope {
  return {
    protocol_version: "1",
    request_id: `request:${call}`,
    request_digest: `sha256:${"1".repeat(64)}`,
    call,
    workspace_id: workspaceId,
    source_provider_binding_id: "binding:one",
    component_id: componentId,
    component_version: "1",
    outcome,
    ...(payload === undefined ? { error: JSON.stringify({ error_code: `core:${outcome}`, retryability: "retryable" }) } : { payload }),
  };
}

function batchResponse(
  workspaceId: string,
  batchId: string,
  observations: readonly ProviderObservation[],
  options: {
    readonly complete?: boolean;
    readonly authoritative?: boolean;
    readonly stable?: boolean;
    readonly source_provider?: string;
    readonly scopes?: readonly {
      readonly scope_type: string;
      readonly source_provider_binding_id: string;
      readonly source_provider: string;
      readonly normalized_scope_key: string;
    }[];
  } = {},
): SourceProviderResponseEnvelope {
  const complete = options.complete ?? true;
  const authoritative = options.authoritative ?? true;
  const stable = options.stable ?? true;
  const sourceProvider = options.source_provider ?? observations[0]?.source_provider ?? "core:directory_source_provider";
  const batchCore = {
    observation_batch_id: batchId,
    workspace_id: workspaceId,
    source_provider_binding_id: "binding:one",
    source_provider: sourceProvider,
    source_provider_version: "1",
    ordering_domain: "binding:one",
    observation_mode: "reconciliation",
    coverage_scopes: JSON.stringify(options.scopes ?? [{ scope_type: "source_root", source_provider_binding_id: "binding:one", source_provider: sourceProvider, normalized_scope_key: "" }]),
    coverage_completeness: complete ? "complete" : "partial",
    deletion_authority: authoritative ? "authoritative" : "none",
    provider_cursor_before: "",
    provider_cursor_after: `watermark:${batchId}`,
    started_at: instant,
    completed_at: instant,
    observation_count: observations.length,
    unavailable_count: 0,
  };
  const batch = { ...batchCore, batch_digest: sourceObservationBatchDigest(batchCore, observations) };
  return envelope(workspaceId, "reconcile", "success", {
    observation_batch: JSON.stringify({ batch, observations }),
    watermark: `watermark:${batchId}`,
    capture_start_fingerprint: stable ? `fingerprint:${batchId}` : "fingerprint:before",
    capture_end_fingerprint: stable ? `fingerprint:${batchId}` : "fingerprint:after",
    stable,
  }, sourceProvider);
}

async function installLegacySourceSchema(databasePath: string, workspaceId: string): Promise<{ readonly artifactSql: string; readonly tombstoneSql: string }> {
  const database = await openSqliteDatabase({ filename: databasePath });
  await database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE artifact_tombstones;
    DROP TABLE source_artifacts;
    CREATE TABLE source_artifacts (
      artifact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      normalized_uri TEXT NOT NULL,
      normalized_path TEXT,
      display_path TEXT,
      artifact_kind TEXT NOT NULL,
      artifact_payload BLOB NOT NULL,
      UNIQUE (workspace_id, artifact_id),
      UNIQUE (workspace_id, normalized_uri)
    ) STRICT;
    CREATE INDEX source_artifacts_path_idx ON source_artifacts(workspace_id, normalized_path);
    CREATE TABLE artifact_tombstones (
      artifact_tombstone_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      absence_kind TEXT NOT NULL,
      absence_reason_code TEXT NOT NULL,
      last_artifact_version_id TEXT NOT NULL,
      valid_from_generation INTEGER NOT NULL,
      valid_to_generation INTEGER,
      opening_artifact_change_id TEXT NOT NULL,
      closing_artifact_change_id TEXT,
      replacement_artifact_version_id TEXT,
      cause_references TEXT NOT NULL,
      lineage_evidence_record_ids TEXT NOT NULL,
      artifact_tombstone_payload BLOB NOT NULL,
      FOREIGN KEY (workspace_id, artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
      FOREIGN KEY (workspace_id, artifact_id, last_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
      FOREIGN KEY (workspace_id, artifact_id, replacement_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
      CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation)
    ) STRICT;
    PRAGMA foreign_keys = ON;
  `);
  const sentinel = { artifact_id: "legacy-sentinel", workspace_id: workspaceId, normalized_uri: "sentinel.txt", normalized_path: "sentinel.txt", display_path: "sentinel.txt", artifact_kind: "physical_file" };
  await database.run(
    "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [sentinel.artifact_id, sentinel.workspace_id, sentinel.normalized_uri, sentinel.normalized_path, sentinel.display_path, sentinel.artifact_kind, canonicalBytes(sentinel)],
  );
  const artifactSql = (await database.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'source_artifacts'"))?.sql ?? "";
  const tombstoneSql = (await database.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'artifact_tombstones'"))?.sql ?? "";
  await database.close();
  return { artifactSql, tombstoneSql };
}

function readResponse(observation: ProviderObservation, bytes: Uint8Array, outcome = "success"): SourceProviderResponseEnvelope {
  if (outcome !== "success") return envelope(observation.workspace_id, "read", outcome, undefined, observation.source_provider);
  return envelope(observation.workspace_id, "read", "success", {
    artifact_id: observation.artifact_id,
    provider_version_token: observation.provider_version_token,
    content_bytes: Buffer.from(bytes).toString("base64"),
    content_hash: observation.observed_content_hash,
    byte_length: bytes.byteLength,
    metadata_digest: observation.observed_metadata_digest,
  }, observation.source_provider);
}

function readFixture(entries: Readonly<Record<string, Uint8Array | string>>) {
  return async (observation: ProviderObservation): Promise<SourceProviderResponseEnvelope> => {
    const value = entries[observation.normalized_uri];
    if (typeof value === "string") return readResponse(observation, new Uint8Array(), value);
    if (!value) return readResponse(observation, new Uint8Array(), "unavailable");
    return readResponse(observation, value);
  };
}

describe("Phase 7 generic source indexing", () => {
  it("indexes exact UTF-8 bytes from a non-Git source", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:initial");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const sourceCommit = vi.spyOn(opened.sourceIndex, "commit");
    const candidatePublication = vi.spyOn(opened, "publishCandidate");
    const bytes = new TextEncoder().encode("phase-seven needle\n");
    const observation = providerObservation(registration.workspace_id, "batch:initial", "notes/readme.txt", bytes);

    const result = await testIndexer(opened).apply({
      response: batchResponse(registration.workspace_id, "batch:initial", [observation]),
      read: readFixture({ [observation.normalized_uri]: bytes }),
    });

    expect(result).toMatchObject({ status: "published", generation: 1 });
    expect(sourceCommit).not.toHaveBeenCalled();
    expect(candidatePublication).toHaveBeenCalledTimes(1);
    const indexed = await currentVersion(opened, observation.artifact_id);
    expect(indexed?.content_hash).toBe(digestBytes(bytes));
    expect(new TextDecoder().decode((await storage.cas.read(indexed?.content_hash ?? "missing")).slice(12, 18))).toBe("needle");
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_observations"))?.count).toBe(1);
    expect(await opened.database.get<{ artifact_id: string; artifact_kind: string; observed_artifact_id: string }>(
      "SELECT artifact.artifact_id, artifact.artifact_kind, observation.artifact_id AS observed_artifact_id FROM source_artifacts AS artifact JOIN source_observations AS observation USING (workspace_id, artifact_id)",
    )).toEqual({ artifact_id: observation.artifact_id, artifact_kind: "physical_file", observed_artifact_id: observation.artifact_id });
    const content = await opened.database.get<{ content_hash: string }>("SELECT content_hash FROM artifact_versions");
    expect(await storage.cas.read(content?.content_hash ?? "missing")).toEqual(bytes);
    await opened.close();
    await storage.close();
  });

  // Regression test: a legitimately empty (0-byte) source file's `content_bytes`
  // is base64-encoded to the empty string `""` (there are no bytes to encode).
  // `readAll`'s validation previously used `requiredString`, which rejects any
  // empty string as "missing", for this field -- conflating "the provider
  // omitted content_bytes" with "the provider correctly reported a 0-byte
  // file". This is not a synthetic edge case: real repositories routinely
  // contain empty files (`.gitkeep`, empty `.d.ts`/ignore-file stubs), so a
  // full real-workspace scan that observes even one of them used to throw
  // `engine:source_index_result_invalid` and abort the whole scan.
  it("indexes a legitimately empty (0-byte) source file instead of rejecting its empty content_bytes", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:empty-file");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const bytes = new Uint8Array();
    const observation = providerObservation(registration.workspace_id, "batch:empty-file", "empty.txt", bytes);

    const result = await testIndexer(opened).apply({
      response: batchResponse(registration.workspace_id, "batch:empty-file", [observation]),
      read: readFixture({ [observation.normalized_uri]: bytes }),
    });

    expect(result).toMatchObject({ status: "published", generation: 1 });
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    const version = await opened.database.get<{ byte_length: number; content_hash: string }>("SELECT byte_length, content_hash FROM artifact_versions");
    expect(version?.byte_length).toBe(0);
    expect(await storage.cas.read(version?.content_hash ?? "missing")).toEqual(bytes);
    await opened.close();
    await storage.close();
  });

  it("closes the prior immutable version when text changes", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:update");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const before = new TextEncoder().encode("alpha value");
    const after = new TextEncoder().encode("beta value");
    const first = providerObservation(registration.workspace_id, "batch:one", "file.txt", before);
    const second = providerObservation(registration.workspace_id, "batch:two", "file.txt", after, "metadata:two");
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:one", [first]), read: readFixture({ "file.txt": before }) });
    const firstVersion = await currentVersion(opened, first.artifact_id);

    const result = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:two", [second]), read: readFixture({ "file.txt": after }) });

    expect(result).toMatchObject({ status: "published", generation: 2 });
    const currentAfterUpdate = await currentVersion(opened, first.artifact_id);
    expect(currentAfterUpdate?.content_hash).toBe(digestBytes(after));
    expect(await versionAtGeneration(opened, first.artifact_id, 1)).toMatchObject({ artifact_version_id: firstVersion?.artifact_version_id, content_hash: digestBytes(before) });
    const versions = await opened.database.all<{ artifact_id: string; artifact_version_id: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT artifact_id, artifact_version_id, valid_from_generation, valid_to_generation FROM artifact_versions ORDER BY valid_from_generation");
    expect(versions).toEqual([
      expect.objectContaining({ artifact_id: versions[0]?.artifact_id, artifact_version_id: firstVersion?.artifact_version_id, valid_from_generation: 1, valid_to_generation: 2 }),
      expect.objectContaining({ artifact_id: versions[0]?.artifact_id, valid_from_generation: 2, valid_to_generation: null }),
    ]);
    await opened.close();
    await storage.close();
  });

  it("advances the checkpoint for an equivalent complete result without an empty generation", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:equivalent");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const bytes = new TextEncoder().encode("same bytes");
    const first = providerObservation(registration.workspace_id, "batch:one", "same.txt", bytes);
    const second = providerObservation(registration.workspace_id, "batch:two", "same.txt", bytes);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:one", [first]), read: readFixture({ "same.txt": bytes }) });
    const before = await opened.database.get<{ current_generation: number; checkpoint_id: string }>("SELECT current_generation, checkpoint_id FROM source_index_state");

    const result = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:two", [second]), read: readFixture({ "same.txt": bytes }) });

    const after = await opened.database.get<{ current_generation: number; checkpoint_id: string }>("SELECT current_generation, checkpoint_id FROM source_index_state");
    expect(result).toMatchObject({ status: "equivalent", generation: 1 });
    expect(after?.current_generation).toBe(1);
    expect(after?.checkpoint_id).not.toBe(before?.checkpoint_id);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_observation_batches"))?.count).toBe(2);
    await opened.close();
    await storage.close();
  });

  it("rejects a tampered canonical observation-batch digest without mutating visible state", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:tampered-batch");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const bytes = new TextEncoder().encode("digest protected");
    const first = providerObservation(registration.workspace_id, "batch:valid", "digest.txt", bytes);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:valid", [first]), read: readFixture({ "digest.txt": bytes }) });
    const beforeState = await opened.database.get<Record<string, unknown>>("SELECT * FROM source_index_state");
    const second = providerObservation(registration.workspace_id, "batch:tampered", "digest.txt", bytes);
    const validResponse = batchResponse(registration.workspace_id, "batch:tampered", [second]);
    const validPayload = validResponse.payload as Record<string, JsonValue>;
    const encoded = JSON.parse(String(validPayload["observation_batch"])) as { batch: Record<string, JsonValue>; observations: JsonValue[] };
    encoded.batch["batch_digest"] = `sha256:${"0".repeat(64)}`;
    const tamperedResponse = { ...validResponse, payload: { ...validPayload, observation_batch: JSON.stringify(encoded) } };

    await expect(indexer.apply({ response: tamperedResponse, read: readFixture({ "digest.txt": bytes }) })).rejects.toMatchObject({ code: "engine:source_index_result_invalid" });

    expect(await opened.database.get<Record<string, unknown>>("SELECT * FROM source_index_state")).toEqual(beforeState);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_observation_batches"))?.count).toBe(1);
    expect((await currentVersion(opened, first.artifact_id))?.content_hash).toBe(digestBytes(bytes));
    await opened.close();
    await storage.close();
  });

  it("publishes authoritative absence and identical reappearance as separate lifecycle generations", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:reappear");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const bytes = new TextEncoder().encode("returning text");
    const first = providerObservation(registration.workspace_id, "batch:present", "return.txt", bytes);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:present", [first]), read: readFixture({ "return.txt": bytes }) });
    const before = await versionAtGeneration(opened, first.artifact_id, 1);

    const deletion = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:absent", []), read: readFixture({}) });
    expect(deletion).toMatchObject({ status: "published", generation: 2 });
    expect(await currentVersion(opened, first.artifact_id)).toBeUndefined();
    expect(await opened.database.get<{ absence_kind: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT absence_kind, valid_from_generation, valid_to_generation FROM artifact_tombstones")).toEqual({ absence_kind: "deleted", valid_from_generation: 2, valid_to_generation: null });

    const again = providerObservation(registration.workspace_id, "batch:again", "return.txt", bytes);
    const reappearance = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:again", [again]), read: readFixture({ "return.txt": bytes }) });
    const after = await currentVersion(opened, first.artifact_id);
    expect(reappearance).toMatchObject({ status: "published", generation: 3 });
    expect(after?.artifact_id).toBe(before?.artifact_id);
    expect(after?.artifact_id).toBe(first.artifact_id);
    expect(after?.artifact_version_id).not.toBe(before?.artifact_version_id);
    expect(await opened.database.get<{ valid_to_generation: number; replacement_artifact_version_id: string }>("SELECT valid_to_generation, replacement_artifact_version_id FROM artifact_tombstones")).toEqual({ valid_to_generation: 3, replacement_artifact_version_id: after?.artifact_version_id });
    const hashes = await opened.database.all<{ content_hash: string }>("SELECT content_hash FROM artifact_versions ORDER BY valid_from_generation");
    expect(hashes.map(({ content_hash }) => content_hash)).toEqual([digestBytes(bytes), digestBytes(bytes)]);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts WHERE normalized_uri = 'return.txt'"))?.count).toBe(1);
    expect(JSON.parse((await opened.database.get<{ cause_references: string }>("SELECT cause_references FROM artifact_tombstones"))?.cause_references ?? "[]")).toEqual([
      { cause_type: "artifact_version", cause_id: before?.artifact_version_id },
    ]);
    await opened.close();
    await storage.close();
  });

  it("keeps missing artifacts visible for stable partial results and reports degraded freshness", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:partial");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const alpha = new TextEncoder().encode("alpha retained");
    const beta = new TextEncoder().encode("beta retained");
    const first = providerObservation(registration.workspace_id, "batch:full", "alpha.txt", alpha);
    const second = providerObservation(registration.workspace_id, "batch:full", "beta.txt", beta);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:full", [first, second]), read: readFixture({ "alpha.txt": alpha, "beta.txt": beta }) });
    const partial = providerObservation(registration.workspace_id, "batch:partial", "alpha.txt", alpha);

    const result = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:partial", [partial], { complete: false, authoritative: false }), read: readFixture({ "alpha.txt": alpha }) });

    expect(result).toMatchObject({ status: "degraded", generation: 1, retryable: true });
    expect((await currentVersion(opened, second.artifact_id))?.content_hash).toBe(digestBytes(beta));
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_tombstones"))?.count).toBe(0);
    await opened.close();
    await storage.close();
  });

  it("limits authoritative absence inference to the advertised complete coverage scopes", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:scoped-delete");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const firstBytes = new TextEncoder().encode("first scope text");
    const secondBytes = new TextEncoder().encode("second scope text");
    const first = providerObservation(registration.workspace_id, "batch:both", "scope-a/first.txt", firstBytes);
    const second = providerObservation(registration.workspace_id, "batch:both", "scope-b/second.txt", secondBytes);
    const bothScopes = [
      { scope_type: "uri_prefix", source_provider_binding_id: "binding:one", source_provider: "core:directory_source_provider", normalized_scope_key: "scope-a" },
      { scope_type: "uri_prefix", source_provider_binding_id: "binding:one", source_provider: "core:directory_source_provider", normalized_scope_key: "scope-b" },
    ] as const;
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:both", [first, second], { scopes: bothScopes }), read: readFixture({ "scope-a/first.txt": firstBytes, "scope-b/second.txt": secondBytes }) });

    const result = await indexer.apply({
      response: batchResponse(registration.workspace_id, "batch:scope-a-empty", [], { scopes: [bothScopes[0]] }),
      read: readFixture({}),
    });

    expect(result).toMatchObject({ status: "published", generation: 2 });
    expect(await currentVersion(opened, first.artifact_id)).toBeUndefined();
    expect((await currentVersion(opened, second.artifact_id))?.content_hash).toBe(digestBytes(secondBytes));
    expect(await opened.database.all<{ normalized_uri: string }>("SELECT source_artifacts.normalized_uri FROM artifact_tombstones JOIN source_artifacts USING (artifact_id) ORDER BY normalized_uri")).toEqual([{ normalized_uri: "scope-a/first.txt" }]);
    await opened.close();
    await storage.close();
  });

  it("preserves the last visible state for unstable, unavailable, and failed-read outcomes", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:degraded");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const before = new TextEncoder().encode("last published");
    const changed = new TextEncoder().encode("must not publish");
    const first = providerObservation(registration.workspace_id, "batch:one", "state.txt", before);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:one", [first]), read: readFixture({ "state.txt": before }) });
    const raced = providerObservation(registration.workspace_id, "batch:raced", "state.txt", changed, "metadata:raced");
    const failedRead = providerObservation(registration.workspace_id, "batch:read-failed", "state.txt", changed, "metadata:raced");

    await expect(indexer.apply({ response: batchResponse(registration.workspace_id, "batch:raced", [raced], { stable: false }), read: readFixture({ "state.txt": changed }) })).resolves.toMatchObject({ status: "degraded" });
    await expect(indexer.apply({ response: envelope(registration.workspace_id, "reconcile", "unavailable") })).resolves.toMatchObject({ status: "degraded" });
    await expect(indexer.apply({ response: batchResponse(registration.workspace_id, "batch:read-failed", [failedRead]), read: readFixture({ "state.txt": "source_changed" }) })).resolves.toMatchObject({ status: "degraded" });
    expect((await currentVersion(opened, first.artifact_id))?.content_hash).toBe(digestBytes(before));
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    await opened.close();
    await storage.close();
  });

  function withScrambledDelay(
    read: (observation: ProviderObservation) => Promise<SourceProviderResponseEnvelope>,
    delaysMsByUri: Readonly<Record<string, number>>,
  ): (observation: ProviderObservation) => Promise<SourceProviderResponseEnvelope> {
    return async (observation) => {
      const delayMs = delaysMsByUri[observation.normalized_uri] ?? 0;
      if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      return read(observation);
    };
  }

  it("bounded-concurrency readAll degrades a batch on the first non-success outcome even when it is not the first to settle", async () => {
    // Guards Phase 4.1's `readAll` (packages/engine/src/source-indexer.ts):
    // reads are now issued with bounded concurrency (`mapWithConcurrency`),
    // so completion order no longer matches array order. The COMMITTED
    // result must still match a strictly sequential `for await`: any
    // non-success outcome degrades the whole batch, and nothing from it is
    // committed -- regardless of which read happened to settle first.
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:concurrent-degrade");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const uris = ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"];
    const bytesByUri = new Map(uris.map((uri) => [uri, new TextEncoder().encode(`published ${uri}`)]));
    const observations = uris.map((uri) => providerObservation(registration.workspace_id, "batch:degrade", uri, bytesByUri.get(uri)!));
    // "gamma.txt" (array index 2) is the only failing read, and is made the
    // FASTEST to settle (0ms, versus 5-15ms for the successful ones): if
    // `readAll` decided the outcome by completion order instead of scanning
    // the ordered result array for the first non-"value" entry, this would
    // still happen to degrade (it's the only failure either way) -- the
    // real point is that nothing from the successful, slower reads leaks
    // into a committed result.
    const baseRead = readFixture({
      "alpha.txt": bytesByUri.get("alpha.txt")!,
      "beta.txt": bytesByUri.get("beta.txt")!,
      "gamma.txt": "unavailable",
      "delta.txt": bytesByUri.get("delta.txt")!,
    });
    const scrambled = withScrambledDelay(baseRead, { "alpha.txt": 15, "beta.txt": 10, "gamma.txt": 0, "delta.txt": 5 });

    const result = await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:degrade", observations), read: scrambled, io_concurrency: 4 });

    expect(result).toMatchObject({ status: "degraded", generation: 0, retryable: true, error_code: "core:source_provider_read_incomplete" });
    expect(await opened.projections.searchLiteral("published alpha")).toEqual([]);
    expect(await opened.projections.searchLiteral("published delta")).toEqual([]);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(0);
    await opened.close();
    await storage.close();
  });

  it("bounded-concurrency readAll throws the same invalid-correlation error as a sequential run, without partially committing", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:concurrent-invalid");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const uris = ["one.txt", "two.txt", "three.txt"];
    const bytesByUri = new Map(uris.map((uri) => [uri, new TextEncoder().encode(`ok ${uri}`)]));
    const observations = uris.map((uri) => providerObservation(registration.workspace_id, "batch:invalid", uri, bytesByUri.get(uri)!));
    const baseRead = readFixture({ "one.txt": bytesByUri.get("one.txt")!, "three.txt": bytesByUri.get("three.txt")! });
    const mismatchedRead = async (observation: ProviderObservation): Promise<SourceProviderResponseEnvelope> => {
      if (observation.normalized_uri !== "two.txt") return baseRead(observation);
      // A "success" read response whose artifact identity does not agree
      // with the observation it answers -- `readAll` must throw
      // `engine:source_index_read_invalid` for this, exactly as the
      // pre-concurrency sequential implementation did.
      return envelope(observation.workspace_id, "read", "success", {
        artifact_id: "provider-artifact:wrong-identity",
        provider_version_token: observation.provider_version_token,
        content_bytes: Buffer.from(new TextEncoder().encode("mismatched")).toString("base64"),
        content_hash: observation.observed_content_hash,
        byte_length: new TextEncoder().encode("mismatched").byteLength,
        metadata_digest: observation.observed_metadata_digest,
      }, observation.source_provider);
    };
    // "two.txt" (the invalid one) settles fastest; "one.txt"/"three.txt" are
    // deliberately slower, so the invalid read is not first-to-complete
    // either -- only first-in-array-order, matching what a sequential
    // `for await` would have reached.
    const scrambled = withScrambledDelay(mismatchedRead, { "one.txt": 10, "two.txt": 0, "three.txt": 8 });

    await expect(indexer.apply({ response: batchResponse(registration.workspace_id, "batch:invalid", observations), read: scrambled, io_concurrency: 4 }))
      .rejects.toMatchObject({ code: "engine:source_index_read_invalid" });
    expect(await opened.projections.searchLiteral("ok one")).toEqual([]);
    expect(await opened.projections.searchLiteral("ok three")).toEqual([]);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(0);
    await opened.close();
    await storage.close();
  });

  it("retains binary source state without creating a lexical document", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:binary");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const observation = providerObservation(registration.workspace_id, "batch:binary", "asset.bin", bytes);

    const result = await testIndexer(opened).apply({ response: batchResponse(registration.workspace_id, "batch:binary", [observation]), read: readFixture({ "asset.bin": bytes }) });

    expect(result).toMatchObject({ status: "published", generation: 1 });
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_documents"))?.count).toBe(0);
    await opened.close();
    await storage.close();
  });

  it("uses the closed virtual artifact kind for Git-reference source addresses", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:virtual-kind");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const bytes = new TextEncoder().encode("virtual source");
    const provider = "core:git_reference_source_provider";
    const observation = providerObservation(registration.workspace_id, "batch:virtual", "git-ref:src/virtual.ts", bytes, "metadata:virtual", provider);

    await testIndexer(opened).apply({
      response: batchResponse(registration.workspace_id, "batch:virtual", [observation], { source_provider: provider }),
      read: readFixture({ [observation.normalized_uri]: bytes }),
    });

    expect(await opened.database.get<{ artifact_id: string; artifact_kind: string }>("SELECT artifact_id, artifact_kind FROM source_artifacts")).toEqual({ artifact_id: observation.artifact_id, artifact_kind: "virtual_file" });
    await opened.close();
    await storage.close();
  });

  it("persists source state across storage restart", async () => {
    const { root, storage } = await temporaryStorage();
    const registration = workspace("workspace:restart");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const bytes = new TextEncoder().encode("restart survives");
    const observation = providerObservation(registration.workspace_id, "batch:restart", "restart.txt", bytes);
    await testIndexer(opened).apply({ response: batchResponse(registration.workspace_id, "batch:restart", [observation]), read: readFixture({ "restart.txt": bytes }) });
    await opened.close();
    await storage.close();

    const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
    const reopened = await restarted.openWorkspace(registration.workspace_id);
    expect((await currentVersion(reopened, observation.artifact_id))?.content_hash).toBe(digestBytes(bytes));
    expect(await reopened.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state")).toEqual({ current_generation: 1 });
    await reopened.close();
    await restarted.close();
  });

  it("keeps workspace ownership independent while sharing identical CAS bytes", async () => {
    const { storage } = await temporaryStorage();
    const firstWorkspace = workspace("workspace:first");
    const secondWorkspace = workspace("workspace:second");
    await storage.catalog.registerWorkspace(firstWorkspace);
    await storage.catalog.registerWorkspace(secondWorkspace);
    const firstOpened = await storage.openWorkspace(firstWorkspace.workspace_id);
    const secondOpened = await storage.openWorkspace(secondWorkspace.workspace_id);
    const bytes = new TextEncoder().encode("shared physical bytes");
    const firstObservation = providerObservation(firstWorkspace.workspace_id, "batch:first", "shared.txt", bytes);
    const secondObservation = providerObservation(secondWorkspace.workspace_id, "batch:second", "shared.txt", bytes);
    await testIndexer(firstOpened).apply({ response: batchResponse(firstWorkspace.workspace_id, "batch:first", [firstObservation]), read: readFixture({ "shared.txt": bytes }) });
    await testIndexer(secondOpened).apply({ response: batchResponse(secondWorkspace.workspace_id, "batch:second", [secondObservation]), read: readFixture({ "shared.txt": bytes }) });

    const firstMatch = await currentVersion(firstOpened, firstObservation.artifact_id);
    const secondMatch = await currentVersion(secondOpened, secondObservation.artifact_id);
    expect(firstMatch?.artifact_id).toBe(firstObservation.artifact_id);
    expect(secondMatch?.artifact_id).toBe(secondObservation.artifact_id);
    expect(firstMatch?.artifact_version_id).not.toBe(secondMatch?.artifact_version_id);
    const firstHash = await firstOpened.database.get<{ content_hash: string }>("SELECT content_hash FROM artifact_versions");
    const secondHash = await secondOpened.database.get<{ content_hash: string }>("SELECT content_hash FROM artifact_versions");
    expect(firstHash?.content_hash).toBe(secondHash?.content_hash);
    expect((await storage.catalog.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_cas_objects WHERE content_hash = ?", [firstHash?.content_hash ?? "missing"]))?.count).toBe(1);
    await firstOpened.close();
    await secondOpened.close();
    await storage.close();
  });

  it("rolls back source changes atomically when the commit fails", async () => {
    const { root, storage } = await temporaryStorage();
    const registration = workspace("workspace:atomic");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const before = new TextEncoder().encode("atomic before");
    const first = providerObservation(registration.workspace_id, "batch:before", "atomic.txt", before);
    await testIndexer(opened).apply({ response: batchResponse(registration.workspace_id, "batch:before", [first]), read: readFixture({ "atomic.txt": before }) });
    await opened.close();
    await storage.close();

    const faulted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8, fault_injector: createFaultInjector(["source_index.before_commit"]) });
    const faultedWorkspace = await faulted.openWorkspace(registration.workspace_id);
    const after = new TextEncoder().encode("atomic after");
    const second = providerObservation(registration.workspace_id, "batch:after", "atomic.txt", after, "metadata:after");
    await expect(testIndexer(faultedWorkspace).apply({ response: batchResponse(registration.workspace_id, "batch:after", [second]), read: readFixture({ "atomic.txt": after }) })).rejects.toMatchObject({ code: "storage:fault_injected" });

    expect((await currentVersion(faultedWorkspace, first.artifact_id))?.content_hash).toBe(digestBytes(before));
    expect((await faultedWorkspace.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    expect(await faultedWorkspace.database.get<{ current_generation: number }>("SELECT current_generation FROM source_index_state")).toEqual({ current_generation: 1 });
    await faultedWorkspace.close();
    await faulted.close();
  });

  it("persists only authoritative_delete watch events as canonical deleted observations and advances duplicate freshness", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:watch-delete");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const bytes = new TextEncoder().encode("watch retained");
    const observation = providerObservation(registration.workspace_id, "batch:watch", "watch.txt", bytes);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:watch", [observation]), read: readFixture({ "watch.txt": bytes }) });
    const hint = envelope(registration.workspace_id, "watch", "success", { events: [{ ordering_domain: "binding:one", event_token: "hint:one", provider_sequence: "2", event_class: "deleted", normalized_uri: "watch.txt", authority: "hint" }], watermark: "watermark:hint" });
    const wrongAuthority = envelope(registration.workspace_id, "watch", "success", { events: [{ ordering_domain: "binding:one", event_token: "wrong:one", provider_sequence: "3", event_class: "deleted", normalized_uri: "watch.txt", authority: "authoritative" }], watermark: "watermark:wrong" });
    const deletion = envelope(registration.workspace_id, "watch", "success", { events: [{ ordering_domain: "binding:one", event_class: "deleted", normalized_uri: "watch.txt", authority: "authoritative_delete" }], watermark: "watermark:deleted" });

    await expect(indexer.apply({ response: hint, supports_authoritative_delete_events: true })).resolves.toMatchObject({ status: "degraded", generation: 1 });
    await expect(indexer.apply({ response: wrongAuthority, supports_authoritative_delete_events: true })).resolves.toMatchObject({ status: "degraded", generation: 1 });
    expect((await currentVersion(opened, observation.artifact_id))?.content_hash).toBe(digestBytes(bytes));
    await expect(indexer.apply({ response: deletion, supports_authoritative_delete_events: true })).resolves.toMatchObject({ status: "published", generation: 2 });
    expect(await currentVersion(opened, observation.artifact_id)).toBeUndefined();
    expect(await opened.database.get<{ absence_kind: string }>("SELECT absence_kind FROM artifact_tombstones")).toEqual({ absence_kind: "deleted" });
    const retainedCause = await opened.database.get<{ cause_references: string }>("SELECT cause_references FROM artifact_tombstones");
    const retainedBatch = await opened.database.get<{ observation_batch_id: string; observation_mode: string; deletion_authority: string; coverage_scopes: string; observation_count: number; batch_digest: string }>("SELECT observation_batch_id, observation_mode, deletion_authority, coverage_scopes, observation_count, batch_digest FROM source_observation_batches WHERE observation_mode = 'event'");
    const deletedObservation = await opened.database.get<{ source_observation_id: string; observation_batch_id: string; artifact_id: string; observation_mode: string; observed_state: string; observed_content_hash: string | null }>("SELECT source_observation_id, observation_batch_id, artifact_id, observation_mode, observed_state, observed_content_hash FROM source_observations WHERE observed_state = 'deleted'");
    expect(retainedBatch).toMatchObject({ observation_mode: "event", deletion_authority: "none", observation_count: 1 });
    expect(JSON.parse(retainedBatch?.coverage_scopes ?? "[]")).toEqual([{ scope_type: "artifact", source_provider_binding_id: "binding:one", source_provider: "core:directory_source_provider", normalized_scope_key: "watch.txt" }]);
    expect(deletedObservation).toMatchObject({ observation_batch_id: retainedBatch?.observation_batch_id, artifact_id: observation.artifact_id, observation_mode: "event", observed_state: "deleted", observed_content_hash: null });
    expect(JSON.parse(retainedCause?.cause_references ?? "[]")).toEqual([{ cause_type: "source_observation", cause_id: deletedObservation?.source_observation_id }]);
    const canonicalBatch = await opened.repositories.sourceCatalog.getObservationBatch(retainedBatch?.observation_batch_id ?? "missing");
    const canonicalObservation = await opened.repositories.sourceCatalog.getObservation(deletedObservation?.source_observation_id ?? "missing");
    expect(sourceObservationBatchDigest({ ...canonicalBatch!, provider_cursor_before: canonicalBatch?.provider_cursor_before ?? "", provider_cursor_after: canonicalBatch?.provider_cursor_after ?? "" }, [canonicalObservation!])).toBe(canonicalBatch?.batch_digest);
    const beforeDuplicate = await opened.database.get<{ current_generation: number; checkpoint_id: string }>("SELECT current_generation, checkpoint_id FROM source_index_state");
    const duplicate = envelope(registration.workspace_id, "watch", "success", { events: [{ ordering_domain: "binding:one", event_class: "deleted", normalized_uri: "watch.txt", authority: "authoritative_delete" }], watermark: "watermark:duplicate" });

    await expect(indexer.apply({ response: duplicate, supports_authoritative_delete_events: true })).resolves.toMatchObject({ status: "equivalent", generation: 2 });

    const afterDuplicate = await opened.database.get<{ current_generation: number; checkpoint_id: string }>("SELECT current_generation, checkpoint_id FROM source_index_state");
    expect(afterDuplicate?.current_generation).toBe(2);
    expect(afterDuplicate?.checkpoint_id).not.toBe(beforeDuplicate?.checkpoint_id);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_observation_batches"))?.count).toBe(3);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_observations"))?.count).toBe(3);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_tombstones"))?.count).toBe(1);
    await opened.close();
    await storage.close();
  });

  it("keeps the authoritative legacy source schema unchanged and reappears on the same artifact", async () => {
    const { root, storage } = await temporaryStorage();
    const registration = workspace("workspace:legacy-source-schema");
    const registered = await storage.catalog.registerWorkspace(registration);
    await storage.close();
    const legacySchema = await installLegacySourceSchema(registered.database_path, registration.workspace_id);

    const restarted = await createDurableStorage({ rootDir: root, inlineThresholdBytes: 8 });
    const opened = await restarted.openWorkspace(registration.workspace_id);
    const indexer = testIndexer(opened);
    const bytes = new TextEncoder().encode("legacy returns");
    const first = providerObservation(registration.workspace_id, "batch:legacy-first", "legacy.txt", bytes);
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:legacy-first", [first]), read: readFixture({ "legacy.txt": bytes }) });
    await indexer.apply({ response: batchResponse(registration.workspace_id, "batch:legacy-absent", []), read: readFixture({}) });
    const again = providerObservation(registration.workspace_id, "batch:legacy-again", "legacy.txt", bytes);

    await expect(indexer.apply({ response: batchResponse(registration.workspace_id, "batch:legacy-again", [again]), read: readFixture({ "legacy.txt": bytes }) })).resolves.toMatchObject({ status: "published", generation: 3 });

    expect((await opened.database.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'source_artifacts'"))?.sql).toBe(legacySchema.artifactSql);
    expect((await opened.database.get<{ sql: string }>("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'artifact_tombstones'"))?.sql).toBe(legacySchema.tombstoneSql);
    const uniqueIndexes = await opened.database.all<{ name: string; unique: number }>("PRAGMA index_list(source_artifacts)");
    const uniqueColumnSets = await Promise.all(uniqueIndexes.filter((index) => index.unique === 1).map(async (index) => (await opened.database.all<{ name: string }>(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`)).map((column) => column.name)));
    expect(uniqueColumnSets).toContainEqual(["workspace_id", "normalized_uri"]);
    const foreignKeys = await opened.database.all<{ id: number; table: string; from: string; to: string }>("PRAGMA foreign_key_list(artifact_tombstones)");
    const replacement = foreignKeys.find((foreignKey) => foreignKey.from === "replacement_artifact_version_id");
    expect(foreignKeys.filter((foreignKey) => foreignKey.id === replacement?.id).map(({ from, to }) => ({ from, to }))).toEqual(expect.arrayContaining([
      { from: "workspace_id", to: "workspace_id" },
      { from: "replacement_artifact_version_id", to: "artifact_version_id" },
    ]));
    expect(foreignKeys.filter((foreignKey) => foreignKey.id === replacement?.id).map(({ from }) => from)).toContain("artifact_id");
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts WHERE normalized_uri = 'legacy.txt'"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(DISTINCT artifact_id) AS count FROM artifact_versions WHERE workspace_id = ?", [registration.workspace_id]))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts WHERE artifact_id = 'legacy-sentinel'"))?.count).toBe(1);
    await opened.close();
    await restarted.close();
  });

  // The scan path never writes lexical rows at all (see the top-of-file
  // comment): lexical projections are built entirely by an out-of-band
  // post-ready job from committed artifact_versions content, so a scan --
  // including one committing a single very large document -- must write
  // zero rows to `lexical_documents`/`lexical_trigrams`, and the resulting
  // publication must still pass `StorageMaintenance.verify()` with zero
  // issues: `projectionSetDigestEntries` (`packages/storage/src/lifecycle.ts`)
  // live-queries those tables at both publish time and verify time, so an
  // always-absent lexical projection set must produce the same "lexical"
  // digest entry a genuinely-empty one would -- no special-casing required,
  // but this is the regression test that proves it stays true.
  it("writes zero lexical rows and still passes verifyIntegrity for any scan", async () => {
    const { storage } = await temporaryStorage();
    const registration = workspace("workspace:lexical-off");
    await storage.catalog.registerWorkspace(registration);
    const opened = await storage.openWorkspace(registration.workspace_id);
    const bytes = new TextEncoder().encode("needle should not be indexed\n");
    const observation = providerObservation(registration.workspace_id, "batch:lexical-off", "notes/off.txt", bytes);

    const result = await new GenericSourceIndexer(opened).apply({
      response: batchResponse(registration.workspace_id, "batch:lexical-off", [observation]),
      read: readFixture({ [observation.normalized_uri]: bytes }),
    });

    expect(result).toMatchObject({ status: "published", generation: 1 });
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_versions"))?.count).toBe(1);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_documents"))?.count).toBe(0);
    expect((await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM lexical_trigrams"))?.count).toBe(0);
    expect(await opened.projections.searchLiteral("needle")).toEqual([]);
    const report = await opened.maintenance.verify();
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    await opened.close();
    await storage.close();
  });
});
