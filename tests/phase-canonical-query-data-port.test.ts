import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCanonical } from "@urdira/canonical";
import type { QueryScope } from "@urdira/contracts";
import { createDurableStorage, type SqliteCommand, type SqliteDatabase, type SqliteRunResult, type SqliteValue } from "../packages/storage/src/index.js";
import {
  CanonicalRecordQueryDataPort,
  QueryPlanError,
  RecordBodyInterner,
  SqliteCanonicalQuerySnapshotPort,
  createLocalHashProvider,
  type CanonicalQueryRecord,
  type CanonicalQuerySnapshotPort,
  type ResolvedSemanticProvider,
} from "../packages/engine/src/index.js";

const now = "2026-08-12T00:00:00.000Z";

const workspace = {
  workspace_id: "ws-canonical-query",
  canonical_root: "/canonical-query",
  display_root: "/canonical-query",
  source_provider_bindings: [],
  status: "registered",
  registered_at: now,
};

async function withWorkspace(test: (opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-canonical-query-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    try { await test(opened); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

// Seeds the tables `SqliteCanonicalQuerySnapshotPort` reads from directly, with
// foreign keys off so this doesn't have to also stand up the full source-catalog
// / candidate-publication chain those tables reference in production.
async function seedBaseline(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>): Promise<void> {
  const db = opened.database;
  await db.exec("PRAGMA foreign_keys = OFF");
  await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", ["registry-1", workspace.workspace_id, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
  await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["snapshot-1", workspace.workspace_id, 0, "manifest-1", "registry-1", "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, "snapshot-digest-1", new Uint8Array([1])]);
  await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspace.workspace_id, "snapshot-1", 1, "registry-1", "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
}

function recordPayload(body: Readonly<Record<string, unknown>>): Uint8Array {
  return encodeCanonical({ body });
}

async function insertRecordOccurrence(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, recordId: string, ownerArtifactVersionId: string, validFromGeneration: number, body: Readonly<Record<string, unknown>>): Promise<void> {
  const payload = recordPayload(body);
  await opened.database.run(
    "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES (?, ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, 'payload-digest', ?, ?, NULL, ?)",
    [recordId, workspace.workspace_id, ownerArtifactVersionId, validFromGeneration, `digest-${recordId}`, payload.byteLength, payload, payload],
  );
}

async function insertArtifactVersion(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactVersionId: string, contentHash: string, encoding: string, artifactId = "art-1", normalizedPath = "src/index.ts", artifactKind = "source_file", languageHint: string | null = null): Promise<void> {
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [artifactId, workspace.workspace_id, `file:///canonical-query/${normalizedPath}`, normalizedPath, normalizedPath, artifactKind, new Uint8Array([1])]);
  await opened.database.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob-${artifactVersionId}`, contentHash, 0, "inline"]);
  await opened.database.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'metadata-digest', 'observation-1', 0, NULL, ?)", [artifactVersionId, workspace.workspace_id, artifactId, `blob-${artifactVersionId}`, contentHash, encoding, languageHint, new Uint8Array([1])]);
}

// Bulk variant of `insertRecordOccurrence`, batched (100 rows/statement,
// comfortably under SQLite's bound-parameter cap at 8 params/row) so a
// corpus-scale seed (thousands of rows) stays fast to set up.
async function insertRecordOccurrencesBulk(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, count: number, ownerArtifactVersionId: string, validFromGeneration: number): Promise<void> {
  const BATCH = 100;
  for (let start = 0; start < count; start += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, count - start) }, (_unused, offset) => start + offset);
    const params = rows.flatMap((index) => {
      const recordId = `bulk-rec-${String(index).padStart(6, "0")}`;
      const payload = recordPayload({ name: `bulk-${index}` });
      return [recordId, workspace.workspace_id, ownerArtifactVersionId, validFromGeneration, `digest-${recordId}`, payload.byteLength, payload, payload];
    });
    await opened.database.run(
      `INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES ${rows.map(() => "(?, ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, 'payload-digest', ?, ?, NULL, ?)").join(", ")}`,
      params,
    );
  }
}

async function insertCapabilityState(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, stateKey: string, providerId: string, status: string, affectedArtifactIds: readonly string[] = []): Promise<void> {
  const payload = encodeCanonical({ capability: "core:symbol_resolution", capability_contract_version: "1", provider_id: providerId, provider_version: "1", status, reason_codes: [], affected_artifact_ids: affectedArtifactIds, diagnostic_record_ids: [] });
  await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'capability_state', ?, NULL, NULL, NULL, ?)", [stateKey, workspace.workspace_id, payload, now]);
}

const scope: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id };

describe("SqliteCanonicalQuerySnapshotPort generation-keyed caching", () => {
  it("returns the same records array while the generation is unchanged, and a new one after a generation bump", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrence(opened, "rec-1", "artv-1", 1, { name: "one" });
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);

      const first = await port.records(scope);
      const second = await port.records(scope);
      expect(second).toBe(first);
      expect(first).toHaveLength(1);

      await opened.database.run("UPDATE workspace_current_state SET current_generation = 2 WHERE workspace_id = ?", [workspace.workspace_id]);
      await insertRecordOccurrence(opened, "rec-2", "artv-1", 2, { name: "two" });

      const third = await port.records(scope);
      expect(third).not.toBe(first);
      expect(third).toHaveLength(2);

      const fourth = await port.records(scope);
      expect(fourth).toBe(third);
    });
  });

  it("finds visible artifacts with hard filters and deterministic path/identity ordering", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-z", "sha256:zzzz", "utf-8", "art-z", "src/z.ts", "source_file", "typescript");
      await insertArtifactVersion(opened, "artv-a", "sha256:aaaa", "utf-8", "art-a", "src/a.ts", "source_file", "typescript");
      await insertArtifactVersion(opened, "artv-generated", "sha256:gggg", "utf-8", "art-generated", "src/generated.ts", "generated_file", "typescript");
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const all = await port.artifacts_by_filter(scope);
      expect(all.map((item) => item.body["path"])).toEqual(["src/a.ts", "src/z.ts"]);
      const filtered = await port.artifacts_by_filter(scope, { paths: ["src/**/*.ts"], languages: ["typescript"] });
      expect(filtered.map((item) => item.body["path"])).toEqual(["src/a.ts", "src/z.ts"]);
      const generated = await port.artifacts_by_filter(scope, { paths: ["src/generated.ts"], include_generated: true });
      expect(generated.map((item) => item.body["path"])).toEqual(["src/generated.ts"]);
    });
  });

  it("returns the same capability_states array while the generation is unchanged, and a new one after a generation bump", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertCapabilityState(opened, "state-1", "provider-a", "complete");
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);

      const first = await port.capability_states(scope);
      const second = await port.capability_states(scope);
      expect(second).toBe(first);
      expect(first).toHaveLength(1);

      await opened.database.run("UPDATE workspace_current_state SET current_generation = 2 WHERE workspace_id = ?", [workspace.workspace_id]);
      await insertCapabilityState(opened, "state-2", "provider-b", "complete");

      const third = await port.capability_states(scope);
      expect(third).not.toBe(first);
      expect(third).toHaveLength(2);
    });
  });

  it("bounds completeness dimensions before they cross the query transport", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      const affected = Array.from({ length: 20_000 }, (_unused, index) => `sha256:${String(index).padStart(64, "0")}`);
      await insertCapabilityState(opened, "state-large", "provider-large", "partial", affected);
      const port = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database));
      const evaluation = await port.execute({ operation_id: "core:find_artifacts", operation_version: 1, result_streams: ["artifacts"], arguments: { filter: { paths: ["src/**/*.ts"] } }, scope });
      const dimensions = (evaluation.completeness as { dimensions: readonly Record<string, unknown>[] }).dimensions;
      expect(dimensions).toHaveLength(1);
      expect(dimensions[0]).toMatchObject({ affected_artifact_count: affected.length, affected_artifact_ids: affected.slice(0, 8) });
      expect(dimensions[0]?.["affected_artifact_set_id"]).toMatch(/^sha256:/);
      expect(JSON.stringify(evaluation).length).toBeLessThan(256 * 1024);
    });
  });

  it("returns an empty array, uncached, for a workspace without a published generation", async () => {
    await withWorkspace(async (opened) => {
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const result = await port.records(scope);
      expect(result).toEqual([]);
    });
  });
});

// Bug fix: `scope.snapshot_id` (the `SingleWorkspaceScope` pin) used to be
// silently ignored by every read path here -- a query pinned to an old
// snapshot quietly read the CURRENT generation instead. Serving an actually
// historical generation was investigated and rejected (see
// `currentGeneration`'s own doc comment): storage gives no guarantee an
// older generation's rows are still intact, and threading a historical
// generation through every `records_by_*`/`search_literal`/
// `capability_states` method plus the generation-keyed caches here would be
// a much larger change. So a mismatched pin now fails loudly with a
// registered `core:` error instead of ever silently substituting.
describe("SqliteCanonicalQuerySnapshotPort scope.snapshot_id pin", () => {
  async function seedTwoGenerations(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>): Promise<void> {
    const db = opened.database;
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", ["registry-1", workspace.workspace_id, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
    // Two real, permanently-recorded snapshots for this workspace: an old
    // one ("snapshot-0", generation 0) that is no longer current, and the
    // current one ("snapshot-1", generation 1) `workspace_current_state`
    // actually points at.
    for (const [snapshotId, generation] of [["snapshot-0", 0], ["snapshot-1", 1]] as const) {
      await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshotId, workspace.workspace_id, generation, `manifest-${generation}`, "registry-1", "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest-${generation}`, new Uint8Array([1])]);
    }
    await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspace.workspace_id, "snapshot-1", 1, "registry-1", "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
  }

  it("proceeds normally when scope.snapshot_id matches the workspace's current snapshot", async () => {
    await withWorkspace(async (opened) => {
      await seedTwoGenerations(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrence(opened, "rec-1", "artv-1", 1, { name: "one" });
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const pinned: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "snapshot-1" };
      const result = await port.records(pinned);
      expect(result).toHaveLength(1);
    });
  });

  it("rejects a scope.snapshot_id pinned to a superseded (but real) prior snapshot with core:snapshot_expired, naming both ids", async () => {
    await withWorkspace(async (opened) => {
      await seedTwoGenerations(opened);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const pinned: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "snapshot-0" };
      const error = await port.records(pinned).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(QueryPlanError);
      expect((error as QueryPlanError).code).toBe("core:snapshot_expired");
      expect((error as QueryPlanError).message).toContain("snapshot-0");
      expect((error as QueryPlanError).message).toContain("snapshot-1");
    });
  });

  it("rejects a scope.snapshot_id that names no snapshot of this workspace at all with core:snapshot_not_found", async () => {
    await withWorkspace(async (opened) => {
      await seedTwoGenerations(opened);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const pinned: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "snapshot-never-existed" };
      const error = await port.records(pinned).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(QueryPlanError);
      expect((error as QueryPlanError).code).toBe("core:snapshot_not_found");
      expect((error as QueryPlanError).message).toContain("snapshot-never-existed");
      expect((error as QueryPlanError).message).toContain("snapshot-1");
    });
  });

  it("rejects a mismatched pin on the pushdown/dimension methods too, not just records()", async () => {
    await withWorkspace(async (opened) => {
      await seedTwoGenerations(opened);
      await insertCapabilityState(opened, "state-1", "provider-a", "complete");
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const pinned: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "snapshot-0" };
      await expect(port.capability_states(pinned)).rejects.toThrow(QueryPlanError);
      await expect(port.records_by_ids(pinned, ["rec-1"])).rejects.toThrow(QueryPlanError);
      await expect(port.has_warm_records(pinned)).rejects.toThrow(QueryPlanError);
    });
  });

  it("never lets a mismatched pin silently join an in-flight unpinned records() load for the same workspace", async () => {
    await withWorkspace(async (opened) => {
      await seedTwoGenerations(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrence(opened, "rec-1", "artv-1", 1, { name: "one" });
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const unpinned = scope;
      const pinned: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "snapshot-0" };
      // Fire both concurrently: the unpinned load starts the single-flight
      // promise `recordsLoading` keys by workspace id alone; the pinned
      // request must still see its own mismatch, not silently inherit the
      // unpinned request's in-flight answer.
      const [unpinnedResult, pinnedOutcome] = await Promise.all([
        port.records(unpinned),
        port.records(pinned).then(() => ({ ok: true as const }), (caught: unknown) => ({ ok: false as const, error: caught })),
      ]);
      expect(unpinnedResult).toHaveLength(1);
      expect(pinnedOutcome.ok).toBe(false);
      if (!pinnedOutcome.ok) expect((pinnedOutcome.error as QueryPlanError).code).toBe("core:snapshot_expired");
    });
  });
});

// --- Delta-maintenance test infrastructure -------------------------------
//
// `RecordingDatabase` wraps a real `SqliteDatabase`, logging every `get`/`all`
// call's SQL text (and optionally delaying matching calls) so tests can
// assert *which* code path `SqliteCanonicalQuerySnapshotPort.records()` took
// -- a windowed delta (COUNT churn queries, then targeted refresh queries,
// no `1 = 1` full-scan marker) vs. a full reload (the `1 = 1` marker used by
// `loadAllRecords`/`queryRecordRows`'s unconditional-extra-condition call) --
// without needing to change production code just to make it observable.
interface SqlCall { readonly sql: string; readonly params: readonly SqliteValue[]; }

class RecordingDatabase implements SqliteDatabase {
  readonly calls: SqlCall[] = [];
  delayMatcher?: (sql: string) => boolean;
  delayMs = 0;
  constructor(private readonly inner: SqliteDatabase) {}
  get filename(): string { return this.inner.filename; }
  async exec(sql: string): Promise<void> { return this.inner.exec(sql); }
  async run(sql: string, params?: readonly SqliteValue[]): Promise<SqliteRunResult> { return this.inner.run(sql, params); }
  async get<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<T | undefined> {
    this.calls.push({ sql, params: params ?? [] });
    if (this.delayMatcher?.(sql)) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.get<T>(sql, params);
  }
  async all<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<readonly T[]> {
    this.calls.push({ sql, params: params ?? [] });
    if (this.delayMatcher?.(sql)) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.all<T>(sql, params);
  }
  async transaction(commands: readonly SqliteCommand[]): Promise<readonly unknown[]> { return this.inner.transaction(commands); }
  async transactionChunked(commands: Parameters<SqliteDatabase["transactionChunked"]>[0], chunkSize?: number): Promise<readonly unknown[]> { return this.inner.transactionChunked(commands, chunkSize); }
  async close(): Promise<void> { return this.inner.close(); }
}

const FULL_LOAD_MARKER = "1 = 1";
const isFullLoadCall = (call: SqlCall): boolean => call.sql.includes(FULL_LOAD_MARKER);
const isCountCall = (call: SqlCall): boolean => call.sql.startsWith("SELECT COUNT(*)");

async function insertIdentityAssignment(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, options: { readonly assignmentId: string; readonly identityId: string; readonly identityKey: string; readonly recordId: string; readonly ownerArtifactVersionId: string; readonly validFromGeneration: number; readonly validToGeneration?: number }): Promise<void> {
  const payload = encodeCanonical({ identity_id: options.identityId });
  await opened.database.run(
    "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, assignment_payload) VALUES (?, ?, 'entity', ?, 'created', ?, ?, ?, NULL, 'art-1', ?, ?, ?, ?)",
    [options.assignmentId, workspace.workspace_id, options.identityId, options.identityKey, `digest-${options.identityKey}`, options.recordId, options.ownerArtifactVersionId, options.validFromGeneration, options.validToGeneration ?? null, payload],
  );
}

async function closeIdentityAssignment(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, assignmentId: string, validFromGeneration: number, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE identity_assignments SET valid_to_generation = ? WHERE workspace_id = ? AND identity_assignment_id = ? AND valid_from_generation = ?", [validToGeneration, workspace.workspace_id, assignmentId, validFromGeneration]);
}

async function closeRecordOccurrence(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, recordId: string, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE record_occurrences SET valid_to_generation = ? WHERE workspace_id = ? AND record_id = ?", [validToGeneration, workspace.workspace_id, recordId]);
}

async function setGeneration(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, generation: number): Promise<void> {
  await opened.database.run("UPDATE workspace_current_state SET current_generation = ? WHERE workspace_id = ?", [generation, workspace.workspace_id]);
}

describe("SqliteCanonicalQuerySnapshotPort incremental delta maintenance", () => {
  it("keeps the cached records array byte-for-byte equivalent to a cold full load across generation steps -- including additions, removals, an identity reassignment whose occurrence row stays valid, a >30% churn full-reload fallback, and a rollback to an older generation", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");

      // Generation 1: ten baseline records, each with an open identity assignment.
      for (let index = 1; index <= 10; index += 1) {
        const id = String(index).padStart(2, "0");
        await insertRecordOccurrence(opened, `rec-${id}`, "artv-1", 1, { name: `name-${id}` });
        await insertIdentityAssignment(opened, { assignmentId: `assign-${id}-1`, identityId: `id-${id}`, identityKey: `key-${id}`, recordId: `rec-${id}`, ownerArtifactVersionId: "artv-1", validFromGeneration: 1 });
      }

      const recording = new RecordingDatabase(opened.database);
      const port = new SqliteCanonicalQuerySnapshotPort(recording);

      async function assertMatchesFreshFullLoad(generation: number): Promise<readonly CanonicalQueryRecord[]> {
        await setGeneration(opened, generation);
        recording.calls.length = 0;
        const result = await port.records(scope);
        const fresh = new SqliteCanonicalQuerySnapshotPort(opened.database);
        const expected = await fresh.records(scope);
        expect(result).toEqual(expected);
        return result;
      }

      // Generation 1: cold start -- necessarily a full load (no prior cache).
      const gen1 = await assertMatchesFreshFullLoad(1);
      expect(gen1).toHaveLength(10);
      expect(recording.calls.some(isFullLoadCall)).toBe(true);

      // Generation 2: close rec-05 (removal), add rec-11 (addition). Churn = 2
      // of 10 cached records (20%) -- well under the 30% fallback threshold,
      // so this must take the delta path (count queries, no full-load marker).
      await closeRecordOccurrence(opened, "rec-05", 2);
      await insertRecordOccurrence(opened, "rec-11", "artv-1", 2, { name: "name-11" });
      await insertIdentityAssignment(opened, { assignmentId: "assign-11-1", identityId: "id-11", identityKey: "key-11", recordId: "rec-11", ownerArtifactVersionId: "artv-1", validFromGeneration: 2 });
      const gen2 = await assertMatchesFreshFullLoad(2);
      expect(gen2).toHaveLength(10);
      expect(gen2.some((record) => record.record_id === "rec-05")).toBe(false);
      expect(gen2.some((record) => record.record_id === "rec-11")).toBe(true);
      expect(recording.calls.some(isCountCall)).toBe(true);
      expect(recording.calls.some(isFullLoadCall)).toBe(false);

      // Generation 3: reassign rec-02's identity (close its generation-1
      // assignment, open a new one) while its occurrence row's own
      // valid_from/valid_to are untouched -- this must still surface as a
      // delta refresh, per the identity-churn predicate on identity_assignments
      // alone (no record_occurrences change at all this generation).
      await closeIdentityAssignment(opened, "assign-02-1", 1, 3);
      await insertIdentityAssignment(opened, { assignmentId: "assign-02-2", identityId: "id-02b", identityKey: "key-02b", recordId: "rec-02", ownerArtifactVersionId: "artv-1", validFromGeneration: 3 });
      const gen3 = await assertMatchesFreshFullLoad(3);
      expect(gen3).toHaveLength(10);
      const rec02AtGen3 = gen3.find((record) => record.record_id === "rec-02");
      expect(rec02AtGen3?.identity_id).toBe("id-02b");
      expect(rec02AtGen3?.identity_key).toBe("key-02b");
      expect(recording.calls.some(isCountCall)).toBe(true);
      expect(recording.calls.some(isFullLoadCall)).toBe(false);

      // Generation 4: close five more occurrences (half the cached array) --
      // churn (5) exceeds 30% of the cached length (10), so this must fall
      // back to a full reload after counting the churn (both a count call and
      // the full-load marker are present for this generation's call).
      for (const id of ["rec-01", "rec-03", "rec-04", "rec-06", "rec-07"]) await closeRecordOccurrence(opened, id, 4);
      const gen4 = await assertMatchesFreshFullLoad(4);
      expect(gen4).toHaveLength(5);
      expect(recording.calls.some(isCountCall)).toBe(true);
      expect(recording.calls.some(isFullLoadCall)).toBe(true);

      // Generation 5: roll the published generation *backward* to 2 (as a
      // rebuilt/restored database might) -- gNew < the port's cached
      // generation (4), so this must go straight to a full reload without
      // even attempting a delta (no count queries at all for this call).
      const gen5 = await assertMatchesFreshFullLoad(2);
      expect(gen5).toHaveLength(10);
      expect(gen5.some((record) => record.record_id === "rec-05")).toBe(false);
      expect(gen5.some((record) => record.record_id === "rec-11")).toBe(true);
      expect(recording.calls.some(isCountCall)).toBe(false);
      expect(recording.calls.some(isFullLoadCall)).toBe(true);
    });
  });

  it("single-flights concurrent records() calls: two concurrent calls during a slow load produce one underlying load and the same array instance", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrence(opened, "rec-1", "artv-1", 1, { name: "one" });

      const recording = new RecordingDatabase(opened.database);
      recording.delayMatcher = (sql) => sql.includes(FULL_LOAD_MARKER);
      recording.delayMs = 50;
      const port = new SqliteCanonicalQuerySnapshotPort(recording);

      const [first, second] = await Promise.all([port.records(scope), port.records(scope)]);
      expect(first).toBe(second);
      expect(first).toHaveLength(1);
      expect(recording.calls.filter(isFullLoadCall)).toHaveLength(1);
    });
  });
});

// Regression coverage for a real e2e performance finding: `loadAllRecords`
// (feeding `recordsCache`, the "full 8-11s reload" for a multi-GB corpus)
// used to decode every row in one fully-synchronous loop with no yield
// points at all -- and `packages/daemon/src/runtime.ts`'s startup warm-up
// runs this sequentially, once per ready workspace, starving
// `core:status`/`core:index_status` RPCs for the loop's entire duration.
// Same pattern as the lexical reconciler's own event-loop-stall fix
// (`packages/engine/src/lexical-reconciler.ts`): a periodic `setImmediate`
// yield, batched every `RECORDS_YIELD_BATCH_SIZE` records rather than every
// single one (unlike the reconciler's per-document trigram computation,
// decoding one record here is cheap enough that yielding on every record
// would add far more relative overhead than it saves).
describe("SqliteCanonicalQuerySnapshotPort corpus-load event-loop yielding", () => {
  it("loadAllRecords yields to the event loop periodically while decoding a large corpus, batched rather than once per record", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      const recordCount = 4_500;
      await insertRecordOccurrencesBulk(opened, recordCount, "artv-1", 1);

      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);

      // Wraps the real `setImmediate` (still delegating to it, so the load
      // itself behaves identically) purely to count how many times the
      // decode loop actually used it as a yield point.
      const realSetImmediate = globalThis.setImmediate;
      let yieldCount = 0;
      const countingSetImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
        yieldCount += 1;
        return realSetImmediate(callback, ...args);
      }) as typeof setImmediate;
      globalThis.setImmediate = countingSetImmediate;
      let records: readonly CanonicalQueryRecord[];
      try {
        records = await port.records(scope);
      } finally {
        globalThis.setImmediate = realSetImmediate;
      }

      expect(records).toHaveLength(recordCount);
      // The load-bearing assertion: decoding 4,500 records must yield more
      // than once (proving this is not one long synchronous pass -- before
      // this fix, `yieldCount` would be exactly 0 here) and far fewer times
      // than the record count (proving it is batched, not a yield per
      // record -- an unbounded-overhead regression this test would also
      // catch).
      expect(yieldCount).toBeGreaterThan(0);
      expect(yieldCount).toBeLessThan(recordCount / 10);
    });
  }, 30_000);
});

// Companion regression coverage for the two other full-corpus synchronous
// passes the same performance finding turned up alongside `loadAllRecords`'s
// decode loop (fixed above): `identityMaps` (memoized per records array as
// `cachedIdentityMaps`, primed by `warm()` and rebuilt lazily by `execute()`)
// used to build its `by_any_id` map and `entities`/`relations` slices in one
// uninterrupted pass with no yield point, and `queryRecordRows` used to fetch
// every row for a full/delta load in a single unbounded SQL `all()` call --
// one structured-clone `postMessage` off the SQLite worker thread with no
// yield point of its own, a stall on top of (not fixed by) the decode loop's
// yielding. Both are now yielded/paginated the same way, same
// `RECORDS_YIELD_BATCH_SIZE`/`ROW_FETCH_BATCH_SIZE` constants.
describe("SqliteCanonicalQuerySnapshotPort/CanonicalRecordQueryDataPort corpus-scale yielding beyond the decode loop", () => {
  it("cachedIdentityMaps yields to the event loop periodically while indexing a large corpus, batched rather than once per record", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      const recordCount = 4_500;
      await insertRecordOccurrencesBulk(opened, recordCount, "artv-1", 1);

      const snapshot = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const dataPort = new CanonicalRecordQueryDataPort(snapshot);

      // Warms the records cache first, UNINSTRUMENTED -- this makes the
      // *next* `records()` call (inside `warm()` below) a synchronous cache
      // hit, so none of `decodeRows`'s own yields (already covered by the
      // test above) get counted here. That isolates `cachedIdentityMaps`'s
      // yield loop, which only runs on `warm()`'s subsequent
      // `cachedIdentityMaps(records)` call -- the array is fresh to that
      // WeakMap-keyed cache, so it must actually build (and yield).
      await snapshot.records(scope);

      const realSetImmediate = globalThis.setImmediate;
      let yieldCount = 0;
      const countingSetImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
        yieldCount += 1;
        return realSetImmediate(callback, ...args);
      }) as typeof setImmediate;
      globalThis.setImmediate = countingSetImmediate;
      try {
        await dataPort.warm(scope);
      } finally {
        globalThis.setImmediate = realSetImmediate;
      }

      // Same load-bearing shape as the decode-loop test above: more than
      // zero yields (not one long synchronous pass building `by_any_id` plus
      // the `entities`/`relations` slices) but far fewer than the record
      // count (batched, not a yield per record).
      expect(yieldCount).toBeGreaterThan(0);
      expect(yieldCount).toBeLessThan(recordCount / 10);
    });
  }, 30_000);

  it("loadAllRecords round-trips a corpus spanning multiple SQL row-fetch batches, in exact record_id order, with nothing dropped, duplicated, or corrupted at the batch boundary", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      // Deliberately larger than `ROW_FETCH_BATCH_SIZE` (10_000 as of this
      // writing, in canonical-query-data-port.ts) so `queryRecordRows`'s
      // keyset pagination must actually cross a batch boundary -- a corpus
      // smaller than one batch would trivially "round-trip" without
      // exercising the paging logic at all, so this is specifically the case
      // that would catch a boundary bug (a dropped/duplicated/misordered row
      // where one page ends and the next begins).
      const recordCount = 12_000;
      await insertRecordOccurrencesBulk(opened, recordCount, "artv-1", 1);

      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const records = await port.records(scope);

      expect(records).toHaveLength(recordCount);
      // Every inserted record present exactly once, in ascending record_id
      // order end to end -- exactly what a single unpaginated
      // `ORDER BY records.record_id` query would have produced, so this
      // proves pagination changed only the number of SQL round trips, never
      // the result. `toEqual` against the full expected id sequence catches
      // gaps, duplicates, and reordering all at once (unlike, say, just
      // checking length or sortedness).
      const ids = records.map((record) => record.record_id);
      const expectedIds = Array.from({ length: recordCount }, (_unused, index) => `bulk-rec-${String(index).padStart(6, "0")}`);
      expect(ids).toEqual(expectedIds);
      // Spot-checks decoded body content right at the batch boundary
      // (index 9_999 is the last row of the first 10_000-row batch, 10_000
      // the first row of the second) and at both ends of the corpus.
      expect(records[0]?.body["name"]).toBe("bulk-0");
      expect(records[9_999]?.body["name"]).toBe("bulk-9999");
      expect(records[10_000]?.body["name"]).toBe("bulk-10000");
      expect(records[recordCount - 1]?.body["name"]).toBe(`bulk-${recordCount - 1}`);
    });
  }, 60_000);
});

describe("SqliteCanonicalQuerySnapshotPort.artifact_text", () => {
  it("reads content through the CAS-shaped reader, decodes it, and caches by artifact_version_id", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-text", "sha256:bbbb", "utf-8");
      let reads = 0;
      const content = { async read(contentHash: string) { reads += 1; expect(contentHash).toBe("sha256:bbbb"); return new TextEncoder().encode("const value = 1;\n"); } };
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, content);

      const first = await port.artifact_text(scope, "artv-text");
      const second = await port.artifact_text(scope, "artv-text");
      expect(first?.text).toBe("const value = 1;\n");
      expect(second?.text).toBe("const value = 1;\n");
      expect(reads).toBe(1);
    });
  });

  it("falls back to utf-8 for an encoding label TextDecoder rejects", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-bad-encoding", "sha256:cccc", "not-a-real-encoding");
      const content = { async read() { return new TextEncoder().encode("hello"); } };
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, content);
      const result = await port.artifact_text(scope, "artv-bad-encoding");
      expect(result?.text).toBe("hello");
    });
  });

  it("returns undefined without a content reader, and for an unknown artifact_version_id", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-known", "sha256:dddd", "utf-8");
      const withoutContent = new SqliteCanonicalQuerySnapshotPort(opened.database);
      await expect(withoutContent.artifact_text(scope, "artv-known")).resolves.toBeUndefined();

      const content = { async read() { return new TextEncoder().encode("x"); } };
      const withContent = new SqliteCanonicalQuerySnapshotPort(opened.database, content);
      await expect(withContent.artifact_text(scope, "artv-missing")).resolves.toBeUndefined();
    });
  });
});

function stubRecord(recordId: string, ownerArtifactVersionId: string, body: Readonly<Record<string, unknown>>): CanonicalQueryRecord {
  return { record_id: recordId, workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-1", owner_artifact_version_id: ownerArtifactVersionId, facets: [], body };
}

const FILE_TEXT = "function greet() {\n  return \"hello\";\n}\n\nfunction farewell() {\n  return \"bye\";\n}\n";
// `greet` spans the first three lines (indices 0..39); `farewell` spans the last three (indices 41..80).
const GREET_START = FILE_TEXT.indexOf("function greet");
const GREET_END = FILE_TEXT.indexOf("}\n\nfunction farewell") + 1;
const FAREWELL_START = FILE_TEXT.indexOf("function farewell");
const FAREWELL_END = FILE_TEXT.length - 1;

function stubPort(overrides: Partial<CanonicalQuerySnapshotPort> = {}): CanonicalQuerySnapshotPort {
  return {
    async records() {
      return [
        stubRecord("rec-greet", "artv-1", { path: "src/a.ts", start: GREET_START, end: GREET_END, name: "greet" }),
        stubRecord("rec-farewell", "artv-1", { path: "src/a.ts", start: FAREWELL_START, end: FAREWELL_END, name: "farewell" }),
        stubRecord("rec-no-span", "artv-1", { path: "src/a.ts", name: "noSpan" }),
        stubRecord("rec-missing-content", "artv-missing", { path: "src/b.ts", start: 0, end: 3, name: "gone" }),
      ];
    },
    async artifact_text(_scope, artifactVersionId) {
      return artifactVersionId === "artv-1" ? { text: FILE_TEXT } : undefined;
    },
    ...overrides,
  };
}

function getSourceOperation(entityIds: readonly string[], source: Readonly<Record<string, unknown>>) {
  return {
    operation_id: "core:get_source",
    result_streams: ["sources"],
    arguments: { subjects: entityIds.map((entity_id) => ({ subject_type: "entity", entity_id })), source },
    scope,
  };
}

interface SourceBundle {
  readonly primary_result: unknown;
  readonly optional_source_snippets: ReadonlyArray<{ readonly text: string; readonly truncated: boolean; readonly span: { readonly start_byte: string; readonly end_byte: string } }>;
}

function sourceBundles(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): readonly SourceBundle[] {
  const items = (evaluation.streams["sources"] ?? []) as ReadonlyArray<{ readonly value: unknown }>;
  return items.map((entry) => entry.value as SourceBundle);
}

describe("CanonicalRecordQueryDataPort core:get_source", () => {
  it("hydrates a pipeline artifact selector by artifact_version_id", async () => {
    const artifact: CanonicalQueryRecord = {
      record_id: "artifact-record:artv-1",
      workspace_id: workspace.workspace_id,
      category: "artifact",
      kind: "core:source_file",
      universal_kind: "core:artifact",
      owner_artifact_id: "art-1",
      owner_artifact_version_id: "artv-1",
      body: { artifact_id: "art-1", artifact_version_id: "artv-1", path: "src/a.ts" },
    };
    const port = new CanonicalRecordQueryDataPort(stubPort({ records_by_artifact_versions: async (_scope, ids) => ids.includes("artv-1") ? [artifact] : [] }));
    const evaluation = await port.execute({
      operation_id: "core:get_source",
      result_streams: ["sources"],
      arguments: { subjects: [{ subject_type: "artifact", artifact_id: "art-1", artifact_version_id: "artv-1" }], source: { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 } },
      scope,
    });
    const bundles = sourceBundles(evaluation);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.primary_result).toEqual(expect.objectContaining({ record_id: artifact.record_id }));
  });

  it("slices the record's span out of the resolved artifact text in body mode", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-greet"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles).toHaveLength(1);
    const snippet = bundles[0]!.optional_source_snippets[0]!;
    expect(snippet.text).toBe(FILE_TEXT.slice(GREET_START, GREET_END));
    expect(snippet.truncated).toBe(false);
    expect(snippet.span.start_byte).toBe(String(GREET_START));
    expect(snippet.span.end_byte).toBe(String(GREET_END));
  });

  it("returns only the first line of the span in signature mode", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-greet"], { mode: "signature", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets[0]!.text).toBe("function greet() {");
  });

  it("extends the snippet backward with a whole line of context", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-farewell"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 1 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets[0]!.text).toBe("\nfunction farewell() {\n  return \"bye\";\n}\n");
  });

  it("extends the snippet forward with a whole line of context", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-greet"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 1 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets[0]!.text).toBe("function greet() {\n  return \"hello\";\n}\n\n");
  });

  it("truncates a snippet past the per-snippet character budget", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-greet"], { mode: "body", max_characters_per_snippet: 5, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    const snippet = bundles[0]!.optional_source_snippets[0]!;
    expect(snippet.text).toBe(FILE_TEXT.slice(GREET_START, GREET_START + 5));
    expect(snippet.truncated).toBe(true);
  });

  it("stops adding snippet text once the total character budget is exhausted, without dropping later subjects", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const greetLength = GREET_END - GREET_START;
    const evaluation = await port.execute(getSourceOperation(["rec-greet", "rec-farewell"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: greetLength, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.optional_source_snippets).toHaveLength(1);
    expect(bundles[1]!.optional_source_snippets).toHaveLength(0);
  });

  it("emits a bundle with no snippet, but does not drop the subject, when content is unavailable", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-missing-content"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.optional_source_snippets).toEqual([]);
    expect(bundles[0]!.primary_result).toBeDefined();
  });

  it("emits a bundle with no snippet when the record has no start/end span", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-no-span"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets).toEqual([]);
  });

  it("uses the canonical primary source span, including one-based line locators, when the body has no offsets", async () => {
    const primarySpanRecord: CanonicalQueryRecord = {
      ...stubRecord("rec-primary-span", "artv-1", { path: "src/a.ts", name: "greet" }),
      primary_source_span: { artifact_version_id: "artv-1", start_byte: String(GREET_START), end_byte: String(GREET_END), start_line: "1", end_line: "3" },
    };
    const port = new CanonicalRecordQueryDataPort(stubPort({ records: async () => [primarySpanRecord] }));
    const evaluation = await port.execute(getSourceOperation(["rec-primary-span"], { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.primary_result).toEqual(expect.objectContaining({ source_span: { artifact_version_id: "artv-1", start_byte: String(GREET_START), end_byte: String(GREET_END), start_line: "1", end_line: "3" } }));
    expect(bundles[0]!.optional_source_snippets).toEqual([expect.objectContaining({ text: FILE_TEXT.slice(GREET_START, GREET_END), span: { artifact_version_id: "artv-1", start_byte: String(GREET_START), end_byte: String(GREET_END), start_line: "1", end_line: "3" }, truncated: false })]);
  });

  it("emits no snippet for any subject in mode none", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort());
    const evaluation = await port.execute(getSourceOperation(["rec-greet"], { mode: "none", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets).toEqual([]);
  });
});

// --- Cold-path SQL pushdown --------------------------------------------
//
// `SqliteCanonicalQuerySnapshotPort.records_by_ids` / `records_by_name` /
// `records_by_selector` / `has_warm_records` let `CanonicalRecordQueryDataPort`
// answer `core:resolve_symbol`, `core:get_source`, and column-only
// `core:find_records` selectors straight from indexed SQLite columns, without
// ever paying for the full-corpus `records()` load (or its delta) that the
// in-memory evaluation path requires. These tests seed a small workspace
// with jsts-shaped `identity_key`s (`jsts:<kind>:<path>:<start>:<name>` --
// see `packages/plugin-javascript-typescript/src/analyzer.ts`'s `stableId`)
// and assert two things for each pushdown-eligible operation: (1) a data
// port over a *cold* (never-warmed) snapshot port produces byte-identical
// `streams` to the same operation run through a *warmed* one (which takes
// the existing, already-tested in-memory path), and (2) the cold run never
// triggers a full load as a side effect -- checked black-box via
// `has_warm_records`, which only ever flips true when `records()` has
// actually populated the generation cache.
async function seedEntity(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, options: { readonly recordId: string; readonly name: string; readonly kind: string; readonly universalKind: string; readonly path: string; readonly start: number; readonly language: string; readonly qualifiedName?: string }): Promise<void> {
  await opened.database.run(
    "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES (?, ?, 'entity', ?, ?, 1, 'test', '1', 'art-1', 'artv-1', NULL, NULL, NULL, NULL, NULL, 1, NULL, ?, 'payload-digest', ?, ?, NULL, ?)",
    (() => {
      const payload = recordPayload({ name: options.name, language: options.language, ...(options.qualifiedName === undefined ? {} : { qualified_name: options.qualifiedName }) });
      return [options.recordId, workspace.workspace_id, options.kind, options.universalKind, `digest-${options.recordId}`, payload.byteLength, payload, payload];
    })(),
  );
  await insertIdentityAssignment(opened, {
    assignmentId: `assign-${options.recordId}`, identityId: `id-${options.recordId}`,
    identityKey: `jsts:${options.kind}:${options.path}:${options.start}:${options.name}`,
    recordId: options.recordId, ownerArtifactVersionId: "artv-1", validFromGeneration: 1,
  });
}

async function seedPushdownWorkspace(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>): Promise<void> {
  await seedBaseline(opened);
  await insertArtifactVersion(opened, "artv-1", "sha256:pushdown", "utf-8");
  await seedEntity(opened, { recordId: "rec-export-canvas", name: "exportToCanvas", kind: "function", universalKind: "core:callable", path: "packages/excalidraw/scene/export.ts", start: 100, language: "typescript" });
  await seedEntity(opened, { recordId: "rec-export-svg", name: "exportToSvg", kind: "function", universalKind: "core:callable", path: "packages/excalidraw/scene/export.ts", start: 500, language: "typescript" });
  await seedEntity(opened, { recordId: "rec-js-helper", name: "helper", kind: "function", universalKind: "core:callable", path: "packages/excalidraw/scene/helper.js", start: 10, language: "javascript" });
  await seedEntity(opened, { recordId: "rec-canvas-type", name: "CanvasOptions", kind: "interface", universalKind: "core:type", path: "packages/excalidraw/types.ts", start: 20, language: "typescript" });
}

function pushdownPorts(database: SqliteDatabase, content?: { readonly read: (contentHash: string) => Promise<Uint8Array> }): {
  readonly cold: { readonly snapshot: SqliteCanonicalQuerySnapshotPort; readonly data: CanonicalRecordQueryDataPort };
  readonly warm: { readonly snapshot: SqliteCanonicalQuerySnapshotPort; readonly data: CanonicalRecordQueryDataPort };
} {
  const coldSnapshot = new SqliteCanonicalQuerySnapshotPort(database, content);
  const warmSnapshot = new SqliteCanonicalQuerySnapshotPort(database, content);
  return {
    cold: { snapshot: coldSnapshot, data: new CanonicalRecordQueryDataPort(coldSnapshot) },
    warm: { snapshot: warmSnapshot, data: new CanonicalRecordQueryDataPort(warmSnapshot) },
  };
}

describe("CanonicalRecordQueryDataPort cold-path pushdown equivalence", () => {
  it("core:resolve_symbol: cold pushdown matches the warmed in-memory path and never touches the full-corpus cache", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = { operation_id: "core:resolve_symbol", result_streams: ["declarations", "candidates"], arguments: { reference: "exportToCanvas", resolution_scope: "exports" }, scope };
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const coldResult = await cold.data.execute(operation);
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect((coldResult.streams["declarations"] as readonly unknown[]).length).toBe(1);
    });
  });

  it("core:resolve_symbol: an unmatched reference resolves to the same empty declarations on both paths", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = { operation_id: "core:resolve_symbol", result_streams: ["declarations", "candidates"], arguments: { reference: "doesNotExist" }, scope };
      const coldResult = await cold.data.execute(operation);
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect(coldResult.streams["declarations"]).toEqual([]);
    });
  });

  it("core:resolve_symbol: a dotted (qualified-name-shaped) reference falls back to the full path on the cold port, and still matches the warmed path", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      await opened.database.run("UPDATE record_occurrences SET record_payload = ? WHERE record_id = ?", [recordPayload({ name: "exportToCanvas", language: "typescript", qualified_name: "export.ts.exportToCanvas" }), "rec-export-canvas"]);
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = { operation_id: "core:resolve_symbol", result_streams: ["declarations", "candidates"], arguments: { reference: "export.ts.exportToCanvas" }, scope };
      const coldResult = await cold.data.execute(operation);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect((coldResult.streams["declarations"] as readonly unknown[]).length).toBe(1);
      // Falling back means the cold port's cache is now populated too.
      expect(await cold.snapshot.has_warm_records(scope)).toBe(true);
    });
  });

  it("core:get_source: cold pushdown resolves subjects by entity_id and by record_id and matches the warmed path, without touching the full-corpus cache", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const contentByHash = new Map([["sha256:pushdown", "function exportToCanvas() {\n  return 1;\n}\n"]]);
      const content = { async read(hash: string) { return new TextEncoder().encode(contentByHash.get(hash) ?? ""); } };
      const { cold, warm } = pushdownPorts(opened.database, content);
      await warm.data.warm(scope);

      const canvasIdentityId = "id-rec-export-canvas";
      const operation = {
        operation_id: "core:get_source", result_streams: ["sources"],
        arguments: {
          subjects: [{ subject_type: "entity", entity_id: canvasIdentityId }, { subject_type: "entity", entity_id: "rec-js-helper" }],
          source: { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 },
        },
        scope,
      };
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const coldResult = await cold.data.execute(operation);
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect((coldResult.streams["sources"] as readonly unknown[]).length).toBe(2);
    });
  });

  it("core:find_records: cold pushdown applies both the pushed-down kind selector and the body-only language filter identically to the warmed path", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = {
        operation_id: "core:find_records", result_streams: ["records"],
        arguments: { selector: { record_categories: ["entity"], kind_selector: { universal_kinds: ["core:callable"] }, filter: { languages: ["typescript"] } } },
        scope,
      };
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const coldResult = await cold.data.execute(operation);
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      const records = coldResult.streams["records"] as ReadonlyArray<{ readonly value: { readonly body: { readonly name: string } } }>;
      expect(records.map((entry) => entry.value.body.name).sort()).toEqual(["exportToCanvas", "exportToSvg"]);
    });
  });

  it("core:find_records: an empty selector match resolves to the same empty result on both paths", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = { operation_id: "core:find_records", result_streams: ["records"], arguments: { selector: { record_categories: ["relation"] } }, scope };
      const coldResult = await cold.data.execute(operation);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect(coldResult.streams["records"]).toEqual([]);
    });
  });
});

describe("SqliteCanonicalQuerySnapshotPort pushdown methods", () => {
  it("has_warm_records is false before any load, true once warm() has populated the cache, and never itself triggers a load", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const recording = new RecordingDatabase(opened.database);
      const port = new SqliteCanonicalQuerySnapshotPort(recording);
      expect(await port.has_warm_records(scope)).toBe(false);
      expect(recording.calls.some(isFullLoadCall)).toBe(false);
      await port.records(scope);
      expect(await port.has_warm_records(scope)).toBe(true);
    });
  });

  it("records_by_ids resolves the same record via its record_id, identity_id, and identity_key, and de-duplicates a mixed batch", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const byRecordId = await port.records_by_ids(scope, ["rec-export-canvas"]);
      const byIdentityId = await port.records_by_ids(scope, ["id-rec-export-canvas"]);
      const byIdentityKey = await port.records_by_ids(scope, ["jsts:function:packages/excalidraw/scene/export.ts:100:exportToCanvas"]);
      expect(byRecordId).toHaveLength(1);
      expect(byRecordId).toEqual(byIdentityId);
      expect(byRecordId).toEqual(byIdentityKey);

      const mixed = await port.records_by_ids(scope, ["rec-export-canvas", "id-rec-export-canvas", "rec-js-helper", "no-such-id"]);
      expect(mixed.map((record) => record.record_id).sort()).toEqual(["rec-export-canvas", "rec-js-helper"]);
    });
  });

  it("records_by_ids returns nothing for an empty id list or an unpublished workspace", async () => {
    await withWorkspace(async (opened) => {
      await seedPushdownWorkspace(opened);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      expect(await port.records_by_ids(scope, [])).toEqual([]);
    });
    await withWorkspace(async (opened) => {
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      expect(await port.records_by_ids(scope, ["anything"])).toEqual([]);
    });
  });

  it("records_by_name matches only the exact final identity_key segment, case-sensitively, never a LIKE wildcard false positive from '%' or '_' inside the name", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await seedEntity(opened, { recordId: "rec-exact", name: "foo_bar", kind: "function", universalKind: "core:callable", path: "a.ts", start: 1, language: "typescript" });
      // `_` is a single-character LIKE wildcard: a naive `LIKE '%:foo_bar'` scan
      // also matches an identity_key ending in `:fooXbar` -- this record must
      // be excluded by the JS-side exact-tail re-check.
      await seedEntity(opened, { recordId: "rec-wildcard-collision", name: "fooXbar", kind: "function", universalKind: "core:callable", path: "b.ts", start: 2, language: "typescript" });
      // SQLite's LIKE is case-insensitive by default; a differently-cased
      // name must not match either.
      await seedEntity(opened, { recordId: "rec-wrong-case", name: "FOO_BAR", kind: "function", universalKind: "core:callable", path: "c.ts", start: 3, language: "typescript" });

      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const matches = await port.records_by_name(scope, "foo_bar");
      expect(matches.map((record) => record.record_id)).toEqual(["rec-exact"]);
    });
  });

  it("records_by_selector orders results deterministically by record_id and truncates at the requested limit", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      for (const id of ["rec-c", "rec-a", "rec-b"]) await seedEntity(opened, { recordId: id, name: id, kind: "function", universalKind: "core:callable", path: "a.ts", start: 1, language: "typescript" });

      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const unlimited = await port.records_by_selector(scope, { universal_kinds: ["core:callable"] }, 10);
      expect(unlimited.map((record) => record.record_id)).toEqual(["rec-a", "rec-b", "rec-c"]);

      const limited = await port.records_by_selector(scope, { universal_kinds: ["core:callable"] }, 2);
      expect(limited.map((record) => record.record_id)).toEqual(["rec-a", "rec-b"]);

      const byCategory = await port.records_by_selector(scope, { categories: ["relation"] }, 10);
      expect(byCategory).toEqual([]);
    });
  });
});

// --- D6: core:search_text lexical pushdown ------------------------------
//
// `search_literal` / `records_by_artifact_versions` let `core:search_text`
// answer straight from the trigram-backed lexical projection
// (`lexical_documents`/`lexical_trigrams`, built out-of-band by
// `reconcileLexicalProjection` -- see `tests/lexical-maintenance.test.ts` for
// that side) instead of the in-memory corpus scan, which only ever matches
// against RECORD BODY JSON, never real file text. `records_by_artifact_versions`
// synthesizes its `category: "artifact"` records purely from `artifact_versions`
// joined with `source_artifacts` (see its doc comment in
// `canonical-query-data-port.ts` -- `record_occurrences.category` has a real
// `CHECK` constraint that makes a persisted `'artifact'` category impossible),
// so these tests never seed `record_occurrences` at all: the in-memory corpus
// is genuinely empty, so any non-empty `matches`/`subjects` stream is direct
// proof pushdown -- not a corpus scan that got lucky -- produced it.
function trigramsOf(text: string): readonly string[] {
  const source = new TextEncoder().encode(text.normalize("NFKC").toLocaleLowerCase("en-US"));
  const result = new Set<string>();
  for (let index = 0; index + 3 <= source.length; index += 1) result.add(Array.from(source.slice(index, index + 3), (value) => value.toString(16).padStart(2, "0")).join(""));
  return [...result].sort();
}

async function insertLexicalDocument(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactId: string, artifactVersionId: string, text: string, validFromGeneration: number, validToGeneration?: number): Promise<void> {
  const payload = encodeCanonical({ artifact_id: artifactId, artifact_version_id: artifactVersionId, text, valid_from_generation: validFromGeneration, ...(validToGeneration === undefined ? {} : { valid_to_generation: validToGeneration }) });
  await opened.database.run(
    "INSERT INTO lexical_documents (artifact_id, workspace_id, artifact_version_id, content_hash, byte_length, storage_reference, valid_from_generation, valid_to_generation, document_payload) VALUES (?, ?, ?, 'sha256:lexical-doc', 0, 'inline', ?, ?, ?)",
    [artifactId, workspace.workspace_id, artifactVersionId, validFromGeneration, validToGeneration ?? null, payload],
  );
  for (const trigram of trigramsOf(text)) {
    await opened.database.run("INSERT INTO lexical_trigrams (workspace_id, trigram, artifact_id, artifact_version_id, trigram_payload) VALUES (?, ?, ?, ?, ?)", [workspace.workspace_id, trigram, artifactId, artifactVersionId, encodeCanonical({ trigram })]);
  }
}

async function markLexicalComplete(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, generation: number): Promise<void> {
  await opened.database.run("INSERT INTO lexical_index_state (workspace_id, completed_generation) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET completed_generation = excluded.completed_generation", [workspace.workspace_id, generation]);
}

// `records_by_artifact_versions` JOINs `artifact_versions` against
// `source_artifacts`; `insertArtifactVersion` (above) never inserts the
// latter (its own callers -- the cold-pushdown suite above -- never need it),
// so the D6 tests below seed it explicitly.
async function insertSourceArtifact(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactId: string, normalizedPath: string): Promise<void> {
  await opened.database.run(
    "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?, 'physical_file', ?)",
    [artifactId, workspace.workspace_id, normalizedPath, normalizedPath, normalizedPath, new Uint8Array([1])],
  );
}

const NEEDLE_FILE_TEXT = "const value = 1;\nconst needleHere = value + 1;\nconst NeedleHere = value + 2;\n";

function searchTextOperation(args: Readonly<Record<string, unknown>>): { readonly operation_id: string; readonly result_streams: readonly string[]; readonly arguments: unknown; readonly scope: QueryScope } {
  return { operation_id: "core:search_text", result_streams: ["matches", "subjects"], arguments: { pattern: "needleHere", ...args }, scope };
}

async function seedSearchTextWorkspace(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>): Promise<void> {
  await seedBaseline(opened);
  await insertSourceArtifact(opened, "art-1", "src/search.ts");
  await insertArtifactVersion(opened, "artv-search", "sha256:needle-file", "utf-8");
}

function needleContent(): { readonly read: (contentHash: string) => Promise<Uint8Array> } {
  return { async read(contentHash) { return contentHash === "sha256:needle-file" ? new TextEncoder().encode(NEEDLE_FILE_TEXT) : new TextEncoder().encode(""); } };
}

describe("SqliteCanonicalQuerySnapshotPort D6 pushdown methods", () => {
  it("serves source-safe artifact discovery and text search from a source snapshot before structural publication", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await opened.database.run(
        "INSERT INTO source_index_state (workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [workspace.workspace_id, 1, 1, "source-checkpoint-1", "{}", "source-digest-1", now],
      );
      const sourceScope: QueryScope = { scope_type: "single_workspace", workspace_id: workspace.workspace_id, snapshot_id: "source-snapshot:1" };
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent());
      const artifacts = await port.artifacts_by_filter(sourceScope, { paths: ["src/**/*.ts"] });
      expect(artifacts.map((record) => record.body["path"])).toEqual(["src/search.ts"]);
      const matches = await port.search_literal(sourceScope, "needleHere", {});
      expect(matches?.[0]?.artifact_version_id).toBe("artv-search");
      expect(matches?.[0]?.offsets).toHaveLength(2);
    });
  });

  it("search_literal returns undefined before lexical_index_state's completed_generation reaches the current generation", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent());
      await expect(port.search_literal(scope, "needleHere", {})).resolves.toBeUndefined();

      // Marking a DIFFERENT (older) generation complete must not count either.
      await markLexicalComplete(opened, 0);
      await expect(port.search_literal(scope, "needleHere", {})).resolves.toBeUndefined();
    });
  });

  it("search_literal finds case-insensitive matches once complete, and case-sensitive matches only the exact case", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent());

      const insensitive = await port.search_literal(scope, "needleHere", {});
      expect(insensitive).toHaveLength(1);
      // Both "needleHere" and "NeedleHere" fold to the same normalized needle,
      // so case-insensitive search finds both occurrences.
      expect(insensitive?.[0]?.offsets).toHaveLength(2);

      const sensitive = await port.search_literal(scope, "needleHere", { case_sensitive: true });
      expect(sensitive).toHaveLength(1);
      expect(sensitive?.[0]?.offsets).toHaveLength(1);

      const noMatch = await port.search_literal(scope, "doesNotAppearAnywhere", {});
      expect(noMatch).toEqual([]);
    });
  });

  it("records_by_artifact_versions synthesizes one artifact-shaped record per visible artifact_version_id, from artifact_versions/source_artifacts alone", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertRecordOccurrence(opened, "rec-entity-search", "artv-search", 1, { name: "unrelated" });
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);

      const resolved = await port.records_by_artifact_versions(scope, ["artv-search"]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.category).toBe("artifact");
      expect(resolved[0]?.owner_artifact_id).toBe("art-1");
      expect(resolved[0]?.owner_artifact_version_id).toBe("artv-search");
      expect(resolved[0]?.body["path"]).toBe("src/search.ts");
      // Never resolves via record_occurrences: the entity record seeded above
      // (owned by the same artifact version) has no bearing on the result.

      expect(await port.records_by_artifact_versions(scope, [])).toEqual([]);
      expect(await port.records_by_artifact_versions(scope, ["artv-missing"])).toEqual([]);
    });
  });
});

describe("CanonicalRecordQueryDataPort core:search_text lexical pushdown", () => {
  it("prefers real file-text matches over the corpus scan once lexical maintenance has completed, carrying source_span and match_count", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));

      const evaluation = await dataPort.execute(searchTextOperation({ syntax: "literal" }));
      const matches = evaluation.streams["matches"] as ReadonlyArray<{ readonly value: { readonly source_span?: { readonly artifact_version_id: string; readonly start_byte: string; readonly end_byte: string; readonly start_line?: string; readonly end_line?: string } } }>;
      const subjects = evaluation.streams["subjects"] as ReadonlyArray<{ readonly value: { readonly match_count?: number; readonly source_span?: { readonly artifact_version_id: string; readonly start_line?: string; readonly end_line?: string } } }>;
      // Corpus scan alone would find nothing (no record body contains
      // "needleHere"): finding a match at all is direct proof pushdown ran.
      expect(matches).toHaveLength(2);
      expect(matches.every((entry) => entry.value.source_span?.artifact_version_id === "artv-search")).toBe(true);
      expect(subjects).toHaveLength(1);
      expect(subjects[0]?.value.match_count).toBe(2);
      expect(subjects[0]?.value.source_span).toMatchObject({ artifact_version_id: "artv-search", start_line: "2", end_line: "2" });
      const start = Number(matches[0]!.value.source_span!.start_byte);
      const end = Number(matches[0]!.value.source_span!.end_byte);
      expect(NEEDLE_FILE_TEXT.slice(start, end).toLowerCase()).toBe("needlehere");
      expect(matches.map((entry) => [entry.value.source_span?.start_line, entry.value.source_span?.end_line])).toEqual([["2", "2"], ["3", "3"]]);
    });
  });

  it("keeps lexical pushdown for a path-only filter so pipelines can narrow discovery before hydration", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));

      const evaluation = await dataPort.execute(searchTextOperation({ syntax: "literal", filter: { paths: ["src/search.ts"] } }));
      const matches = evaluation.streams["matches"] as ReadonlyArray<{ readonly value: { readonly source_span?: { readonly start_line?: string } } }>;
      expect(matches).toHaveLength(2);
      expect(matches.every((entry) => entry.value.source_span?.start_line !== undefined)).toBe(true);
    });
  });

  it("falls back to the corpus scan (byte-for-byte, no source_span) when lexical maintenance has not completed yet", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      // Deliberately never mark lexical maintenance complete.
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));
      const evaluation = await dataPort.execute(searchTextOperation({ syntax: "literal" }));
      expect(evaluation.streams["matches"]).toEqual([]);
      expect(evaluation.streams["subjects"]).toEqual([]);
    });
  });

  it("falls back to the corpus scan for syntax: safe_regex, an explicit word_mode, or a non-empty filter, even once lexical maintenance is complete", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));

      for (const args of [{ syntax: "safe_regex" }, { word_mode: "identifier" }, { filter: { languages: ["typescript"] } }]) {
        const evaluation = await dataPort.execute(searchTextOperation(args));
        expect(evaluation.streams["matches"]).toEqual([]);
        expect(evaluation.streams["subjects"]).toEqual([]);
      }

      // An explicitly empty filter object is still eligible.
      const eligible = await dataPort.execute(searchTextOperation({ filter: {} }));
      expect((eligible.streams["matches"] as readonly unknown[]).length).toBeGreaterThan(0);
    });
  });

  it("is preferred even when the in-memory corpus is already warm", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));
      await dataPort.warm(scope);
      const evaluation = await dataPort.execute(searchTextOperation({ syntax: "literal" }));
      expect((evaluation.streams["matches"] as readonly unknown[]).length).toBe(2);
    });
  });
});

// --- Agent Q: core:search_semantic / core:search_hybrid pushdown ---------
//
// Mirrors the D6 harness immediately above: `seedBaseline` plus hand-rolled
// `source_artifacts`/`artifact_versions`/`vector_projection_rows` rows, and
// (deliberately) never `record_occurrences` -- so a non-empty `candidates`
// stream is direct proof `trySemanticSearch` produced it, not the in-memory
// corpus scan (which is empty here) getting lucky.

type OpenedWorkspace = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>;
type SemanticContentReader = { readonly read: (contentHash: string) => Promise<Uint8Array> };

/**
 * Like `withWorkspace` above, except it also hands the test the storage
 * instance's REAL content-addressed store as a `read`-only reader. Every
 * other D1-D6 test in this file above uses a fully synthetic `content`
 * reader (`needleContent()`, keyed to hand-picked fake hashes) because those
 * tests never write real bytes into CAS at all -- `insertLexicalDocument`
 * only inserts metadata rows. `putVectors`, however, DOES write through the
 * real `BlobStore`/CAS (`vector_shards.content_hash` names a real packed
 * blob) -- see `SqliteCanonicalQuerySnapshotPort.semantic_vectors`'s own doc
 * comment for why the raw vector bytes can only be recovered by reading that
 * shard back out. So semantic tests need the real CAS, not a fake map.
 */
async function withSemanticWorkspace(test: (opened: OpenedWorkspace, cas: SemanticContentReader) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-canonical-query-semantic-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    const cas: SemanticContentReader = { read: (contentHash) => storage.blobs.cas.read(contentHash) };
    try { await test(opened, cas); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Combines the real CAS reader (for vector shards) with a small fake hash->text map (for lexical documents, which -- unlike vectors -- never write real CAS content in these tests; see `insertLexicalDocument`/`fakeContentByHash` above). A lookup hits the fake map first; everything else falls through to real CAS. */
function combinedContentReader(cas: SemanticContentReader, fakeEntries: Readonly<Record<string, string>>): SemanticContentReader {
  return { async read(contentHash) { return contentHash in fakeEntries ? new TextEncoder().encode(fakeEntries[contentHash]) : cas.read(contentHash); } };
}

async function insertSemanticArtifactVersion(opened: OpenedWorkspace, options: { readonly artifactId: string; readonly versionId: string; readonly path: string; readonly byteLength: number; readonly validFromGeneration: number; readonly validToGeneration?: number; readonly encoding?: string }): Promise<void> {
  await insertSourceArtifact(opened, options.artifactId, options.path);
  const blobId = `blob-${options.versionId}`;
  await opened.database.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [blobId, `sha256:${options.versionId}`, options.byteLength, "inline"]);
  await opened.database.run(
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'metadata-digest', 'observation-1', ?, ?, ?)",
    [options.versionId, workspace.workspace_id, options.artifactId, blobId, `sha256:${options.versionId}`, options.byteLength, options.encoding ?? "utf-8", options.validFromGeneration, options.validToGeneration ?? null, new Uint8Array([1])],
  );
}

async function putSemanticVector(opened: OpenedWorkspace, provider: ResolvedSemanticProvider, options: { readonly artifactId: string; readonly versionId: string; readonly text: string; readonly validFromGeneration?: number; readonly validToGeneration?: number; readonly projectionRecordId?: string }): Promise<void> {
  const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: options.text });
  await opened.projections.putVectors([{
    projection_record_id: options.projectionRecordId ?? `semantic-document:${options.versionId}`,
    owner_artifact_id: options.artifactId,
    owner_artifact_version_id: options.versionId,
    profile_id: provider.profile.embedding_profile_id,
    executable_binding_id: provider.binding.executable_binding_digest,
    dimensions: provider.profile.dimensions,
    element_type: provider.profile.element_type,
    vector: generated.vector,
    vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
    normalization: provider.profile.normalization as "none" | "l2",
    distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
    valid_from_generation: options.validFromGeneration ?? 1,
    ...(options.validToGeneration === undefined ? {} : { valid_to_generation: options.validToGeneration }),
  }]);
}

async function closeSemanticVector(opened: OpenedWorkspace, projectionRecordId: string, validFromGeneration: number, validToGeneration: number): Promise<void> {
  await opened.database.run("UPDATE vector_projection_rows SET valid_to_generation = ? WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", [validToGeneration, workspace.workspace_id, projectionRecordId, validFromGeneration]);
}

async function markSemanticIndexState(opened: OpenedWorkspace, generation: number, profileId: string, executableBindingId: string): Promise<void> {
  await opened.database.run(
    "INSERT INTO semantic_index_state (workspace_id, completed_generation, profile_id, executable_binding_id) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET completed_generation = excluded.completed_generation, profile_id = excluded.profile_id, executable_binding_id = excluded.executable_binding_id",
    [workspace.workspace_id, generation, profileId, executableBindingId],
  );
}

function semanticOperation(operationId: "core:search_semantic" | "core:search_hybrid", args: Readonly<Record<string, unknown>> = {}): { readonly operation_id: string; readonly result_streams: readonly string[]; readonly arguments: unknown; readonly scope: QueryScope } {
  return { operation_id: operationId, result_streams: ["candidates", "semantic_coverage"], arguments: { query_text: "needleToken alphaSharedVocab", query_class: "natural_text", ...args }, scope };
}

interface SemanticCandidateValue {
  readonly classification: "confirmed" | "possible";
  readonly body: { readonly artifact_id?: string; readonly path?: string };
}

function candidateValues(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): readonly { readonly value: SemanticCandidateValue; readonly stable_sort_key: string }[] {
  return evaluation.streams["candidates"] as readonly { readonly value: SemanticCandidateValue; readonly stable_sort_key: string }[];
}

function coverageView(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): Record<string, unknown> {
  const items = evaluation.streams["semantic_coverage"] as readonly { readonly value: Record<string, unknown> }[];
  expect(items).toHaveLength(1);
  return items[0]!.value;
}

// Three distinct-vocabulary documents (per the pinned spec: "3+ docs with
// distinct identifier vocabularies, query shares tokens with one"). `alpha`
// deliberately equals the query text itself, guaranteeing it is the
// semantically closest possible document under the local hash embedder
// (near-zero cosine distance) rather than merely "closer on average" --
// `beta` shares both key tokens but not contiguously (so it never matches
// the lexical lane's literal-substring search below), and `gamma` carries
// heavy unrelated vocabulary that dilutes its cosine similarity to the query
// while still containing the literal phrase (so it DOES match the lexical
// lane). This one seed serves both the pure-ranking tests and the hybrid
// fusion tests below.
const ALPHA_TEXT = "needleToken alphaSharedVocab";
const BETA_TEXT = "alphaSharedVocab elsewhere and needleToken separately not adjacent docB-only-tail";
const GAMMA_TEXT = "needleToken alphaSharedVocab plus totally unrelated xylophoneQuasarNebulaPlasmaVortexAlphaBetaGammaDeltaEpsilonZeta filler docC-only-tail";

async function seedThreeDocumentWorkspace(opened: OpenedWorkspace, provider: ResolvedSemanticProvider): Promise<void> {
  await seedBaseline(opened);
  await insertSemanticArtifactVersion(opened, { artifactId: "art-alpha", versionId: "artv-alpha", path: "src/alpha.ts", byteLength: ALPHA_TEXT.length, validFromGeneration: 1 });
  await insertSemanticArtifactVersion(opened, { artifactId: "art-beta", versionId: "artv-beta", path: "src/beta.ts", byteLength: BETA_TEXT.length, validFromGeneration: 1 });
  await insertSemanticArtifactVersion(opened, { artifactId: "art-gamma", versionId: "artv-gamma", path: "src/gamma.ts", byteLength: GAMMA_TEXT.length, validFromGeneration: 1 });
  await putSemanticVector(opened, provider, { artifactId: "art-alpha", versionId: "artv-alpha", text: ALPHA_TEXT });
  await putSemanticVector(opened, provider, { artifactId: "art-beta", versionId: "artv-beta", text: BETA_TEXT });
  await putSemanticVector(opened, provider, { artifactId: "art-gamma", versionId: "artv-gamma", text: GAMMA_TEXT });
}

function fakeContentByHash(entries: Readonly<Record<string, string>>): { readonly read: (contentHash: string) => Promise<Uint8Array> } {
  return { async read(contentHash) { return new TextEncoder().encode(entries[contentHash] ?? ""); } };
}

const NUL = String.fromCharCode(0);
function sortKeyPrefix(rank: number): string {
  return `possible${NUL}${String(rank).padStart(6, "0")}${NUL}`;
}

describe("CanonicalRecordQueryDataPort core:search_semantic ranking", () => {
  it("ranks the semantically-closest document first, classifies every candidate 'possible', and shapes stable_sort_key as possible\\0<rank>\\0<identity>", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const candidates = candidateValues(evaluation);
      expect(candidates).toHaveLength(3);
      expect(candidates[0]!.value.classification).toBe("possible");
      expect(candidates[0]!.value.body.artifact_id).toBe("art-alpha");
      expect(candidates.every((entry) => entry.value.classification === "possible")).toBe(true);
      // Comparisons go through a NUL-safe helper (see NUL below) rather
      // than a literal `\0` in this file's own source, sidestepping the
      // legacy-octal-escape trap where `\0` immediately followed by more
      // digits (e.g. `\0000001`) parses as a short octal escape plus
      // leftover digits, not NUL followed by the literal digits intended.
      expect(candidates[0]!.stable_sort_key.startsWith(sortKeyPrefix(1))).toBe(true);
      expect(candidates[1]!.stable_sort_key.startsWith(sortKeyPrefix(2))).toBe(true);
      expect(candidates[2]!.stable_sort_key.startsWith(sortKeyPrefix(3))).toBe(true);
      // Coverage numbers, though not the focus of this test, are computed
      // (marker missing => "updating"); asserting only that it is present
      // and internally consistent.
      const coverage = coverageView(evaluation);
      expect(coverage["artifact_count"]).toBe(3);
      expect(coverage["covered_artifact_count"]).toBe(3);
    });
  });

  it("proves no corpus load happens: execute() succeeds through a port whose records()/has_warm_records() throw", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      const inner = new SqliteCanonicalQuerySnapshotPort(opened.database, cas);
      const forbidden: CanonicalQuerySnapshotPort = {
        records: () => { throw new Error("records() must not be called for core:search_semantic/core:search_hybrid"); },
        has_warm_records: () => { throw new Error("has_warm_records() must not be called for core:search_semantic/core:search_hybrid"); },
        capability_states: (queryScope) => inner.capability_states(queryScope),
        semantic_index_state: (queryScope) => inner.semantic_index_state(queryScope),
        semantic_vectors: (queryScope, profileId, executableBindingId) => inner.semantic_vectors(queryScope, profileId, executableBindingId),
        semantic_scope_counts: (queryScope, maxDocumentBytes) => inner.semantic_scope_counts(queryScope, maxDocumentBytes),
        records_by_artifact_versions: (queryScope, versionIds) => inner.records_by_artifact_versions(queryScope, versionIds),
        search_literal: (queryScope, pattern, options) => inner.search_literal(queryScope, pattern, options),
      };
      const dataPort = new CanonicalRecordQueryDataPort(forbidden, { semantic: provider });

      const semanticEvaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      expect(candidateValues(semanticEvaluation).length).toBeGreaterThan(0);
      const hybridEvaluation = await dataPort.execute(semanticOperation("core:search_hybrid"));
      expect(candidateValues(hybridEvaluation).length).toBeGreaterThan(0);
    });
  });

  it("paths filter excludes non-matching artifacts and is applied BEFORE the exact-scan cap", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      const NOISE_COUNT = 105; // > SEMANTIC_CANDIDATE_CAP (100)
      const noiseValues: string[] = [];
      const noiseParams: SqliteValue[] = [];
      const blobValues: string[] = [];
      const blobParams: SqliteValue[] = [];
      const versionValues: string[] = [];
      const versionParams: SqliteValue[] = [];
      for (let index = 0; index < NOISE_COUNT; index += 1) {
        const artifactId = `art-noise-${index}`;
        const versionId = `artv-noise-${index}`;
        const path = `src/noise/${index}.ts`;
        noiseValues.push("(?, ?, ?, ?, ?, ?, ?)");
        noiseParams.push(artifactId, workspace.workspace_id, path, path, path, "physical_file", new Uint8Array([1]));
        blobValues.push("(?, ?, ?, ?)");
        blobParams.push(`blob-${versionId}`, `sha256:${versionId}`, 0, "inline");
        versionValues.push("(?, ?, ?, ?, ?, ?, ?, NULL, 'metadata-digest', 'observation-1', ?, NULL, ?)");
        versionParams.push(versionId, workspace.workspace_id, artifactId, `blob-${versionId}`, `sha256:${versionId}`, 0, "utf-8", 1, new Uint8Array([1]));
      }
      await opened.database.run(`INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind, artifact_payload) VALUES ${noiseValues.join(",")}`, noiseParams);
      await opened.database.run(`INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES ${blobValues.join(",")}`, blobParams);
      await opened.database.run(`INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES ${versionValues.join(",")}`, versionParams);

      // Every noise vector is IDENTICAL to the query text -- distance 0,
      // tied for the closest possible match -- so all 105 of them sort ahead
      // of the target below regardless of tie-break order. That deterministically
      // guarantees an unfiltered, capped (100) scan can NEVER include the target.
      const noiseVectors = await Promise.all(Array.from({ length: NOISE_COUNT }, async (_unused, index) => {
        const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: "needleToken alphaSharedVocab" });
        return {
          projection_record_id: `semantic-document:artv-noise-${index}`,
          owner_artifact_id: `art-noise-${index}`,
          owner_artifact_version_id: `artv-noise-${index}`,
          profile_id: provider.profile.embedding_profile_id,
          executable_binding_id: provider.binding.executable_binding_digest,
          dimensions: provider.profile.dimensions,
          element_type: provider.profile.element_type,
          vector: generated.vector,
          vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
          normalization: provider.profile.normalization as "none" | "l2",
          distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
          valid_from_generation: 1,
        };
      }));
      await opened.projections.putVectors(noiseVectors);

      await insertSemanticArtifactVersion(opened, { artifactId: "art-target", versionId: "artv-target", path: "src/only-target/index.ts", byteLength: 40, validFromGeneration: 1 });
      // Deliberately unrelated vocabulary: guarantees a strictly WORSE
      // (nonzero) distance than every zero-distance noise vector above, so
      // the target can never survive an unfiltered cap -- only a pre-cap
      // path filter can save it.
      await putSemanticVector(opened, provider, { artifactId: "art-target", versionId: "artv-target", text: "renderGammaWidget canvasPixelBuffer unrelated" });

      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      // Sanity: unfiltered, the target is excluded by the cap.
      const unfiltered = await dataPort.execute(semanticOperation("core:search_semantic"));
      expect(candidateValues(unfiltered).length).toBe(100);
      expect(candidateValues(unfiltered).some((entry) => entry.value.body.artifact_id === "art-target")).toBe(false);

      const filtered = await dataPort.execute(semanticOperation("core:search_semantic", { filter: { paths: ["src/only-target/"] } }));
      const filteredCandidates = candidateValues(filtered);
      expect(filteredCandidates).toHaveLength(1);
      expect(filteredCandidates[0]!.value.body.artifact_id).toBe("art-target");
    });
  });

  it("generation visibility: a closed vector row becomes invisible after a generation bump, without disturbing a still-open sibling", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-keep", versionId: "artv-keep", path: "src/keep.ts", byteLength: 20, validFromGeneration: 1 });
      await insertSemanticArtifactVersion(opened, { artifactId: "art-close", versionId: "artv-close", path: "src/close.ts", byteLength: 20, validFromGeneration: 1 });
      await putSemanticVector(opened, provider, { artifactId: "art-keep", versionId: "artv-keep", text: "needleToken alphaSharedVocab keep" });
      await putSemanticVector(opened, provider, { artifactId: "art-close", versionId: "artv-close", text: "needleToken alphaSharedVocab close" });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const before = await dataPort.execute(semanticOperation("core:search_semantic"));
      expect(candidateValues(before).map((entry) => entry.value.body.artifact_id).sort()).toEqual(["art-close", "art-keep"]);

      await closeSemanticVector(opened, "semantic-document:artv-close", 1, 2);
      await setGeneration(opened, 2);

      const after = await dataPort.execute(semanticOperation("core:search_semantic"));
      const afterIds = candidateValues(after).map((entry) => entry.value.body.artifact_id);
      expect(afterIds).toEqual(["art-keep"]);
    });
  });

  it("unsupported structural filters (languages/namespaces/kind_selector) throw core:required_capability_unsupported rather than silently widening the result", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      for (const filter of [{ languages: ["typescript"] }, { namespaces: ["core"] }, { kind_selector: { kinds: ["function"] } }]) {
        await expect(dataPort.execute(semanticOperation("core:search_semantic", { filter }))).rejects.toMatchObject({
          code: "core:required_capability_unsupported",
          details: { capability: "core:semantic_structural_filter", workspace_snapshot_binding_ids: [workspace.workspace_id] },
        });
      }
    });
  });
});

// --- Decision 17: entity-grain semantic documents, query side -------------
//
// `putSemanticEntityVector` mirrors `putSemanticVector` above but sets
// `document_grain: "entity"`/`document_ref` -- an entity vector's hydration
// source is `records_by_ids` (keyed by `document_ref`, i.e. the owning
// record's `record_id`), so these tests also seed a matching
// `record_occurrences` row via `insertRecordOccurrence` (defined near the top
// of this file) so hydration has something real to resolve.
async function putSemanticEntityVector(opened: OpenedWorkspace, provider: ResolvedSemanticProvider, options: { readonly recordId: string; readonly ownerArtifactId: string; readonly ownerVersionId: string; readonly text: string; readonly validFromGeneration?: number }): Promise<void> {
  const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: options.text });
  await opened.projections.putVectors([{
    projection_record_id: `semantic-entity-document:${options.recordId}`,
    owner_artifact_id: options.ownerArtifactId,
    owner_artifact_version_id: options.ownerVersionId,
    profile_id: provider.profile.embedding_profile_id,
    executable_binding_id: provider.binding.executable_binding_digest,
    dimensions: provider.profile.dimensions,
    element_type: provider.profile.element_type,
    vector: generated.vector,
    vector_encoding: provider.profile.vector_encoding as "float32-le" | "float64-le",
    normalization: provider.profile.normalization as "none" | "l2",
    distance_metric: provider.profile.distance_metric as "squared_l2" | "cosine",
    valid_from_generation: options.validFromGeneration ?? 1,
    document_grain: "entity",
    document_ref: options.recordId,
  }]);
}

interface CandidateStreamValue { readonly subject_type: string; readonly record_id?: string; readonly kind?: string; readonly universal_kind?: string; readonly body: Readonly<Record<string, unknown>>; }
function candidateStreamValues(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): readonly CandidateStreamValue[] {
  return (evaluation.streams["candidates"] as readonly { readonly value: CandidateStreamValue }[]).map((item) => item.value);
}

const ENTITY_LANE_TEXT = "needleToken alphaSharedVocab entity span text";

async function seedEntityLaneWorkspace(opened: OpenedWorkspace, provider: ResolvedSemanticProvider): Promise<void> {
  await seedThreeDocumentWorkspace(opened, provider);
  await insertRecordOccurrence(opened, "rec-entity-alpha", "artv-alpha", 1, { name: "alphaEntity", kind: "function", language: "typescript", path: "src/alpha.ts", start: 0, end: 40 });
  await putSemanticEntityVector(opened, provider, { recordId: "rec-entity-alpha", ownerArtifactId: "art-alpha", ownerVersionId: "artv-alpha", text: ENTITY_LANE_TEXT });
}

describe("CanonicalRecordQueryDataPort core:search_semantic entity lane (decision 17)", () => {
  it("returns entity candidates with spans (body.start/body.end), alongside artifact candidates, when both grains are unfiltered", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedEntityLaneWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const values = candidateStreamValues(evaluation);
      // `recordValue` (canonical-query-data-port.ts) maps EVERY non-relation/
      // non-diagnostic category -- both the real "entity" category AND the
      // synthesized "artifact" category `records_by_artifact_versions`
      // produces -- to `subject_type: "entity"` (a pre-existing, unrelated-
      // to-decision-17 quirk of that shared helper) -- so `record_id`/
      // `universal_kind` are what actually discriminate an entity candidate
      // from an artifact one here, not `subject_type`.
      const entityCandidate = values.find((value) => value.record_id === "rec-entity-alpha");
      expect(entityCandidate).toBeDefined();
      expect(entityCandidate?.body["start"]).toBe(0);
      expect(entityCandidate?.body["end"]).toBe(40);
      expect(values.some((value) => value.universal_kind === "core:artifact")).toBe(true);
    });
  });

  it("subject_types: [\"entity\"] returns only entity results; [\"artifact\"] returns only artifact results", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedEntityLaneWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const entityOnly = await dataPort.execute(semanticOperation("core:search_semantic", { filter: { subject_types: ["entity"] } }));
      const entityOnlyValues = candidateStreamValues(entityOnly);
      expect(entityOnlyValues.length).toBeGreaterThan(0);
      expect(entityOnlyValues.every((value) => value.record_id === "rec-entity-alpha")).toBe(true);

      const artifactOnly = await dataPort.execute(semanticOperation("core:search_semantic", { filter: { subject_types: ["artifact"] } }));
      const artifactOnlyValues = candidateStreamValues(artifactOnly);
      expect(artifactOnlyValues.length).toBeGreaterThan(0);
      expect(artifactOnlyValues.every((value) => value.universal_kind === "core:artifact")).toBe(true);
    });
  });

  it("hybrid fuses three lanes (lexical, semantic-artifact, semantic-entity): both an artifact and an entity candidate surface", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedEntityLaneWorkspace(opened, provider);
      await insertLexicalDocument(opened, "art-alpha", "artv-alpha", ALPHA_TEXT, 1);
      await insertLexicalDocument(opened, "art-beta", "artv-beta", BETA_TEXT, 1);
      await insertLexicalDocument(opened, "art-gamma", "artv-gamma", GAMMA_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const content = combinedContentReader(cas, { "sha256:artv-alpha": ALPHA_TEXT, "sha256:artv-beta": BETA_TEXT, "sha256:artv-gamma": GAMMA_TEXT });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, content), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_hybrid"));
      const values = candidateStreamValues(evaluation);
      expect(values.some((value) => value.record_id === "rec-entity-alpha")).toBe(true);
      expect(values.some((value) => value.universal_kind === "core:artifact")).toBe(true);
    });
  });
});

describe("CanonicalRecordQueryDataPort core:search_semantic unavailable-index error", () => {
  it("throws core:semantic_index_unavailable with the registered detail fields when there are zero vectors and no marker", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-1", versionId: "artv-1", path: "src/one.ts", byteLength: 10, validFromGeneration: 1 });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      await expect(dataPort.execute(semanticOperation("core:search_semantic"))).rejects.toMatchObject({
        code: "core:semantic_index_unavailable",
        details: {
          semantic_lane_id: "semantic",
          embedding_profile_id: provider.profile.embedding_profile_id,
          workspace_snapshot_binding_ids: [workspace.workspace_id],
          unavailability_reason: "not_yet_materialized",
        },
      });
    });
  });

  it("throws the same error when no semantic provider is configured at all", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-1", versionId: "artv-1", path: "src/one.ts", byteLength: 10, validFromGeneration: 1 });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas));

      await expect(dataPort.execute(semanticOperation("core:search_semantic"))).rejects.toMatchObject({
        code: "core:semantic_index_unavailable",
        details: { unavailability_reason: "no_provider_configured" },
      });
    });
  });

  it("throws core:query_embedding_failed (not core:semantic_index_unavailable) for an empty/untokenizable query_text once the index is available", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      await expect(dataPort.execute(semanticOperation("core:search_semantic", { query_text: "   !!!   " }))).rejects.toMatchObject({
        code: "core:query_embedding_failed",
        details: { semantic_lane_id: "semantic", embedding_profile_id: provider.profile.embedding_profile_id, failure_code: "empty_or_untokenizable_query_text" },
      });
    });
  });
});

describe("CanonicalRecordQueryDataPort semantic_coverage view", () => {
  const OVERSIZED_BYTES = 2_000_001; // SEMANTIC_MAX_DOCUMENT_BYTES + 1

  async function seedCoverageWorkspace(opened: OpenedWorkspace): Promise<void> {
    await seedBaseline(opened);
    await insertSemanticArtifactVersion(opened, { artifactId: "art-a", versionId: "artv-a", path: "src/a.ts", byteLength: 10, validFromGeneration: 1 });
    await insertSemanticArtifactVersion(opened, { artifactId: "art-b", versionId: "artv-b", path: "src/b.ts", byteLength: 10, validFromGeneration: 1 });
    await insertSemanticArtifactVersion(opened, { artifactId: "art-c", versionId: "artv-c", path: "src/c.ts", byteLength: 10, validFromGeneration: 1 });
    await insertSemanticArtifactVersion(opened, { artifactId: "art-oversized", versionId: "artv-oversized", path: "src/big.bin.txt", byteLength: OVERSIZED_BYTES, validFromGeneration: 1 });
    // A binary artifact must never count toward `artifact_count` at all --
    // mirrors the reconciler's own `encoding <> 'binary'` insert guard.
    await insertSemanticArtifactVersion(opened, { artifactId: "art-binary", versionId: "artv-binary", path: "src/image.png", byteLength: 10, validFromGeneration: 1, encoding: "binary" });
  }

  it("marker current, every eligible artifact covered => complete", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedCoverageWorkspace(opened);
      for (const id of ["a", "b", "c"]) await putSemanticVector(opened, provider, { artifactId: `art-${id}`, versionId: `artv-${id}`, text: `document text for ${id}` });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const coverage = coverageView(evaluation);
      expect(coverage).toMatchObject({ materialization_state: "complete", artifact_count: 4, covered_artifact_count: 3, pending_artifact_count: 0, excluded_artifact_count: 1, unsupported_artifact_count: 0, failed_artifact_count: 0 });
      expect(evaluation.semantic_state).toBe("ready");
    });
  });

  it("marker current, one eligible artifact NOT covered => degraded", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedCoverageWorkspace(opened);
      for (const id of ["a", "b"]) await putSemanticVector(opened, provider, { artifactId: `art-${id}`, versionId: `artv-${id}`, text: `document text for ${id}` });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const coverage = coverageView(evaluation);
      expect(coverage).toMatchObject({ materialization_state: "degraded", artifact_count: 4, covered_artifact_count: 2, pending_artifact_count: 0, excluded_artifact_count: 2 });
      expect(evaluation.semantic_state).toBe("partial");
    });
  });

  it("marker missing, some vectors already present => updating", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedCoverageWorkspace(opened);
      await putSemanticVector(opened, provider, { artifactId: "art-a", versionId: "artv-a", text: "document text for a" });
      // Deliberately never call markSemanticIndexState.
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const coverage = coverageView(evaluation);
      expect(coverage).toMatchObject({ materialization_state: "updating", artifact_count: 4, covered_artifact_count: 1, pending_artifact_count: 2, excluded_artifact_count: 1 });
      expect(evaluation.semantic_state).toBe("updating");
    });
  });
});

describe("CanonicalRecordQueryDataPort core:search_hybrid", () => {
  async function seedHybridWorkspace(opened: OpenedWorkspace, provider: ResolvedSemanticProvider): Promise<void> {
    await seedThreeDocumentWorkspace(opened, provider);
    await insertLexicalDocument(opened, "art-alpha", "artv-alpha", ALPHA_TEXT, 1);
    await insertLexicalDocument(opened, "art-beta", "artv-beta", BETA_TEXT, 1);
    await insertLexicalDocument(opened, "art-gamma", "artv-gamma", GAMMA_TEXT, 1);
  }

  function hybridContentReader(cas: SemanticContentReader): SemanticContentReader {
    return combinedContentReader(cas, { "sha256:artv-alpha": ALPHA_TEXT, "sha256:artv-beta": BETA_TEXT, "sha256:artv-gamma": GAMMA_TEXT });
  }

  it("fuses both lanes: a document matching both lexically and semantically outranks either single-lane document", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedHybridWorkspace(opened, provider);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, hybridContentReader(cas)), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_hybrid"));
      const candidates = candidateValues(evaluation);
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      // `alpha` IS the query text: closest possible semantic match, AND the
      // only document guaranteed to appear near the top of both lanes.
      expect(candidates[0]!.value.body.artifact_id).toBe("art-alpha");
      expect(evaluation.semantic_state).toBeDefined();
    });
  });

  it("degrades to lexical-only, with an 'unavailable' coverage view, when there is no semantic index at all", async () => {
    await withWorkspace(async (opened) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-alpha", versionId: "artv-alpha", path: "src/alpha.ts", byteLength: ALPHA_TEXT.length, validFromGeneration: 1 });
      await insertLexicalDocument(opened, "art-alpha", "artv-alpha", ALPHA_TEXT, 1);
      await markLexicalComplete(opened, 1);
      // Deliberately: no vectors, no semantic marker.
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, fakeContentByHash({ "sha256:artv-alpha": ALPHA_TEXT })), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_hybrid"));
      const candidates = candidateValues(evaluation);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.value.body.artifact_id).toBe("art-alpha");
      const coverage = coverageView(evaluation);
      expect(coverage["materialization_state"]).toBe("unavailable");
      expect(evaluation.semantic_state).toBe("unsupported");
    });
  });

  it("degrades to semantic-only when the semantic index is available but the lexical marker is stale/missing", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      // Deliberately: no lexical_documents seeded, no markLexicalComplete.
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const semanticOnly = await dataPort.execute(semanticOperation("core:search_semantic"));
      const hybrid = await dataPort.execute(semanticOperation("core:search_hybrid"));
      // With no lexical lane to fuse, hybrid's candidate order collapses to
      // exactly the pure-semantic order.
      expect(candidateValues(hybrid).map((entry) => entry.value.body.artifact_id)).toEqual(candidateValues(semanticOnly).map((entry) => entry.value.body.artifact_id));
      expect(coverageView(hybrid)["materialization_state"]).toBe("complete");
      expect(hybrid.semantic_state).toBe("ready");
    });
  });
});

// --- Warm-workspace RAM bound: LRU byte budget + cross-workspace body ----
// interning -----------------------------------------------------------------
//
// Port-level coverage for `approxWarmBytes()`/`evictWarmRecords()`
// (`packages/engine/src/canonical-query-data-port.ts`) and cross-workspace
// body sharing (`RecordBodyInterner`, `packages/engine/src/record-body-interner.ts`).
// The daemon-level LRU eviction end-to-end test lives in
// `tests/phase-warm-records-budget.test.ts`.
describe("SqliteCanonicalQuerySnapshotPort warm-records LRU accounting", () => {
  it("evictWarmRecords drops the warm cache (has_warm_records false, approxWarmBytes 0) and the next records() reloads byte-identical results", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      for (let index = 1; index <= 5; index += 1) await insertRecordOccurrence(opened, `rec-${index}`, "artv-1", 1, { name: `name-${index}` });
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);

      expect(port.approxWarmBytes()).toBe(0);
      expect(await port.has_warm_records(scope)).toBe(false);

      const first = await port.records(scope);
      expect(first).toHaveLength(5);
      expect(await port.has_warm_records(scope)).toBe(true);
      expect(port.approxWarmBytes()).toBeGreaterThan(0);
      const warmBytesBeforeEvict = port.approxWarmBytes();

      port.evictWarmRecords();
      expect(await port.has_warm_records(scope)).toBe(false);
      expect(port.approxWarmBytes()).toBe(0);

      // The next records() call reloads normally through the existing
      // full-load path (no special "post-eviction" code path exists) and
      // must produce byte-identical results to the pre-eviction load, even
      // though it is now a different array instance.
      const second = await port.records(scope);
      expect(second).not.toBe(first);
      expect(second).toEqual(first);
      expect(await port.has_warm_records(scope)).toBe(true);
      // Reloading the SAME generation reports the same approximate byte
      // total as before the eviction (same underlying corpus).
      expect(port.approxWarmBytes()).toBe(warmBytesBeforeEvict);
    });
  });

  it("evicting while a full-load records() call is in flight never corrupts the in-flight result, and the cache is repopulated once it settles", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrence(opened, "rec-1", "artv-1", 1, { name: "one" });

      const recording = new RecordingDatabase(opened.database);
      recording.delayMatcher = (sql) => sql.includes(FULL_LOAD_MARKER);
      recording.delayMs = 50;
      const port = new SqliteCanonicalQuerySnapshotPort(recording);

      const loadPromise = port.records(scope);
      // The full-load SQL call is already in flight (delayed 50ms) --
      // evicting now must be a no-op with respect to that in-flight load:
      // `evictWarmRecords()` only clears SETTLED cache entries
      // (`recordsCache`), never `recordsLoading`'s single-flight promise.
      port.evictWarmRecords();
      const result = await loadPromise;
      expect(result).toHaveLength(1);
      expect(result[0]!.record_id).toBe("rec-1");
      // The load settled AFTER the eviction call and repopulates the cache
      // normally -- eviction never aborts or corrupts a load already in
      // flight when it happens.
      expect(await port.has_warm_records(scope)).toBe(true);

      // A subsequent call resolves synchronously from the now-warm cache
      // (same array instance, no new full-load SQL call).
      recording.calls.length = 0;
      const second = await port.records(scope);
      expect(second).toBe(result);
      expect(recording.calls.some(isFullLoadCall)).toBe(false);
    });
  });

  it("evicting while a windowed delta load is in flight never corrupts it (the delta still reads its own captured `cached` snapshot), and the cache is repopulated once it settles", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      for (let index = 1; index <= 10; index += 1) await insertRecordOccurrence(opened, `rec-${String(index).padStart(2, "0")}`, "artv-1", 1, { name: `name-${index}` });

      const recording = new RecordingDatabase(opened.database);
      const port = new SqliteCanonicalQuerySnapshotPort(recording);
      const first = await port.records(scope);
      expect(first).toHaveLength(10);
      expect(await port.has_warm_records(scope)).toBe(true);

      // Bump the generation with a small, delta-eligible addition (well
      // under the 30% churn fallback threshold).
      await opened.database.run("UPDATE workspace_current_state SET current_generation = 2 WHERE workspace_id = ?", [workspace.workspace_id]);
      await insertRecordOccurrence(opened, "rec-11", "artv-1", 2, { name: "name-11" });

      recording.delayMatcher = (sql) => sql.startsWith("SELECT COUNT(*)");
      recording.delayMs = 50;
      const deltaPromise = port.records(scope);
      // The delta's churn-count queries are in flight (delayed); evicting
      // now must not corrupt the delta -- `deltaRecords` already captured
      // its `cached` (the PRE-eviction `recordsCache` entry) by reference
      // before this call, at the top of `resolveRecords`, and a `Map.clear()`
      // never invalidates an object reference obtained before it ran.
      port.evictWarmRecords();
      const second = await deltaPromise;
      expect(second).toHaveLength(11);
      expect(second.some((record) => record.record_id === "rec-11")).toBe(true);
      expect(await port.has_warm_records(scope)).toBe(true);
    });
  });
});

// --- RecordBodyInterner: cross-workspace decoded-body sharing --------------
//
// Two independently-opened workspace databases seeded with a record sharing
// the SAME `record_id` and the SAME body content -- exactly what decision
// 11's content-derived identity guarantees for a real fork and its donor
// (see `RecordBodyInterner`'s own doc comment). Deliberately does not use
// the full `tests/phase-workspace-fork.test.ts` harness (a real jsts-plugin
// scan/fork through the daemon): the invariant under test here -- that two
// INDEPENDENTLY CONSTRUCTED ports sharing one interner decode a shared
// `record_id` into the literal same `body` object -- does not depend on
// how the two workspaces came to share content, only on the interner's own
// lookup/register contract, so a direct two-database fixture proves it with
// far less machinery.
describe("RecordBodyInterner cross-workspace body sharing", () => {
  type OpenedWorkspace = Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>;

  async function withTwoWorkspaces(test: (openedA: OpenedWorkspace, openedB: OpenedWorkspace) => Promise<void>): Promise<void> {
    const rootA = await mkdtemp(join(tmpdir(), "urdira-interner-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "urdira-interner-b-"));
    const storageA = await createDurableStorage({ rootDir: rootA });
    const storageB = await createDurableStorage({ rootDir: rootB });
    try {
      const workspaceA = { ...workspace, workspace_id: "ws-interner-a" };
      const workspaceB = { ...workspace, workspace_id: "ws-interner-b" };
      await storageA.catalog.registerWorkspace(workspaceA);
      await storageB.catalog.registerWorkspace(workspaceB);
      const openedA = await storageA.openWorkspace(workspaceA.workspace_id);
      const openedB = await storageB.openWorkspace(workspaceB.workspace_id);
      try {
        await test(openedA, openedB);
      } finally {
        await openedA.close();
        await openedB.close();
      }
    } finally {
      await storageA.close();
      await storageB.close();
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  }

  async function seedSharedRecord(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, workspaceId: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const db = opened.database;
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
    await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`, new Uint8Array([1])]);
    await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
    await db.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob:${workspaceId}`, `sha256:${workspaceId}`, 0, "inline"]);
    await db.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, 'art-1', ?, ?, 0, 'utf-8', NULL, 'metadata-digest', 'observation-1', 0, NULL, ?)", [`artv:${workspaceId}`, workspaceId, `blob:${workspaceId}`, `sha256:${workspaceId}`, new Uint8Array([1])]);
    // The SAME `record_id` bytes AND the SAME payload bytes in both
    // workspaces -- exactly the "content-derived id => identical payload
    // bytes" premise `RecordBodyInterner` relies on (decision 11).
    const payload = recordPayload(body);
    await db.run(
      "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES ('rec-shared', ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, 'digest-rec-shared', 'payload-digest', ?, ?, NULL, ?)",
      [workspaceId, `artv:${workspaceId}`, payload.byteLength, payload, payload],
    );
  }

  it("two ports over different workspaces sharing one interner decode a shared record_id into the literal same body object", async () => {
    await withTwoWorkspaces(async (openedA, openedB) => {
      const sharedBody = { name: "shared-record", detail: "x".repeat(256) };
      await seedSharedRecord(openedA, "ws-interner-a", sharedBody);
      await seedSharedRecord(openedB, "ws-interner-b", sharedBody);

      const interner = new RecordBodyInterner();
      const portA = new SqliteCanonicalQuerySnapshotPort(openedA.database, undefined, interner);
      const portB = new SqliteCanonicalQuerySnapshotPort(openedB.database, undefined, interner);

      const recordsA = await portA.records({ scope_type: "single_workspace", workspace_id: "ws-interner-a" });
      const recordsB = await portB.records({ scope_type: "single_workspace", workspace_id: "ws-interner-b" });
      const recordA = recordsA.find((record) => record.record_id === "rec-shared");
      const recordB = recordsB.find((record) => record.record_id === "rec-shared");
      expect(recordA).toBeDefined();
      expect(recordB).toBeDefined();
      // Literal reference identity, not just deep equality -- the whole
      // point of the interner is ONE decoded object shared across ports.
      expect(recordA!.body).toBe(recordB!.body);
      expect(recordA!.body).toEqual(sharedBody);
      // The workspace-specific wrapper fields are still built per port/row,
      // never shared.
      expect(recordA!.workspace_id).toBe("ws-interner-a");
      expect(recordB!.workspace_id).toBe("ws-interner-b");
    });
  });

  it("without a shared interner, two ports decode content-identical records into deep-equal but reference-distinct body objects (baseline, proves the sharing above is the interner's doing)", async () => {
    await withTwoWorkspaces(async (openedA, openedB) => {
      const sharedBody = { name: "shared-record", detail: "x".repeat(256) };
      await seedSharedRecord(openedA, "ws-interner-a", sharedBody);
      await seedSharedRecord(openedB, "ws-interner-b", sharedBody);

      const portA = new SqliteCanonicalQuerySnapshotPort(openedA.database);
      const portB = new SqliteCanonicalQuerySnapshotPort(openedB.database);

      const recordsA = await portA.records({ scope_type: "single_workspace", workspace_id: "ws-interner-a" });
      const recordsB = await portB.records({ scope_type: "single_workspace", workspace_id: "ws-interner-b" });
      const bodyA = recordsA.find((record) => record.record_id === "rec-shared")!.body;
      const bodyB = recordsB.find((record) => record.record_id === "rec-shared")!.body;
      expect(bodyA).not.toBe(bodyB);
      expect(bodyA).toEqual(bodyB);
    });
  });

  it("an interner hit still returns the correct facets (decode is skipped entirely on a full hit, not just the body)", async () => {
    await withTwoWorkspaces(async (openedA, openedB) => {
      // `facets` lives in the same encoded payload as `body`, JSON-encoded
      // as a string field -- see `decodeRow`'s own doc comment for why this
      // reuses the same interner (under a derived key) so a hit can skip
      // `decodeCanonical` entirely rather than only replacing `body` after
      // paying for a decode anyway.
      const payloadWithFacets = encodeCanonical({ body: { name: "shared-record" }, facets: JSON.stringify(["facet-one", "facet-two"]) });
      for (const [opened, workspaceId] of [[openedA, "ws-interner-a"], [openedB, "ws-interner-b"]] as const) {
        const targetDb = opened.database;
        await targetDb.exec("PRAGMA foreign_keys = OFF");
        await targetDb.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1", new Uint8Array([1])]);
        await targetDb.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`, new Uint8Array([1])]);
        await targetDb.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at, current_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now, new Uint8Array([1])]);
        await targetDb.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob:${workspaceId}`, `sha256:${workspaceId}`, 0, "inline"]);
        await targetDb.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, 'art-1', ?, ?, 0, 'utf-8', NULL, 'metadata-digest', 'observation-1', 0, NULL, ?)", [`artv:${workspaceId}`, workspaceId, `blob:${workspaceId}`, `sha256:${workspaceId}`, new Uint8Array([1])]);
        await targetDb.run(
          "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, payload_digest, payload_byte_length, payload_inline, payload_cas_digest, record_payload) VALUES ('rec-shared', ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, 'digest-rec-shared', 'payload-digest', ?, ?, NULL, ?)",
          [workspaceId, `artv:${workspaceId}`, payloadWithFacets.byteLength, payloadWithFacets, payloadWithFacets],
        );
      }

      const interner = new RecordBodyInterner();
      const portA = new SqliteCanonicalQuerySnapshotPort(openedA.database, undefined, interner);
      const portB = new SqliteCanonicalQuerySnapshotPort(openedB.database, undefined, interner);

      const recordsA = await portA.records({ scope_type: "single_workspace", workspace_id: "ws-interner-a" });
      // Second port's decode is the interner HIT for both `record_id` and
      // its derived facets key -- must still yield the correct facets, not
      // an empty array from a botched "skip decode" shortcut.
      const recordsB = await portB.records({ scope_type: "single_workspace", workspace_id: "ws-interner-b" });
      expect(recordsA[0]!.facets).toEqual(["facet-one", "facet-two"]);
      expect(recordsB[0]!.facets).toEqual(["facet-one", "facet-two"]);
    });
  });
});
