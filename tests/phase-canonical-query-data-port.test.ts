import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes, encodeCanonical } from "@urdira/canonical";
import type { QueryScope } from "@urdira/contracts";
import { createDurableStorage, flattenRelationalValue, relationalValueCommands, type SqliteCommand, type SqliteDatabase, type SqliteRunResult, type SqliteValue } from "../packages/storage/src/index.js";
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
  await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?)", ["registry-1", workspace.workspace_id, "1", "core-digest", "lock-1", "registry-digest-1"]);
  await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["snapshot-1", workspace.workspace_id, 0, "manifest-1", "registry-1", "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, "snapshot-digest-1"]);
  await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspace.workspace_id, "snapshot-1", 1, "registry-1", "lock-1", "configuration-1", "freshness-1", 1, now]);
}

function recordPayload(body: Readonly<Record<string, unknown>>): Uint8Array {
  return encodeCanonical(body);
}

// Both statements below (the `record_occurrences` row and its flattened
// `relationalValueCommands`) for one record, as plain `SqliteCommand`s
// rather than executed directly -- lets `insertRecordOccurrencesBulk` pack
// many records' commands into a single `transaction()` round trip to the
// SQLite worker thread instead of one round trip per statement per record
// (see that function's own doc comment for why this matters).
function recordOccurrenceCommands(recordId: string, ownerArtifactVersionId: string, validFromGeneration: number, body: Readonly<Record<string, unknown>>): readonly SqliteCommand[] {
  const payload = encodeCanonical(body);
  const insertOccurrence: SqliteCommand = {
    kind: "run",
    sql: "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES (?, ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?, 'analysis', 'configuration', 'dependencies')",
    params: [recordId, workspace.workspace_id, ownerArtifactVersionId, validFromGeneration, `digest-${recordId}`, digestBytes(payload), payload.byteLength],
  };
  return [insertOccurrence, ...relationalValueCommands(flattenRelationalValue(workspace.workspace_id, recordId, validFromGeneration, body))];
}

async function insertRecordOccurrence(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, recordId: string, ownerArtifactVersionId: string, validFromGeneration: number, body: Readonly<Record<string, unknown>>): Promise<void> {
  await opened.database.transaction(recordOccurrenceCommands(recordId, ownerArtifactVersionId, validFromGeneration, body));
}

async function insertArtifactVersion(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactVersionId: string, contentHash: string, encoding: string, artifactId = "art-1", normalizedPath = "src/index.ts", artifactKind = "source_file", languageHint: string | null = null): Promise<void> {
  await opened.database.run("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, ?)", [artifactId, workspace.workspace_id, `file:///canonical-query/${normalizedPath}`, normalizedPath, normalizedPath, artifactKind]);
  await opened.database.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob-${artifactVersionId}`, contentHash, 0, "inline"]);
  await opened.database.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'metadata-digest', 'observation-1', 0, NULL)", [artifactVersionId, workspace.workspace_id, artifactId, `blob-${artifactVersionId}`, contentHash, encoding, languageHint]);
}

// Bulk variant of `insertRecordOccurrence`, batched 100 rows per
// `transaction()` call (comfortably under SQLite's bound-parameter cap --
// each row contributes ~8 params across its own statements) so a
// corpus-scale seed (thousands of rows) stays fast to set up.
//
// This used to call `insertRecordOccurrence` once per row despite the
// comment above already claiming "100 rows/statement": each row was really
// two separate `database.run`/`database.transaction` round trips to the
// SQLite worker thread (packages/storage/src/sqlite.ts), so a 10,001-row
// seed cost >20,000 worker round trips and dominated this file's slowest
// test's runtime (measured ~8.5s of it isolated, the vast majority of the
// test) -- exactly the kind of load that tips a borderline-but-passing test
// into a `Test timed out in 60000ms` once the full `pnpm test:coverage` run
// puts a few dozen other test files' work on the same CPUs at once (see
// docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md
// §10.6 and §10.7 for this exact test's own prior flake history). Packing
// every row in a `BATCH`-sized chunk into ONE `transaction()` call cuts that
// to one round trip per chunk (~1% of the round trips at BATCH=100),
// without changing a single row written -- same statements, same params,
// same end state, just fewer messages to get there.
async function insertRecordOccurrencesBulk(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, count: number, ownerArtifactVersionId: string, validFromGeneration: number): Promise<void> {
  const BATCH = 100;
  for (let start = 0; start < count; start += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, count - start) }, (_unused, offset) => start + offset);
    const commands = rows.flatMap((index) => recordOccurrenceCommands(`bulk-rec-${String(index).padStart(6, "0")}`, ownerArtifactVersionId, validFromGeneration, { name: `bulk-${index}` }));
    await opened.database.transaction(commands);
  }
}

async function insertCapabilityState(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, stateKey: string, providerId: string, status: string, affectedArtifactIds: readonly string[] = []): Promise<void> {
  const payload = encodeCanonical({ capability: "core:symbol_resolution", capability_contract_version: "1", provider_id: providerId, provider_version: "1", status, reason_codes: [], affected_artifact_ids: affectedArtifactIds, diagnostic_record_ids: [] });
  await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'capability_state', ?, NULL, NULL, NULL, ?)", [stateKey, workspace.workspace_id, JSON.stringify({ capability: "core:symbol_resolution", capability_contract_version: "1", provider_id: providerId, provider_version: "1", status, reason_codes: [], affected_artifact_ids: affectedArtifactIds, diagnostic_record_ids: [] }), now]);
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
    await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?)", ["registry-1", workspace.workspace_id, "1", "core-digest", "lock-1", "registry-digest-1"]);
    // Two real, permanently-recorded snapshots for this workspace: an old
    // one ("snapshot-0", generation 0) that is no longer current, and the
    // current one ("snapshot-1", generation 1) `workspace_current_state`
    // actually points at.
    for (const [snapshotId, generation] of [["snapshot-0", 0], ["snapshot-1", 1]] as const) {
      await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshotId, workspace.workspace_id, generation, `manifest-${generation}`, "registry-1", "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest-${generation}`]);
    }
    await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspace.workspace_id, "snapshot-1", 1, "registry-1", "lock-1", "configuration-1", "freshness-1", 1, now]);
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
  await opened.database.run(
    "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) VALUES (?, ?, 'entity', ?, 'created', ?, ?, ?, NULL, 'art-1', ?, ?, ?)",
    [options.assignmentId, workspace.workspace_id, options.identityId, options.identityKey, `digest-${options.identityKey}`, options.recordId, options.ownerArtifactVersionId, options.validFromGeneration, options.validToGeneration ?? null],
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
// single one (unlike the reconciler's per-document normalization/FTS5 insertion,
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
  // V8 coverage instrumentation roughly triples the cost of the synthetic
  // 4,500-row SQLite fixture; keep the behavioral assertion intact without
  // turning a coverage run into a false timeout.
  }, 60_000);

  it("exposes bounded query batches without retaining a second complete corpus", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      await insertRecordOccurrencesBulk(opened, 1_025, "artv-1", 1);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const sizes: number[] = [];
      let total = 0;
      for await (const batch of port.records_for_query_batches(scope, 256)) {
        sizes.push(batch.length);
        total += batch.length;
      }
      expect(sizes).toEqual([256, 256, 256, 256, 1]);
      expect(total).toBe(1_025);
    });
  }, 60_000);
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
describe("SqliteCanonicalQuerySnapshotPort/CanonicalRecordQueryDataPort corpus-scale behavior", () => {
  it("warm-up does not load or traverse the record corpus", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      await insertArtifactVersion(opened, "artv-1", "sha256:aaaa", "utf-8");
      const recordCount = 4_500;
      await insertRecordOccurrencesBulk(opened, recordCount, "artv-1", 1);

      const snapshot = new SqliteCanonicalQuerySnapshotPort(opened.database);
      const dataPort = new CanonicalRecordQueryDataPort(snapshot);

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

      // The new query warm-up is metadata-only. The first real query owns
      // bounded SQL reads and selected hydration; startup never traverses
      // the full corpus or builds a global identity map.
      expect(yieldCount).toBe(0);
      expect(await snapshot.has_warm_records(scope)).toBe(false);
    });
  }, 60_000);

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
      // One row beyond the 10,000-row page is the smallest corpus that
      // exercises the boundary without adding unrelated CI runtime.
      const recordCount = 10_001;
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
  it("narrows a symbol selector by context_artifact even when no module container record is materialized", async () => {
    const declarationA: CanonicalQueryRecord = {
      ...stubRecord("rec-session-a", "artv-a", { path: "src/server/session.ts", name: "Session" }),
      owner_artifact_id: "art-a",
    };
    const declarationB: CanonicalQueryRecord = {
      ...stubRecord("rec-session-b", "artv-b", { path: "src/test/session.ts", name: "Session" }),
      owner_artifact_id: "art-b",
    };
    const port = new CanonicalRecordQueryDataPort(stubPort({ records: async () => [declarationA, declarationB] }));
    const evaluation = await port.execute({
      operation_id: "core:get_source",
      result_streams: ["sources"],
      arguments: { subjects: [{ subject_type: "symbol", name: "Session", context_artifact: "src/server/session.ts" }], source: { mode: "signature", max_characters_per_snippet: 2000, max_total_characters: 2000, context_lines: 0 } },
      scope,
    });
    expect(sourceBundles(evaluation).map((bundle) => (bundle.primary_result as { record_id: string }).record_id)).toEqual(["rec-session-a"]);
  });

  it.each([
    { subject_type: "artifact", path: "src/a.ts" },
    { subject_type: "artifact", artifact_id: "art-1" },
  ])("resolves a direct artifact selector from the source catalog without reading the structural corpus: $subject_type $path$artifact_id", async (selector) => {
    const artifact: CanonicalQueryRecord = {
      record_id: "artifact-record:artv-1",
      workspace_id: workspace.workspace_id,
      category: "artifact_subject",
      kind: "core:source_file",
      universal_kind: "core:artifact",
      owner_artifact_id: "art-1",
      owner_artifact_version_id: "artv-1",
      body: { path: "src/a.ts", artifact_id: "art-1", artifact_version_id: "artv-1" },
    };
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records_by_ids: async () => [],
      artifacts_by_filter: async () => [artifact],
      records: async () => { throw new Error("full corpus must not be read"); },
      records_for_query: async () => { throw new Error("query corpus must not be read"); },
    }));
    const evaluation = await port.execute({
      operation_id: "core:get_source",
      result_streams: ["sources"],
      arguments: { subjects: [selector], source: { mode: "body", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 } },
      scope,
    });
    const bundles = sourceBundles(evaluation);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.optional_source_snippets[0]!.text).toBe(FILE_TEXT);
  });

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

  /**
   * E-P0j adversarial review (2026-09-07, fix-ep0j-review): as of Frente
   * E-P0j (`docs/decisions/26-v4-structural-store.md`), a v4 entity's own
   * `body["start"]`/`["end"]` is the WHOLE declaration span, which for a
   * decorated class/interface member begins at that member's own leading
   * decorator(s) -- confirmed live against the real Rust producer
   * (`urdira-jsts-syntax-worker`'s
   * `decl_span_covers_member_decorators_but_not_a_top_level_declarations_own_leading_decorator`).
   * Before this fix, "signature" mode took the first line starting at
   * `start` unconditionally, so a decorated member's "signature" snippet
   * was the DECORATOR line (`@Injectable()`), never the member's actual
   * signature. `body["name_start"]` (additive, same task) anchors the
   * signature on the member's own name's line instead.
   */
  it("signature mode anchors on the declaration's own name line, not a leading decorator, when name_start is present", async () => {
    const decoratedFileText = "class Widget {\n  @Injectable()\n  method(x: number): void {\n    return;\n  }\n}\n";
    const methodStart = decoratedFileText.indexOf("@Injectable");
    const methodEnd = decoratedFileText.length;
    const nameStart = decoratedFileText.indexOf("method(x");
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [stubRecord("rec-method", "artv-decorated", { path: "src/widget.ts", start: methodStart, end: methodEnd, name_start: nameStart, name: "method" })],
      async artifact_text(_scope, artifactVersionId) {
        return artifactVersionId === "artv-decorated" ? { text: decoratedFileText } : undefined;
      },
    }));
    const evaluation = await port.execute(getSourceOperation(["rec-method"], { mode: "signature", max_characters_per_snippet: 4000, max_total_characters: 16000, context_lines: 0 }));
    const bundles = sourceBundles(evaluation);
    expect(bundles[0]!.optional_source_snippets[0]!.text).toBe("  method(x: number): void {");
    // `rec-greet` (this file's shared fixture) never sets `name_start` --
    // the immediately preceding test already covers that fallback path
    // ("returns only the first line of the span in signature mode" still
    // anchors on `start` unchanged).
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

// Plan 2026-09-06 (Frente N, §5.1): SNIPPET_POLICY inline one-line snippets
// for `core:find_references` ("line") and `core:get_outline` ("signature",
// level-0/root members only). Reuses this file's `FILE_TEXT`/`stubPort`
// fixtures (`GREET_START`/`GREET_END`/`FAREWELL_START`/`FAREWELL_END` --
// `FILE_TEXT`'s own doc comment above gives the exact line layout) so the
// hydrated snippet text/line numbers can be asserted exactly, the same way
// the `core:get_source` tests above do.
describe("CanonicalRecordQueryDataPort SNIPPET_POLICY inline snippets (plan 2026-09-06, Frente N)", () => {
  // `  return "bye";\n` is FILE_TEXT's line 6 (1: `function greet() {`, 2:
  // `  return "hello";`, 3: `}`, 4: ``, 5: `function farewell() {`, 6: `  return
  // "bye";`). The relation's own span sits INSIDE that line (just the
  // `"bye"` token) so "line" mode's line-alignment (not merely `[start,
  // end)`) is what makes the returned snippet the whole line.
  const BYE_TOKEN_START = FILE_TEXT.indexOf("\"bye\"");
  const BYE_TOKEN_END = BYE_TOKEN_START + "\"bye\"".length;
  const BYE_LINE_START = FILE_TEXT.lastIndexOf("\n", BYE_TOKEN_START - 1) + 1;
  const BYE_LINE_END = FILE_TEXT.indexOf("\n", BYE_TOKEN_END) + 1;

  function callRelation(recordId: string, sourceId: string, targetId: string): CanonicalQueryRecord {
    return {
      record_id: recordId,
      workspace_id: workspace.workspace_id,
      category: "relation",
      kind: "jsts:relation_call",
      universal_kind: "core:call",
      owner_artifact_id: "art-1",
      owner_artifact_version_id: "artv-1",
      facets: [],
      body: { source_id: sourceId, target_id: targetId, classification: "confirmed" },
      primary_source_span: { artifact_version_id: "artv-1", start_byte: String(BYE_TOKEN_START), end_byte: String(BYE_TOKEN_END), start_line: "6", end_line: "6" },
    };
  }

  function findReferencesPort(): CanonicalRecordQueryDataPort {
    return new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        stubRecord("rec-greet", "artv-1", { path: "src/a.ts", start: GREET_START, end: GREET_END, name: "greet" }),
        stubRecord("rec-farewell", "artv-1", { path: "src/a.ts", start: FAREWELL_START, end: FAREWELL_END, name: "farewell" }),
        callRelation("rec-call-1", "rec-farewell", "rec-greet"),
      ],
    }));
  }

  it("core:find_references attaches a one-line \"line\"-mode snippet (the full source line, not merely the reference token) with a correct start_line", async () => {
    const port = findReferencesPort();
    const evaluation = await port.execute({
      operation_id: "core:find_references",
      result_streams: ["references", "owners"],
      arguments: { target: { subject_type: "symbol", name: "greet" } },
      scope,
    });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    expect(references).toHaveLength(1);
    const value = references[0]!.value as { source_span?: { start_line?: string; end_line?: string }; optional_source_snippets?: readonly { text: string; span: { start_byte: string; end_byte: string; start_line?: string; end_line?: string } }[] };
    const snippets = value.optional_source_snippets ?? [];
    expect(snippets).toHaveLength(1);
    const snippet = snippets[0]!;
    // The whole line, not `FILE_TEXT.slice(BYE_TOKEN_START, BYE_TOKEN_END)`
    // (which would be just `"bye"`) -- proves "line" mode extends to the
    // enclosing line rather than reusing the raw `[start, end)` span like
    // "signature"/"relevant"/"body" do.
    expect(snippet.text).toBe(FILE_TEXT.slice(BYE_LINE_START, BYE_LINE_END));
    expect(snippet.text).toContain("bye");
    expect(snippet.span.start_byte).toBe(String(BYE_LINE_START));
    expect(snippet.span.end_byte).toBe(String(BYE_LINE_END));
    // `context_lines: 0` -- the stored canonical span's own line numbers are
    // reused verbatim (`sourceSnippet`'s `useStoredLines` branch), so this
    // matches the bundle's own `source_span.start_line`/`end_line` exactly.
    expect(snippet.span.start_line).toBe("6");
    expect(snippet.span.end_line).toBe("6");
    expect(snippet.span.start_line).toBe(value.source_span?.start_line);
    expect(snippet.span.end_line).toBe(value.source_span?.end_line);
  });

  it("core:find_references omits the snippet (never fails the query) when the artifact text is unavailable", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        stubRecord("rec-greet", "artv-1", { path: "src/a.ts", start: GREET_START, end: GREET_END, name: "greet" }),
        stubRecord("rec-farewell", "artv-missing", { path: "src/b.ts", start: 0, end: 3, name: "farewell" }),
        { ...callRelation("rec-call-2", "rec-farewell", "rec-greet"), owner_artifact_version_id: "artv-missing", primary_source_span: { artifact_version_id: "artv-missing", start_byte: "0", end_byte: "1", start_line: "1", end_line: "1" } },
      ],
    }));
    const evaluation = await port.execute({
      operation_id: "core:find_references",
      result_streams: ["references", "owners"],
      arguments: { target: { subject_type: "symbol", name: "greet" } },
      scope,
    });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    expect(references).toHaveLength(1);
    const value = references[0]!.value as { optional_source_snippets?: readonly unknown[] };
    expect(value.optional_source_snippets ?? []).toEqual([]);
  });

  function containsRelation(recordId: string, sourceId: string, targetId: string): CanonicalQueryRecord {
    return {
      record_id: recordId,
      workspace_id: workspace.workspace_id,
      category: "relation",
      kind: "jsts:relation_contains",
      universal_kind: "core:contains",
      owner_artifact_id: "art-1",
      owner_artifact_version_id: "artv-1",
      facets: [],
      body: { source_id: sourceId, target_id: targetId, classification: "confirmed" },
    };
  }

  it("core:get_outline attaches a one-line \"signature\"-mode snippet only to level-0 (root) members, never deeper-nested ones", async () => {
    const moduleRecord = stubRecord("rec-module", "artv-1", { path: "src/a.ts", name: "a.ts" });
    const rootMember = stubRecord("rec-farewell", "artv-1", { path: "src/a.ts", start: FAREWELL_START, end: FAREWELL_END, name: "farewell" });
    const nestedMember = stubRecord("rec-greet", "artv-1", { path: "src/a.ts", start: GREET_START, end: GREET_END, name: "greet" });
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        moduleRecord,
        rootMember,
        nestedMember,
        containsRelation("rec-contains-1", "rec-module", "rec-farewell"),
        containsRelation("rec-contains-2", "rec-farewell", "rec-greet"),
      ],
    }));
    const evaluation = await port.execute({
      operation_id: "core:get_outline",
      result_streams: ["members", "pending_sites"],
      arguments: { container: { subject_type: "entity", entity_id: "rec-module" }, depth: 2 },
      scope,
    });
    const members = (evaluation.streams["members"] ?? []) as readonly { readonly value: unknown }[];
    expect(members.map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(expect.arrayContaining(["rec-farewell", "rec-greet"]));

    const rootEntry = members.find((entry) => (entry.value as { record_id: string }).record_id === "rec-farewell")!;
    const rootSnippets = (rootEntry.value as { optional_source_snippets?: readonly { text: string }[] }).optional_source_snippets ?? [];
    expect(rootSnippets).toHaveLength(1);
    // "signature" mode: the first line of the body, not the whole
    // (3-line) `farewell` function.
    expect(rootSnippets[0]!.text).toBe(FILE_TEXT.slice(FAREWELL_START, FILE_TEXT.indexOf("\n", FAREWELL_START)));

    const nestedEntry = members.find((entry) => (entry.value as { record_id: string }).record_id === "rec-greet")!;
    const nestedSnippets = (nestedEntry.value as { optional_source_snippets?: readonly unknown[] }).optional_source_snippets ?? [];
    expect(nestedSnippets).toEqual([]);
  });

  /**
   * Plan 2026-09-06 (Frente N, §5.1.2): "una lectura CAS por artefacto
   * distinto (LRU 64); mide p95 de find_references con 50 resultados ...
   * (test de tiempo orientativo, no gate); si sube > 30 ms, TEXT_CACHE_LIMIT
   * a 256." Orientative only -- no hard threshold assertion (a shared CI
   * runner is not a clean-room timing environment, and the plan itself
   * calls this "no gate"). Measures the ADDED cost of this front's own
   * hydration: 50 `references` bundles across 50 distinct artifact_version_
   * ids (within `TEXT_CACHE_LIMIT`'s 64-entry cap, so no eviction pressure)
   * with a real per-call CAS read, against the identical 50-bundle query
   * with no content reader at all (this operation's exact pre-plan
   * behavior: zero CAS reads, no snippets). The p95 delta is logged via
   * `console.info` for the evidence record; see the final report for the
   * observed number and the TEXT_CACHE_LIMIT decision it produced.
   */
  it("p95 of core:find_references with 50 bundles: measures the added cost of inline snippet hydration (orientative)", async () => {
    const fileTextFor = (index: number): string => `// file ${index}\nfunction caller${index}() {\n  target(${index});\n}\n`;
    const targetSpanStart = 0;
    const targetSpanEnd = 6;
    const records: CanonicalQueryRecord[] = [
      { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: targetSpanStart, end: targetSpanEnd, name: "target" } },
    ];
    for (let index = 0; index < 50; index += 1) {
      const text = fileTextFor(index);
      const callStart = text.indexOf(`target(${index})`);
      const callEnd = callStart + `target(${index})`.length;
      records.push({ record_id: `rec-caller-${index}`, workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: `art-${index}`, owner_artifact_version_id: `artv-${index}`, facets: [], body: { path: `src/caller-${index}.ts`, name: `caller${index}` } });
      records.push({
        record_id: `rec-call-${index}`, workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
        owner_artifact_id: `art-${index}`, owner_artifact_version_id: `artv-${index}`, facets: [],
        body: { source_id: `rec-caller-${index}`, target_id: "rec-target", classification: "confirmed" },
        primary_source_span: { artifact_version_id: `artv-${index}`, start_byte: String(callStart), end_byte: String(callEnd), start_line: "3", end_line: "3" },
      });
    }
    const operation = { operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope };

    const withoutContent = new CanonicalRecordQueryDataPort(stubPort({ records: async () => records, artifact_text: async () => undefined }));
    const withContent = new CanonicalRecordQueryDataPort(stubPort({ records: async () => records, artifact_text: async (_scope, artifactVersionId) => {
      const match = /^artv-(\d+)$/.exec(artifactVersionId);
      return match === undefined || match === null ? undefined : { text: fileTextFor(Number(match[1])) };
    } }));

    const timeRuns = async (port: CanonicalRecordQueryDataPort, runs: number): Promise<number[]> => {
      const samples: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const start = performance.now();
        await port.execute(operation);
        samples.push(performance.now() - start);
      }
      return samples;
    };
    const p95 = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.floor(samples.length * 0.95)]!;

    await timeRuns(withoutContent, 3); // warm up JIT/module-level caches
    await timeRuns(withContent, 3);
    const baseline = p95(await timeRuns(withoutContent, 20));
    const withSnippets = p95(await timeRuns(withContent, 20));
    const withSnippetsEvaluation = await withContent.execute(operation);
    expect((withSnippetsEvaluation.streams["references"] ?? []).length).toBe(50);
    console.info(`[Frente N p95] find_references x50: baseline=${baseline.toFixed(2)}ms with_snippets=${withSnippets.toFixed(2)}ms delta=${(withSnippets - baseline).toFixed(2)}ms`);
  });

  // Adversarial review 2026-09-06: the implementer's own p95 test above
  // stubs `artifact_text` with a synchronous in-memory template literal --
  // it never touches a disk, so it cannot show what a real CAS read costs
  // (the concern the plan's §5.1.2 "p95 of find_references" line and R13's
  // performance criterion actually care about). This measures REAL
  // `fs.readFile` cost: 50 distinct fixture files written to a temp
  // directory on disk (cold OS page cache for each -- freshly written,
  // never read before this test), `artifact_text` doing a genuine
  // `readFile` per distinct artifact (within `TEXT_CACHE_LIMIT`'s 64-entry
  // cap, so the LRU never evicts and this measures pure read cost, not
  // eviction thrash). No hard threshold: this is the orientative number the
  // plan's R13 evidence record asks for, logged via `console.info`.
  it("measures the added cost of find_references snippet hydration against REAL on-disk files for 50 distinct artifacts (orientative, not a gate)", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-snippet-real-disk-"));
    try {
      const fileTextFor = (index: number): string => `// file ${index}\nfunction caller${index}() {\n  target(${index});\n}\n`;
      const pathFor = (index: number): string => join(root, `caller-${index}.ts`);
      const records: CanonicalQueryRecord[] = [
        { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 6, name: "target" } },
      ];
      for (let index = 0; index < 50; index += 1) {
        const text = fileTextFor(index);
        await writeFile(pathFor(index), text, "utf-8");
        const callStart = text.indexOf(`target(${index})`);
        const callEnd = callStart + `target(${index})`.length;
        records.push({ record_id: `rec-caller-${index}`, workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: `art-${index}`, owner_artifact_version_id: `artv-${index}`, facets: [], body: { path: `src/caller-${index}.ts`, name: `caller${index}` } });
        records.push({
          record_id: `rec-call-${index}`, workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
          owner_artifact_id: `art-${index}`, owner_artifact_version_id: `artv-${index}`, facets: [],
          body: { source_id: `rec-caller-${index}`, target_id: "rec-target", classification: "confirmed" },
          primary_source_span: { artifact_version_id: `artv-${index}`, start_byte: String(callStart), end_byte: String(callEnd), start_line: "3", end_line: "3" },
        });
      }
      const operation = { operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope };
      const freshPortWithDisk = (): CanonicalRecordQueryDataPort => new CanonicalRecordQueryDataPort(stubPort({
        records: async () => records,
        artifact_text: async (_scope, artifactVersionId) => {
          const match = /^artv-(\d+)$/.exec(artifactVersionId);
          if (match === null) return undefined;
          const bytes = await readFile(pathFor(Number(match[1])));
          return { text: new TextDecoder("utf-8").decode(bytes) };
        },
      }));
      const freshPortWithoutDisk = (): CanonicalRecordQueryDataPort => new CanonicalRecordQueryDataPort(stubPort({ records: async () => records, artifact_text: async () => undefined }));

      // A fresh port per timed sample: `textCache` is per-instance, so this
      // always exercises a cold cache -- 50 real `readFile` calls per
      // `with_disk` sample, not 49 cache hits after the first one.
      const baselineSamples: number[] = [];
      const withDiskSamples: number[] = [];
      let lastWithDiskEvaluation: Awaited<ReturnType<CanonicalRecordQueryDataPort["execute"]>> | undefined;
      for (let run = 0; run < 5; run += 1) {
        const startBaseline = performance.now();
        await freshPortWithoutDisk().execute(operation);
        baselineSamples.push(performance.now() - startBaseline);
        const startWithDisk = performance.now();
        lastWithDiskEvaluation = await freshPortWithDisk().execute(operation);
        withDiskSamples.push(performance.now() - startWithDisk);
      }
      expect((lastWithDiskEvaluation?.streams["references"] ?? []).length).toBe(50);
      const meanBaseline = baselineSamples.reduce((sum, value) => sum + value, 0) / baselineSamples.length;
      const meanWithDisk = withDiskSamples.reduce((sum, value) => sum + value, 0) / withDiskSamples.length;
      console.info(`[Frente N real-disk] find_references x50, 5 cold-port runs: baseline_mean=${meanBaseline.toFixed(2)}ms with_disk_mean=${meanWithDisk.toFixed(2)}ms delta=${(meanWithDisk - meanBaseline).toFixed(2)}ms all_baseline=${baselineSamples.map((v) => v.toFixed(1)).join(",")} all_with_disk=${withDiskSamples.map((v) => v.toFixed(1)).join(",")}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Adversarial review 2026-09-06: `sourceSnippet`'s two truncation points
  // (`maxCharactersPerSnippet`, `remainingBudget`) used to cut with a plain
  // `slice(0, limit)`. A line whose 200th character is the low half of a
  // UTF-16 surrogate pair (an astral character, e.g. an emoji) would be cut
  // between the pair's two units, leaving a lone/unpaired surrogate in the
  // returned snippet text. Fixed by `truncateWithoutSplittingSurrogatePair`
  // (canonical-query-data-port.ts); this proves the fix: a line built so the
  // pair straddles exactly the 200-character boundary.
  it("core:find_references truncation never splits a UTF-16 surrogate pair at the 200-character snippet boundary", async () => {
    const astral = "\u{1F600}"; // U+1F600, a surrogate pair (2 UTF-16 code units): "😀".
    expect(astral.length).toBe(2);
    // 199 plain ASCII characters, then the astral pair starting at index 199
    // (occupying indices 199-200) -- so a naive `slice(0, 200)` lands
    // exactly between the pair's high and low surrogate.
    const prefix = "x".repeat(199);
    const line = `${prefix}${astral}tail\n`;
    const fileText = `${line}`;
    const callRecord: CanonicalQueryRecord = {
      record_id: "rec-caller", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [], body: { path: "src/a.ts", name: "caller" },
    };
    const targetRecord: CanonicalQueryRecord = {
      record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 1, name: "target" },
    };
    const relation: CanonicalQueryRecord = {
      record_id: "rec-call", workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
      owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [],
      body: { source_id: "rec-caller", target_id: "rec-target", classification: "confirmed" },
      // Span sits at the very start of the line so "line" mode's line
      // slice is exactly `[0, line.length)` -- the whole line, > 200 chars.
      primary_source_span: { artifact_version_id: "artv-1", start_byte: "0", end_byte: "1", start_line: "1", end_line: "1" },
    };
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [callRecord, targetRecord, relation],
      artifact_text: async (_scope, artifactVersionId) => artifactVersionId === "artv-1" ? { text: fileText } : undefined,
    }));
    const evaluation = await port.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    expect(references).toHaveLength(1);
    const value = references[0]!.value as { optional_source_snippets?: readonly { text: string; truncated: boolean }[] };
    const snippet = value.optional_source_snippets?.[0];
    expect(snippet).toBeDefined();
    expect(snippet!.truncated).toBe(true);
    // The critical assertion: no lone/unpaired surrogate anywhere in the
    // returned text (would throw on the strict round-trip below otherwise).
    for (let index = 0; index < snippet!.text.length; index += 1) {
      const code = snippet!.text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) expect(snippet!.text.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
      if (code >= 0xdc00 && code <= 0xdfff) expect(snippet!.text.charCodeAt(index - 1)).toBeLessThanOrEqual(0xdbff);
    }
    // Round-trips through strict UTF-8 encode/decode without producing the
    // U+FFFD replacement character a lone surrogate would force.
    const roundTripped = new TextDecoder("utf-8").decode(new TextEncoder().encode(snippet!.text));
    expect(roundTripped).not.toContain("�");
    // Either the pair survived whole (199 + 2 = 201 > 200, so the fix backs
    // off to 199 chars) or it was correctly excluded -- never a bare 200
    // that would have split it.
    expect(snippet!.text.length === 199 || snippet!.text.length === 201).toBe(true);
  });

  // Adversarial review 2026-09-06: CRLF line endings. `lineEnd` searches for
  // "\n" only, so the returned "line" text includes the trailing "\r" as
  // part of the slice -- proves that's harmless (the raw span/text fields
  // carry it, same as any other mode already would for a CRLF file; the MCP
  // compact renderer's `.trim()` strips it before display, covered in
  // tests/phase13-mcp.test.ts).
  it("core:find_references \"line\" mode on a CRLF file returns the correct line, trailing CR included in the raw text field", async () => {
    const fileText = "function caller() {\r\n  target();\r\n}\r\n";
    const callStart = fileText.indexOf("target();");
    const callEnd = callStart + "target();".length;
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        { record_id: "rec-caller", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [], body: { path: "src/a.ts", name: "caller" } },
        { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 1, name: "target" } },
        {
          record_id: "rec-call", workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
          owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [],
          body: { source_id: "rec-caller", target_id: "rec-target", classification: "confirmed" },
          primary_source_span: { artifact_version_id: "artv-1", start_byte: String(callStart), end_byte: String(callEnd), start_line: "2", end_line: "2" },
        },
      ],
      artifact_text: async (_scope, artifactVersionId) => artifactVersionId === "artv-1" ? { text: fileText } : undefined,
    }));
    const evaluation = await port.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    const value = references[0]!.value as { optional_source_snippets?: readonly { text: string }[] };
    const snippet = value.optional_source_snippets?.[0];
    expect(snippet).toBeDefined();
    expect(snippet!.text).toBe("  target();\r\n");
    expect(snippet!.text).not.toContain("function caller");
    expect(snippet!.text).not.toContain("}");
  });

  // Adversarial review 2026-09-06: span on the LAST line of a file that has
  // no trailing newline at all -- `lineEnd`'s `text.indexOf("\n", index)`
  // must fall back to `text.length`, not misbehave/loop/return -1 downstream.
  it("core:find_references \"line\" mode on a span at end-of-file with no trailing newline returns the final (unterminated) line exactly", async () => {
    const fileText = "function caller() {\n  target();\n}"; // no trailing \n
    const callStart = fileText.indexOf("target();");
    const callEnd = callStart + "target();".length;
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        { record_id: "rec-caller", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [], body: { path: "src/a.ts", name: "caller" } },
        { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 1, name: "target" } },
        {
          record_id: "rec-call", workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
          owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [],
          body: { source_id: "rec-caller", target_id: "rec-target", classification: "confirmed" },
          primary_source_span: { artifact_version_id: "artv-1", start_byte: String(callStart), end_byte: String(callEnd), start_line: "2", end_line: "2" },
        },
      ],
      artifact_text: async (_scope, artifactVersionId) => artifactVersionId === "artv-1" ? { text: fileText } : undefined,
    }));
    const evaluation = await port.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    const value = references[0]!.value as { optional_source_snippets?: readonly { text: string }[] };
    expect(value.optional_source_snippets?.[0]?.text).toBe("  target();\n");

    // A span on the truly LAST line (no newline after it anywhere in the
    // file) must not run off the end of the string either.
    const lastLineFileText = "function caller() {\n  target();\n}";
    const lastCallStart = lastLineFileText.length - 1; // the final "}"
    const portLastLine = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        { record_id: "rec-caller-2", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-2", owner_artifact_version_id: "artv-2", facets: [], body: { path: "src/b.ts", name: "caller2" } },
        { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 1, name: "target" } },
        {
          record_id: "rec-call-2", workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
          owner_artifact_id: "art-2", owner_artifact_version_id: "artv-2", facets: [],
          body: { source_id: "rec-caller-2", target_id: "rec-target", classification: "confirmed" },
          primary_source_span: { artifact_version_id: "artv-2", start_byte: String(lastCallStart), end_byte: String(lastCallStart + 1), start_line: "3", end_line: "3" },
        },
      ],
      artifact_text: async (_scope, artifactVersionId) => artifactVersionId === "artv-2" ? { text: lastLineFileText } : undefined,
    }));
    const lastLineEvaluation = await portLastLine.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope });
    const lastLineReferences = (lastLineEvaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    const lastLineValue = lastLineReferences[0]!.value as { optional_source_snippets?: readonly { text: string }[] };
    expect(lastLineValue.optional_source_snippets?.[0]?.text).toBe("}");
  });

  // Adversarial review 2026-09-06: multibyte content BEFORE the span.
  // `canonical-query-data-port.ts`'s `sourceSnippet` (all modes, not just
  // "line") treats `primary_source_span.start_byte`/`end_byte` as direct
  // JS-string (UTF-16 code unit) indices with no byte->char conversion --
  // verified against the producer side
  // (`crates/urdira-jsts-syntax-worker/src/lib.rs`'s
  // `Utf8ToUtf16::new(text).convert_program(...)`, which converts every swc
  // span from UTF-8 byte offsets to UTF-16 code-unit offsets BEFORE any
  // `ProposedRecord` is built): despite the "byte" field name, these are
  // ALREADY UTF-16 code-unit offsets by the time they reach this port, i.e.
  // exactly what a JS string index expects. This is therefore NOT the
  // byte-vs-char bug it superficially resembles; this test locks in that
  // behavior with real multibyte (2- and 3-byte UTF-8, 1-UTF-16-unit)
  // characters preceding the span, matching production's actual offset
  // convention (a plain `.indexOf`/`.length` on the JS string, exactly as
  // production spans are already converted to mean).
  it("core:find_references \"line\" mode is correct when multibyte (non-ASCII) text precedes the span on the same line", async () => {
    // "café☕" -- 'é' is 2 UTF-8 bytes/1 UTF-16 unit, '☕' is 3 UTF-8
    // bytes/1 UTF-16 unit. If start_byte were a true UTF-8 byte offset used
    // as a direct JS index, this line's span would resolve 2 UTF-16 units
    // too early (missing the true byte-to-unit conversion entirely).
    const fileText = "// café☕ comment\nfunction caller() {\n  target();\n}\n";
    const callStart = fileText.indexOf("target();");
    const callEnd = callStart + "target();".length;
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => [
        { record_id: "rec-caller", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [], body: { path: "src/a.ts", name: "caller" } },
        { record_id: "rec-target", workspace_id: workspace.workspace_id, category: "entity", kind: "function_declaration", universal_kind: "core:function", owner_artifact_id: "art-target", owner_artifact_version_id: "artv-target", facets: [], body: { path: "src/target.ts", start: 0, end: 1, name: "target" } },
        {
          record_id: "rec-call", workspace_id: workspace.workspace_id, category: "relation", kind: "jsts:relation_call", universal_kind: "core:call",
          owner_artifact_id: "art-1", owner_artifact_version_id: "artv-1", facets: [],
          body: { source_id: "rec-caller", target_id: "rec-target", classification: "confirmed" },
          primary_source_span: { artifact_version_id: "artv-1", start_byte: String(callStart), end_byte: String(callEnd), start_line: "3", end_line: "3" },
        },
      ],
      artifact_text: async (_scope, artifactVersionId) => artifactVersionId === "artv-1" ? { text: fileText } : undefined,
    }));
    const evaluation = await port.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "symbol", name: "target" } }, scope });
    const references = (evaluation.streams["references"] ?? []) as readonly { readonly value: unknown }[];
    const value = references[0]!.value as { optional_source_snippets?: readonly { text: string }[] };
    expect(value.optional_source_snippets?.[0]?.text).toBe("  target();\n");
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
      "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES (?, ?, 'entity', ?, ?, 1, 'test', '1', 'art-1', 'artv-1', NULL, NULL, NULL, NULL, NULL, 1, NULL, ?, ?, ?, 'analysis', 'configuration', 'dependencies')",
    (() => {
      const payload = recordPayload({ name: options.name, language: options.language, ...(options.qualifiedName === undefined ? {} : { qualified_name: options.qualifiedName }) });
      return [options.recordId, workspace.workspace_id, options.kind, options.universalKind, `digest-${options.recordId}`, digestBytes(payload), payload.byteLength];
    })(),
  );
  await opened.database.transaction(relationalValueCommands(flattenRelationalValue(workspace.workspace_id, options.recordId, 1, { name: options.name, language: options.language, ...(options.qualifiedName === undefined ? {} : { qualified_name: options.qualifiedName }) })));
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
      await opened.database.run("DELETE FROM record_value_nodes WHERE record_id = ?", ["rec-export-canvas"]);
      await opened.database.transaction(relationalValueCommands(flattenRelationalValue(workspace.workspace_id, "rec-export-canvas", 1, { name: "exportToCanvas", language: "typescript", qualified_name: "export.ts.exportToCanvas" })));
      const { cold, warm } = pushdownPorts(opened.database);
      await warm.data.warm(scope);

      const operation = { operation_id: "core:resolve_symbol", result_streams: ["declarations", "candidates"], arguments: { reference: "export.ts.exportToCanvas" }, scope };
      const coldResult = await cold.data.execute(operation);
      const warmResult = await warm.data.execute(operation);
      expect(coldResult).toEqual(warmResult);
      expect((coldResult.streams["declarations"] as readonly unknown[]).length).toBe(1);
      // Complex fallback queries use the uncached v2 SQL path; they do not
      // turn a one-off graph/name lookup into a retained corpus.
      expect(await cold.snapshot.has_warm_records(scope)).toBe(false);
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

describe("CanonicalRecordQueryDataPort core:build_context", () => {
  it("resolves task identifiers through bounded point lookups without materializing the full corpus", async () => {
    const registry = stubRecord("rec-registry", "artv-1", { path: "src/languageFeatureRegistry.ts", name: "LanguageFeatureRegistry", start: GREET_START, end: GREET_END });
    const event = stubRecord("rec-event", "artv-1", { path: "src/languageFeatureRegistry.ts", name: "onDidChange", start: FAREWELL_START, end: FAREWELL_END });
    const lookedUp: string[] = [];
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => { throw new Error("full corpus must not be read"); },
      records_for_query: async () => { throw new Error("query corpus must not be read"); },
      records_by_name: async (_scope, name) => {
        lookedUp.push(name);
        return name === "LanguageFeatureRegistry" ? [registry] : name === "onDidChange" ? [event] : [];
      },
    }));

    const evaluation = await port.execute({
      operation_id: "core:build_context",
      operation_version: 1,
      result_streams: ["context"],
      arguments: {
        task: "Improve LanguageFeatureRegistry notifications when onDidChange ordering changes",
        query_class: "source_code",
        facets: ["definitions", "implementations", "tests"],
      },
      scope,
    });

    expect(lookedUp).toContain("LanguageFeatureRegistry");
    expect(lookedUp).toContain("onDidChange");
    const contextItems = (evaluation.streams["context"] ?? []) as ReadonlyArray<{ readonly value: unknown }>;
    const bundles = contextItems.map((entry) => entry.value as { readonly result_set: string; readonly primary_result: { readonly record_id?: string }; readonly optional_source_snippets: readonly unknown[] });
    expect(bundles.map((bundle) => bundle.primary_result.record_id)).toEqual(["rec-registry", "rec-event"]);
    expect(bundles.every((bundle) => bundle.result_set === "context")).toBe(true);
    expect(bundles.every((bundle) => bundle.optional_source_snippets.length > 0)).toBe(true);
  });

  it("returns a bounded empty context when no point-lookup capability is available", async () => {
    const port = new CanonicalRecordQueryDataPort(stubPort({
      records: async () => { throw new Error("full corpus must not be read"); },
      records_for_query: async () => { throw new Error("query corpus must not be read"); },
    }));
    const evaluation = await port.execute({
      operation_id: "core:build_context",
      operation_version: 1,
      result_streams: ["context"],
      arguments: { task: "Improve registry notifications", facets: ["definitions"] },
      scope,
    });
    expect(evaluation.streams["context"]).toEqual([]);
  });
});

// --- D6: core:search_text lexical pushdown ------------------------------
//
// `search_literal` / `records_by_artifact_versions` let `core:search_text`
// answer straight from the FTS5-backed lexical projection
// (`lexical_documents`/`lexical_fts`, built out-of-band by
// `reconcileLexicalProjection` -- see `tests/lexical-maintenance.test.ts` for
// that side) instead of the in-memory corpus scan, which only ever matches
// against RECORD BODY JSON, never real file text. `records_by_artifact_versions`
// synthesizes its `category: "artifact_subject"` records purely from `artifact_versions`
// joined with `source_artifacts` (see its doc comment in
// `canonical-query-data-port.ts` -- `record_occurrences.category` has a real
// `CHECK` constraint that makes a persisted `'artifact'` category impossible),
// so these tests never seed `record_occurrences` at all: the in-memory corpus
// is genuinely empty, so any non-empty `matches`/`subjects` stream is direct
// proof pushdown -- not a corpus scan that got lucky -- produced it.
async function insertLexicalDocument(opened: Awaited<ReturnType<Awaited<ReturnType<typeof createDurableStorage>>["openWorkspace"]>>, artifactId: string, artifactVersionId: string, text: string, validFromGeneration: number, validToGeneration?: number): Promise<void> {
  await opened.database.run(
    "INSERT INTO lexical_documents (artifact_id, workspace_id, artifact_version_id, content_hash, byte_length, storage_reference, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, 'sha256:lexical-doc', ?, 'cas:sha256:lexical-doc', ?, ?)",
    [artifactId, workspace.workspace_id, artifactVersionId, new TextEncoder().encode(text).byteLength, validFromGeneration, validToGeneration ?? null],
  );
  await opened.database.run("INSERT INTO lexical_fts (workspace_id, artifact_id, artifact_version_id, content) VALUES (?, ?, ?, ?)", [workspace.workspace_id, artifactId, artifactVersionId, text.normalize("NFKC").toLocaleLowerCase("en-US")]);
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
    "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, 'physical_file')",
    [artifactId, workspace.workspace_id, normalizedPath, normalizedPath, normalizedPath],
  );
}

const NEEDLE_FILE_TEXT = "const value = 1;\nconst needleHere = value + 1;\nconst NeedleHere = value + 2;\n";

function searchTextOperation(args: Readonly<Record<string, unknown>>): { readonly operation_id: string; readonly result_streams: readonly string[]; readonly arguments: unknown; readonly scope: QueryScope } {
  return { operation_id: "core:search_text", result_streams: ["matches", "subjects"], arguments: { pattern: "needleHere", case_sensitive: false, ...args }, scope };
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

  it("search_literal scans the exact current source generation until lexical_index_state reaches it", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent());
      await expect(port.search_literal(scope, "needleHere", {})).resolves.toHaveLength(1);

      // Marking a DIFFERENT (older) generation complete must not count either.
      await markLexicalComplete(opened, 0);
      await expect(port.search_literal(scope, "needleHere", {})).resolves.toHaveLength(1);
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
      expect(resolved[0]?.category).toBe("artifact_subject");
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

  it("keeps lexical pushdown for the normalized public path filter with explicit generated and external exclusions", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertArtifactVersion(opened, "artv-generated", "sha256:generated-search", "utf-8", "art-generated", "src/generated.ts", "generated_file");
      await insertArtifactVersion(opened, "artv-external", "sha256:external-search", "utf-8", "art-external", "src/external.ts", "external_file");
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await insertLexicalDocument(opened, "art-generated", "artv-generated", NEEDLE_FILE_TEXT, 1);
      await insertLexicalDocument(opened, "art-external", "artv-external", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, {
        async read(hash: string) {
          return new TextEncoder().encode(["sha256:needle-file", "sha256:generated-search", "sha256:external-search"].includes(hash) ? NEEDLE_FILE_TEXT : "");
        },
      }));

      const evaluation = await dataPort.execute(searchTextOperation({
        syntax: "literal",
        filter: { paths: ["src/**"], include_generated: false, include_external: false },
      }));
      const matches = evaluation.streams["matches"] as ReadonlyArray<{ readonly value: { readonly source_span?: { readonly start_line?: string } } }>;
      expect(matches).toHaveLength(2);
      expect(matches.every((entry) => entry.value.source_span?.start_line !== undefined)).toBe(true);

      const included = await dataPort.execute(searchTextOperation({
        syntax: "literal",
        filter: { paths: ["src/**"], include_generated: true, include_external: true },
      }));
      expect(included.streams["matches"]).toHaveLength(6);
    });
  });

  it("honors an exact path filter and identifier boundaries together instead of widening the lexical search", async () => {
    await withWorkspace(async (opened) => {
      await seedBaseline(opened);
      const targetText = "const TranspileOptions = 1;\nconst TranspileOptionsExtra = 2;\n";
      const outsideText = "const TranspileOptions = 3;\n";
      await insertArtifactVersion(opened, "artv-target", "sha256:target-search", "utf-8", "art-target", "src/services/transpile.ts", "source_file", "typescript");
      await insertArtifactVersion(opened, "artv-outside", "sha256:outside-search", "utf-8", "art-outside", "src/other.ts", "source_file", "typescript");
      await insertLexicalDocument(opened, "art-target", "artv-target", targetText, 1);
      await insertLexicalDocument(opened, "art-outside", "artv-outside", outsideText, 1);
      await markLexicalComplete(opened, 1);
      const content = {
        async read(hash: string) {
          return new TextEncoder().encode(hash === "sha256:target-search" ? targetText : hash === "sha256:outside-search" ? outsideText : "");
        },
      };
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, content));

      const evaluation = await dataPort.execute({
        operation_id: "core:search_text",
        result_streams: ["matches", "subjects"],
        arguments: {
          pattern: "TranspileOptions",
          syntax: "literal",
          case_sensitive: true,
          word_mode: "identifier",
          filter: { paths: ["src/services/transpile.ts"] },
          result_projection: "artifact",
        },
        scope,
      });
      const matches = evaluation.streams["matches"] as ReadonlyArray<{ readonly value: { readonly path?: string } }>;
      const subjects = evaluation.streams["subjects"] as ReadonlyArray<{ readonly value: { readonly path?: string; readonly match_count?: number } }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]?.value.path).toBe("src/services/transpile.ts");
      expect(subjects).toHaveLength(1);
      expect(subjects[0]?.value).toMatchObject({ path: "src/services/transpile.ts", match_count: 1 });
    });
  });

  it("uses an exact source-catalog scan instead of the structural corpus while lexical maintenance is incomplete", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      // Deliberately never mark lexical maintenance complete.
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));
      const evaluation = await dataPort.execute(searchTextOperation({ syntax: "literal" }));
      const matches = evaluation.streams["matches"] as ReadonlyArray<{ readonly value: { readonly source_span?: unknown } }>;
      expect(matches).toHaveLength(2);
      expect(evaluation.streams["subjects"]).toHaveLength(1);
      expect(matches[0]?.value.source_span).toBeDefined();
    });
  });

  it("falls back to the corpus scan for syntax: safe_regex or a non-path filter, even once lexical maintenance is complete", async () => {
    await withWorkspace(async (opened) => {
      await seedSearchTextWorkspace(opened);
      await insertLexicalDocument(opened, "art-1", "artv-search", NEEDLE_FILE_TEXT, 1);
      await markLexicalComplete(opened, 1);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, needleContent()));

      for (const args of [{ syntax: "safe_regex" }, { filter: { languages: ["typescript"] } }]) {
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
    "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'metadata-digest', 'observation-1', ?, ?)",
    [options.versionId, workspace.workspace_id, options.artifactId, blobId, `sha256:${options.versionId}`, options.byteLength, options.encoding ?? "utf-8", options.validFromGeneration, options.validToGeneration ?? null],
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

  it("Frente S-D (2026-09-07): hydrates candidate snippets with bounded CONCURRENCY, preserving rank order regardless of which snippet's underlying artifact_text call settles first", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      const inner = new SqliteCanonicalQuerySnapshotPort(opened.database, cas);
      const callOrder: string[] = [];
      // Deliberately inverts timing: the FIRST-ranked candidate's own
      // `artifact_text` call is the SLOWEST to settle, and the LAST-ranked
      // candidate's is instant -- if `hydrateSemanticCandidates` still
      // hydrated sequentially (or somehow reordered by completion time),
      // this would either serialize behind the slow call or surface out of
      // rank order. A `Proxy` forwards every OTHER method to `inner`
      // unmodified (bound, since class methods are prototype properties a
      // plain `{...inner}` spread would silently drop).
      const delayed = new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "artifact_text") {
            return async (queryScope: QueryScope, versionId: string) => {
              callOrder.push(versionId);
              const delayMs = versionId === "artv-alpha" ? 30 : versionId === "artv-beta" ? 15 : 0;
              await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
              return target.artifact_text!(queryScope, versionId);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as CanonicalQuerySnapshotPort;
      const dataPort = new CanonicalRecordQueryDataPort(delayed, { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const candidates = candidateValues(evaluation);
      expect(candidates).toHaveLength(3);
      // Rank order is UNCHANGED from the plain (non-delayed) ranking test
      // above, even though `artv-alpha`'s own snippet was the LAST to
      // actually finish resolving.
      expect(candidates[0]!.value.body.artifact_id).toBe("art-alpha");
      expect(candidates[0]!.stable_sort_key.startsWith(sortKeyPrefix(1))).toBe(true);
      expect(candidates[1]!.stable_sort_key.startsWith(sortKeyPrefix(2))).toBe(true);
      expect(candidates[2]!.stable_sort_key.startsWith(sortKeyPrefix(3))).toBe(true);
      // Every candidate's snippet was still fetched at all (real concurrency,
      // not accidentally skipped).
      expect(callOrder.sort()).toEqual(["artv-alpha", "artv-beta", "artv-gamma"]);
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
        noiseValues.push("(?, ?, ?, ?, ?, ?)");
        noiseParams.push(artifactId, workspace.workspace_id, path, path, path, "physical_file");
        blobValues.push("(?, ?, ?, ?)");
        blobParams.push(`blob-${versionId}`, `sha256:${versionId}`, 0, "inline");
        versionValues.push("(?, ?, ?, ?, ?, ?, ?, NULL, 'metadata-digest', 'observation-1', ?, NULL)");
        versionParams.push(versionId, workspace.workspace_id, artifactId, `blob-${versionId}`, `sha256:${versionId}`, 0, "utf-8", 1);
      }
      await opened.database.run(`INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES ${noiseValues.join(",")}`, noiseParams);
      await opened.database.run(`INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES ${blobValues.join(",")}`, blobParams);
      await opened.database.run(`INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES ${versionValues.join(",")}`, versionParams);

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

// Frente S-B (2026-09-06, decision 17 segmentation): an entity document can
// now legitimately have SEVERAL open `vector_projection_rows` sharing one
// `document_ref` (one per segment) -- these tests exercise
// `trySemanticSearch`'s max-similarity aggregation over those rows
// (`entitySegmentRanks` + the per-document reduction) and the
// `semantic_evidence.matched_segment` evidence it attaches to the winning
// candidate.
async function putSemanticEntitySegmentVector(opened: OpenedWorkspace, provider: ResolvedSemanticProvider, options: { readonly recordId: string; readonly ownerArtifactId: string; readonly ownerVersionId: string; readonly text: string; readonly segmentIndex: number; readonly segmentStart: number; readonly segmentEnd: number; readonly validFromGeneration?: number }): Promise<void> {
  const generated = await provider.binding.generateVector({ profile: provider.profile, purpose: "document", text: options.text, segment_index: options.segmentIndex });
  await opened.projections.putVectors([{
    projection_record_id: `semantic-entity-document:${options.recordId}:${options.segmentIndex}`,
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
    segment_index: options.segmentIndex,
    segment_start: options.segmentStart,
    segment_end: options.segmentEnd,
  }]);
}

interface SemanticEvidenceCandidateValue extends CandidateStreamValue {
  readonly semantic_evidence?: { readonly matched_segment?: { readonly index: number; readonly start_char: number; readonly end_char: number } };
}
function candidateEvidenceValues(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): readonly SemanticEvidenceCandidateValue[] {
  return (evaluation.streams["candidates"] as readonly { readonly value: SemanticEvidenceCandidateValue }[]).map((item) => item.value);
}

describe("CanonicalRecordQueryDataPort core:search_semantic entity lane: multi-segment max-similarity aggregation (Frente S-B)", () => {
  it("aggregates a multi-segment entity to ONE candidate, keyed by the HIGHEST-similarity segment, and attaches its matched_segment evidence", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      await insertRecordOccurrence(opened, "rec-multi-segment", "artv-alpha", 1, { name: "multiSegmentEntity", kind: "function", language: "typescript", path: "src/alpha.ts", start: 0, end: 80 });
      // Segment 0: vocabulary UNRELATED to the query. Segment 1: an EXACT
      // match to the query text -- the closest possible vector under the
      // local hash embedder. Only ONE candidate must surface for this
      // record, and it must be attributed to segment 1's own span.
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-multi-segment", ownerArtifactId: "art-alpha", ownerVersionId: "artv-alpha", text: GAMMA_TEXT, segmentIndex: 0, segmentStart: 0, segmentEnd: 40 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-multi-segment", ownerArtifactId: "art-alpha", ownerVersionId: "artv-alpha", text: ALPHA_TEXT, segmentIndex: 1, segmentStart: 40, segmentEnd: 80 });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const values = candidateEvidenceValues(evaluation);
      const matches = values.filter((value) => value.record_id === "rec-multi-segment");
      // Exactly ONE candidate for this record, never one per segment row.
      expect(matches).toHaveLength(1);
      expect(matches[0]?.semantic_evidence?.matched_segment).toEqual({ index: 1, start_char: 40, end_char: 80 });
    });
  });

  it("ranks the multi-segment entity ahead of a decoy using its BEST segment's similarity, even though its OTHER segment is a poor match", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-host", versionId: "artv-host", path: "src/host.ts", byteLength: 100, validFromGeneration: 1 });
      await insertRecordOccurrence(opened, "rec-multi-segment", "artv-host", 1, { name: "multiSegmentEntity", kind: "function", language: "typescript", path: "src/host.ts", start: 0, end: 80 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-multi-segment", ownerArtifactId: "art-host", ownerVersionId: "artv-host", text: GAMMA_TEXT, segmentIndex: 0, segmentStart: 0, segmentEnd: 40 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-multi-segment", ownerArtifactId: "art-host", ownerVersionId: "artv-host", text: ALPHA_TEXT, segmentIndex: 1, segmentStart: 40, segmentEnd: 80 });
      // A single-segment decoy entity whose only vector is a middling match.
      await insertRecordOccurrence(opened, "rec-decoy", "artv-host", 1, { name: "decoyEntity", kind: "function", language: "typescript", path: "src/host.ts", start: 0, end: 40 });
      await putSemanticEntityVector(opened, provider, { recordId: "rec-decoy", ownerArtifactId: "art-host", ownerVersionId: "artv-host", text: BETA_TEXT });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic", { filter: { subject_types: ["entity"] } }));
      const values = candidateStreamValues(evaluation);
      const rankOf = (recordId: string) => values.findIndex((value) => value.record_id === recordId);
      expect(rankOf("rec-multi-segment")).toBeGreaterThanOrEqual(0);
      expect(rankOf("rec-decoy")).toBeGreaterThanOrEqual(0);
      expect(rankOf("rec-multi-segment")).toBeLessThan(rankOf("rec-decoy"));
    });
  });

  it("omits semantic_evidence entirely for a pre-segmentation entity vector with no recorded segment span", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedEntityLaneWorkspace(opened, provider);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const values = candidateEvidenceValues(evaluation);
      const entityCandidate = values.find((value) => value.record_id === "rec-entity-alpha");
      expect(entityCandidate).toBeDefined();
      expect(entityCandidate?.semantic_evidence).toBeUndefined();
    });
  });

  it("dedupes correctly across MULTIPLE multi-segment entities: N segment rows across 2 records still yield exactly 2 entity candidates", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedThreeDocumentWorkspace(opened, provider);
      await insertRecordOccurrence(opened, "rec-one", "artv-alpha", 1, { name: "one", kind: "function", language: "typescript", path: "src/alpha.ts", start: 0, end: 80 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-one", ownerArtifactId: "art-alpha", ownerVersionId: "artv-alpha", text: ALPHA_TEXT, segmentIndex: 0, segmentStart: 0, segmentEnd: 40 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-one", ownerArtifactId: "art-alpha", ownerVersionId: "artv-alpha", text: GAMMA_TEXT, segmentIndex: 1, segmentStart: 40, segmentEnd: 80 });
      await insertRecordOccurrence(opened, "rec-two", "artv-beta", 1, { name: "two", kind: "function", language: "typescript", path: "src/beta.ts", start: 0, end: 80 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-two", ownerArtifactId: "art-beta", ownerVersionId: "artv-beta", text: BETA_TEXT, segmentIndex: 0, segmentStart: 0, segmentEnd: 40 });
      await putSemanticEntitySegmentVector(opened, provider, { recordId: "rec-two", ownerArtifactId: "art-beta", ownerVersionId: "artv-beta", text: GAMMA_TEXT, segmentIndex: 1, segmentStart: 40, segmentEnd: 80 });
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic", { filter: { subject_types: ["entity"] } }));
      const values = candidateStreamValues(evaluation);
      expect(values).toHaveLength(2);
      expect(new Set(values.map((value) => value.record_id))).toEqual(new Set(["rec-one", "rec-two"]));
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

// Plan 2026-09-06 (Frente S-A): `semantic_document_status` real counts on the
// coverage view, plus `core:semantic_affected_page`'s bidirectional keyset
// pagination over the affected (status <> 'covered') set.
describe("CanonicalRecordQueryDataPort semantic_document_status real counts + core:semantic_affected_page", () => {
  async function insertStatusRow(opened: OpenedWorkspace, provider: ResolvedSemanticProvider, row: { readonly grain: "artifact" | "entity"; readonly documentId: string; readonly artifactId: string; readonly artifactVersionId: string; readonly displayPath: string; readonly status: string; readonly reasonCodes?: readonly string[] }): Promise<void> {
    await opened.database.run(
      `INSERT INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspace.workspace_id, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest, row.grain, row.documentId, row.artifactId, row.artifactVersionId, row.displayPath, row.status, JSON.stringify(row.reasonCodes ?? []), row.status === "covered" ? 1 : 0, 1, now],
    );
  }

  function affectedPageOperation(args: Readonly<Record<string, unknown>>): { readonly operation_id: string; readonly result_streams: readonly string[]; readonly arguments: unknown; readonly scope: QueryScope } {
    return { operation_id: "core:semantic_affected_page", result_streams: ["semantic_affected_artifacts"], arguments: args, scope };
  }

  interface AffectedPageValue {
    readonly affected_artifact_set_id: string;
    readonly total: number;
    readonly artifacts: readonly { readonly artifact_id: string; readonly display_path: string; readonly coverage_status: string; readonly reason_codes: readonly string[] }[];
    readonly next_cursor?: string;
    readonly previous_cursor?: string;
    readonly has_next: boolean;
    readonly has_previous: boolean;
  }

  /** `core:semantic_affected_page` emits exactly ONE stream item -- the whole `SemanticAffectedArtifactPage` (see `trySemanticAffectedPage`'s own doc comment for why: the cursor round-trips through this operation's OWN `cursor` argument, never the generic per-stream continuation, so it must be readable from the result). */
  function affectedPage(evaluation: { readonly streams: Readonly<Record<string, readonly unknown[]>> }): AffectedPageValue {
    const items = evaluation.streams["semantic_affected_artifacts"] as readonly { readonly value: AffectedPageValue }[];
    expect(items).toHaveLength(1);
    return items[0]!.value;
  }

  it("reports real unsupported/failed artifact counts and exact entity counts from semantic_document_status, overriding the inferred pre-status-table arithmetic", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-a", versionId: "artv-a", path: "src/a.ts", byteLength: 10, validFromGeneration: 1 });
      await putSemanticVector(opened, provider, { artifactId: "art-a", versionId: "artv-a", text: "document text for a" });
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-a", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "covered" });
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-fail", artifactId: "art-fail", artifactVersionId: "artv-fail", displayPath: "src/fail.ts", status: "failed", reasonCodes: ["provider_error:vector_write_failed"] });
      await insertStatusRow(opened, provider, { grain: "entity", documentId: "entity-1", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "covered" });
      await insertStatusRow(opened, provider, { grain: "entity", documentId: "entity-2", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "unsupported", reasonCodes: ["unsupported_kind"] });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const evaluation = await dataPort.execute(semanticOperation("core:search_semantic"));
      const coverage = coverageView(evaluation);
      expect(coverage).toMatchObject({ failed_artifact_count: 1, entity_count: 2, covered_entity_count: 1 });
      expect(coverage["affected_artifact_set_id"]).toEqual(expect.stringMatching(/^sha256:/));
      expect(coverage["affected_artifact_page"]).toMatchObject({ total: 2 });
    });
  });

  it("pages forward and backward with keyset cursors over the affected set, never mixing pages", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      // Five affected artifact-grain documents, seeded out of display_path
      // order so a bug sorting by insertion order rather than
      // (display_path, artifact_id, document_id) would be caught.
      const paths = ["src/c.ts", "src/a.ts", "src/e.ts", "src/b.ts", "src/d.ts"];
      for (const path of paths) {
        const id = path.replace("src/", "").replace(".ts", "");
        await insertStatusRow(opened, provider, { grain: "artifact", documentId: `artv-${id}`, artifactId: `art-${id}`, artifactVersionId: `artv-${id}`, displayPath: path, status: "pending", reasonCodes: ["pending_embed"] });
      }
      // A current marker (no vectors need to exist) is enough to make the
      // index "available" -- these tests exercise the affected-page path,
      // not materialization progress itself.
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      // A caller cannot know the set id in advance -- the first request
      // comes from a coverage view, exactly like a real agent would (via
      // search_semantic's own embedded first page), never hand-computed.
      const coverage = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      const setId = coverage["affected_artifact_set_id"] as string;

      const page1 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 2 })));
      expect(page1.total).toBe(5);
      expect(page1.artifacts.map((item) => item.display_path)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(page1.has_next).toBe(true);
      expect(page1.has_previous).toBe(false);
      expect(page1.next_cursor).toBeDefined();
      expect(page1.previous_cursor).toBeUndefined();

      const page2 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: page1.next_cursor, limit: 2 })));
      expect(page2.artifacts.map((item) => item.display_path)).toEqual(["src/c.ts", "src/d.ts"]);
      expect(page2.has_next).toBe(true);
      expect(page2.has_previous).toBe(true);
      expect(page2.previous_cursor).toBeDefined();

      const page3 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: page2.next_cursor, limit: 2 })));
      expect(page3.artifacts.map((item) => item.display_path)).toEqual(["src/e.ts"]);
      expect(page3.has_next).toBe(false);

      // Walk backward from page 2's own previous_cursor: must land back on
      // exactly page 1's documents.
      const backToPage1 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: page2.previous_cursor, limit: 2 })));
      expect(backToPage1.artifacts.map((item) => item.display_path)).toEqual(page1.artifacts.map((item) => item.display_path));
      expect(backToPage1.has_previous).toBe(false);

      // Re-fetching the first page from a fresh continuation-less call must
      // agree with the embedded first page byte-for-byte (stability).
      const refetchedFirst = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 2 })));
      expect(refetchedFirst).toEqual(page1);
    });
  });

  it("rejects a stale affected_artifact_set_id/cursor with core:affected_set_stale rather than ever mixing sets", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-a", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "pending" });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });
      const coverage1 = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      const staleSetId = coverage1["affected_artifact_set_id"] as string;

      // The set changes: a new affected document appears.
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-b", artifactId: "art-b", artifactVersionId: "artv-b", displayPath: "src/b.ts", status: "pending" });

      await expect(dataPort.execute(affectedPageOperation({ affected_artifact_set_id: staleSetId, limit: 10 }))).rejects.toMatchObject({
        code: "core:affected_set_stale",
        details: { current_set_id: expect.stringMatching(/^sha256:/) },
      });

      // The CURRENT set id (a fresh, correct argument) still succeeds --
      // proves the rejection above was specifically about staleness, not a
      // broken happy path.
      const currentCoverage = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      const currentSetId = currentCoverage["affected_artifact_set_id"] as string;
      expect(currentSetId).not.toBe(staleSetId);
      const currentPage = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: currentSetId, limit: 10 })));
      expect(currentPage.total).toBe(2);
    });
  });

  it("pages forward and backward with limit=3 over 10 rows, including duplicate display_path with different artifact_id and document_id with unusual characters, without ever misordering or dropping a row", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      // Ten rows: two distinct artifact_ids share the SAME display_path
      // ("src/dup.ts") to exercise the (display_path, artifact_id,
      // document_id) tie-break beyond just display_path; one document_id
      // carries quote/backslash/unicode/whitespace characters to prove the
      // cursor's JSON encoding round-trips it exactly.
      const rows: { readonly documentId: string; readonly artifactId: string; readonly displayPath: string }[] = [
        { documentId: "artv-0", artifactId: "art-0", displayPath: "src/00.ts" },
        { documentId: "artv-1", artifactId: "art-1", displayPath: "src/01.ts" },
        { documentId: "artv-dup-a", artifactId: "art-dup-a", displayPath: "src/dup.ts" },
        { documentId: "artv-dup-b", artifactId: "art-dup-b", displayPath: "src/dup.ts" },
        { documentId: "artv\"weird'\\<náme>\u00e9 \t.ts", artifactId: "art-weird", displayPath: "src/dup.ts" },
        { documentId: "artv-3", artifactId: "art-3", displayPath: "src/03.ts" },
        { documentId: "artv-4", artifactId: "art-4", displayPath: "src/04.ts" },
        { documentId: "artv-5", artifactId: "art-5", displayPath: "src/05.ts" },
        { documentId: "artv-6", artifactId: "art-6", displayPath: "src/06.ts" },
        { documentId: "artv-7", artifactId: "art-7", displayPath: "src/07.ts" },
      ];
      for (const row of rows) await insertStatusRow(opened, provider, { grain: "artifact", documentId: row.documentId, artifactId: row.artifactId, artifactVersionId: row.documentId, displayPath: row.displayPath, status: "pending", reasonCodes: ["pending_embed"] });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const expectedOrder = [...rows]
        .sort((left, right) => (left.displayPath === right.displayPath ? (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0) : left.displayPath < right.displayPath ? -1 : 1))
        .map((row) => row.displayPath);

      const setId = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")))["affected_artifact_set_id"] as string;

      // Walk forward, 3 at a time, collecting every page's rows.
      const forwardPages: AffectedPageValue[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 3, ...(cursor === undefined ? {} : { cursor }) })));
        forwardPages.push(page);
        if (!page.has_next) break;
        cursor = page.next_cursor;
      }
      expect(forwardPages).toHaveLength(4); // 10 rows / 3 per page, last page has 1
      expect(forwardPages[0]!.has_previous).toBe(false);
      expect(forwardPages[0]!.previous_cursor).toBeUndefined();
      expect(forwardPages.map((page) => page.artifacts.length)).toEqual([3, 3, 3, 1]);
      expect(forwardPages.flatMap((page) => page.artifacts.map((item) => item.display_path))).toEqual(expectedOrder);
      // Every row's total agrees, and the set id is identical across every page.
      for (const page of forwardPages) { expect(page.total).toBe(10); expect(page.affected_artifact_set_id).toBe(setId); }

      // Walk backward from the LAST page's own previous_cursor all the way
      // to the first page; the concatenation must reproduce the exact same
      // sequence of display_paths as the forward walk, front to back.
      const backwardPages: AffectedPageValue[] = [];
      let backCursor = forwardPages[forwardPages.length - 1]!.previous_cursor;
      for (let guard = 0; guard < 10 && backCursor !== undefined; guard += 1) {
        const page = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: backCursor, limit: 3 })));
        backwardPages.unshift(page);
        backCursor = page.previous_cursor;
      }
      // The full round trip: the first (forward) page plus every backward
      // page walked must reconstruct the identical row sequence.
      const reconstructed = [...backwardPages, forwardPages[forwardPages.length - 1]!].flatMap((page) => page.artifacts.map((item) => item.display_path));
      expect(reconstructed).toEqual(expectedOrder);
      expect(backwardPages[0]!.has_previous).toBe(false);

      // The document with unusual characters in its id survived the full
      // round trip (both directions) with its exact id intact.
      const weirdRow = rows.find((row) => row.artifactId === "art-weird")!;
      const allForwardArtifactIds = forwardPages.flatMap((page) => page.artifacts.map((item) => item.artifact_id));
      expect(allForwardArtifactIds).toContain(weirdRow.artifactId);
    });
  });

  it("rejects a structurally malformed cursor with a typed core:cursor_invalid error, never an unhandled exception", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-a", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "pending" });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });
      const setId = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")))["affected_artifact_set_id"] as string;

      // Not valid hex / not valid JSON once decoded.
      await expect(dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: "%%%not-hex%%%", limit: 10 }))).rejects.toMatchObject({ code: "core:cursor_invalid", details: { reason_code: "malformed_cursor" } });

      // Valid hex-encoded JSON, but missing the required `k` field entirely.
      const missingK = Buffer.from(JSON.stringify({ set: setId, dir: "next" }), "utf8").toString("hex");
      await expect(dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: missingK, limit: 10 }))).rejects.toMatchObject({ code: "core:cursor_invalid", details: { reason_code: "malformed_cursor" } });

      // `k` present but with the wrong element types (numbers, not strings).
      const wrongTypes = Buffer.from(JSON.stringify({ set: setId, k: [1, 2, 3], dir: "next" }), "utf8").toString("hex");
      await expect(dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: wrongTypes, limit: 10 }))).rejects.toMatchObject({ code: "core:cursor_invalid", details: { reason_code: "malformed_cursor" } });

      // `dir` present but not one of "next"/"prev".
      const wrongDir = Buffer.from(JSON.stringify({ set: setId, k: ["a", "b", "c"], dir: "sideways" }), "utf8").toString("hex");
      await expect(dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, cursor: wrongDir, limit: 10 }))).rejects.toMatchObject({ code: "core:cursor_invalid", details: { reason_code: "malformed_cursor" } });

      // The happy path (no cursor) still works after all the above --
      // proves the malformed-cursor path never left the port in a broken
      // state.
      const page = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 10 })));
      expect(page.total).toBe(1);
    });
  });

  it("clamps an oversized limit to the maximum page size rather than returning every affected row unbounded", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      // 205 rows: one more than the maximum page size (200), enough to prove
      // an oversized `limit` argument is actually clamped rather than merely
      // documented as clamped.
      const total = 205;
      const commands = Array.from({ length: total }, (_, index) => ({
        kind: "run" as const,
        sql: `INSERT INTO semantic_document_status (workspace_id, profile_id, executable_binding_id, document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes, segment_count, generation, updated_at)
              VALUES (?, ?, ?, 'artifact', ?, ?, ?, ?, 'pending', '["pending_embed"]', 0, 1, ?)`,
        params: [workspace.workspace_id, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest, `artv-${String(index).padStart(4, "0")}`, `art-${String(index).padStart(4, "0")}`, `artv-${String(index).padStart(4, "0")}`, `src/${String(index).padStart(4, "0")}.ts`, now],
      }));
      await opened.database.transaction(commands);
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });
      const setId = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")))["affected_artifact_set_id"] as string;

      const page = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 100_000 })));
      expect(page.total).toBe(total);
      expect(page.artifacts.length).toBe(200);
      expect(page.has_next).toBe(true);
    });
  });

  it("is stable: two consecutive requests against unchanged data produce the identical affected_artifact_set_id and page contents", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-a", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "pending" });
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-b", artifactId: "art-b", artifactVersionId: "artv-b", displayPath: "src/b.ts", status: "excluded", reasonCodes: ["oversized"] });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });

      const first = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      const second = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      expect(first["affected_artifact_set_id"]).toBe(second["affected_artifact_set_id"]);
      expect(first["affected_artifact_page"]).toEqual(second["affected_artifact_page"]);

      const setId = first["affected_artifact_set_id"] as string;
      const page1 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 10 })));
      const page2 = affectedPage(await dataPort.execute(affectedPageOperation({ affected_artifact_set_id: setId, limit: 10 })));
      expect(page1).toEqual(page2);
      // Frente S-F (2026-09-08): ordered `(status, display_path, ...)` now
      // (status LEADING, matching the covering index's own column order --
      // see `semantic_affected_documents`'s own doc comment) -- "excluded"
      // sorts before "pending" alphabetically, regardless of either row's
      // own display_path (`src/a.ts` for the pending row, `src/b.ts` for the
      // excluded one; previously path-first order would have put the
      // pending row first).
      expect(page1.artifacts.map((item) => item.coverage_status)).toEqual(["excluded", "pending"]);
    });
  });

  it("Frente S-F: semantic_affected_documents' own query plan is one already-sorted covering-index SEARCH -- no SCAN, no TEMP B-TREE", async () => {
    await withSemanticWorkspace(async (opened) => {
      const rows = await opened.database.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT document_grain, document_id, artifact_id, artifact_version_id, display_path, status, reason_codes
           FROM semantic_document_status
          WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ? AND status IN (?, ?, ?, ?)
          ORDER BY status, display_path, artifact_id, document_id`,
        [workspace.workspace_id, "profile-x", "binding-x", "pending", "excluded", "unsupported", "failed"],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.detail).not.toMatch(/\bSCAN\b/u);
        expect(row.detail).not.toMatch(/TEMP B-TREE/iu);
      }
      // Positive assertion, not just an absence check: the plan is a SEARCH
      // using the covering index this migration adds.
      expect(rows.some((row) => /USING (COVERING )?INDEX semantic_document_status_affected_v2/u.test(row.detail))).toBe(true);
    });
  });

  it("Frente S-F: semantic_coverage_summary's own point-lookup query plan is one indexed SEARCH -- no SCAN, no sort", async () => {
    await withSemanticWorkspace(async (opened) => {
      const rows = await opened.database.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT generation, unsupported_artifact_count, failed_artifact_count, entity_count, covered_entity_count, affected_artifact_count, affected_artifact_set_id, affected_first_page
           FROM semantic_coverage_summary
          WHERE workspace_id = ? AND profile_id = ? AND executable_binding_id = ?
          ORDER BY generation DESC LIMIT 1`,
        [workspace.workspace_id, "profile-x", "binding-x"],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.detail).not.toMatch(/\bSCAN\b/u);
        expect(row.detail).not.toMatch(/TEMP B-TREE/iu);
      }
    });
  });

  it("Frente S-G (2026-09-08): reconcileSemanticProjection's own artifact-grain 'missing rows' NOT EXISTS subquery is one indexed SEARCH per outer row, not a rescan of the whole vector space", async () => {
    // Root cause confirmed live at n8n scale
    // (docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md, Bug
    // 5): `vector_projection_visible_idx` leads with `(workspace_id,
    // profile_id, executable_binding_id, ...)`, NOT the owner columns this
    // correlated subquery actually filters by -- so SQLite could only use
    // it to narrow to the workspace's ENTIRE open vector-projection set
    // (72,922 rows at n8n scale) and then scan that whole set by hand for
    // every one of the ~20k outer `artifact_versions` rows (confirmed:
    // ~1.47 BILLION comparisons, the query did not complete in 120 seconds
    // against the real corpus). `vector_projection_by_owner_idx` fixes
    // this by leading with the exact correlated columns instead.
    await withSemanticWorkspace(async (opened) => {
      const rows = await opened.database.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT artifact_versions.artifact_id AS artifact_id, artifact_versions.artifact_version_id AS artifact_version_id
           FROM artifact_versions
           JOIN source_artifacts ON source_artifacts.workspace_id = artifact_versions.workspace_id AND source_artifacts.artifact_id = artifact_versions.artifact_id
          WHERE artifact_versions.workspace_id = ? AND artifact_versions.encoding <> 'binary'
            AND artifact_versions.valid_from_generation <= ?
            AND (artifact_versions.valid_to_generation IS NULL OR artifact_versions.valid_to_generation > ?)
            AND NOT EXISTS (
              SELECT 1 FROM vector_projection_rows
               WHERE vector_projection_rows.workspace_id = artifact_versions.workspace_id
                 AND vector_projection_rows.owner_artifact_id = artifact_versions.artifact_id
                 AND vector_projection_rows.owner_artifact_version_id = artifact_versions.artifact_version_id
                 AND vector_projection_rows.valid_to_generation IS NULL
                 AND vector_projection_rows.document_grain IS NULL
                 AND vector_projection_rows.profile_id = ? AND vector_projection_rows.executable_binding_id = ?
            )`,
        [workspace.workspace_id, 1, 1, "profile-x", "binding-x"],
      );
      expect(rows.length).toBeGreaterThan(0);
      // Positive assertion: the correlated subquery's own row in the plan
      // names the new index, as a SEARCH (never a SCAN of the whole table).
      const correlatedRow = rows.find((row) => /vector_projection_rows/u.test(row.detail));
      expect(correlatedRow).toBeDefined();
      expect(correlatedRow!.detail).toMatch(/SEARCH .*USING (COVERING )?INDEX vector_projection_by_owner_idx/u);
      for (const row of rows) expect(row.detail).not.toMatch(/\bSCAN vector_projection_rows\b/u);
    });
  });

  it("Frente S-F: buildSemanticCoverageView reads the materialized semantic_coverage_summary row instead of recomputing live, when one exists", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      // A real live computation over this workspace's actual
      // semantic_document_status rows would never produce these exact
      // numbers (there are zero rows at all yet) -- planting a
      // semantic_coverage_summary row with distinctive synthetic values and
      // asserting the coverage view echoes them back verbatim proves the
      // fast path actually READS this row rather than recomputing live.
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      await opened.database.run(
        `INSERT INTO semantic_coverage_summary (workspace_id, profile_id, executable_binding_id, generation, unsupported_artifact_count, failed_artifact_count, entity_count, covered_entity_count, affected_artifact_count, affected_artifact_set_id, affected_first_page, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspace.workspace_id, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest, 1,
          777, 888, 999, 111,
          1, "sha256:synthetic-set-id", JSON.stringify([{ document_grain: "artifact", document_id: "artv-synthetic", artifact_id: "art-synthetic", artifact_version_id: "artv-synthetic", display_path: "src/synthetic.ts", status: "pending", reason_codes: ["pending_embed"] }]),
          now,
        ],
      );
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });
      const view = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      expect(view["unsupported_artifact_count"]).toBe(777);
      expect(view["failed_artifact_count"]).toBe(888);
      expect(view["entity_count"]).toBe(999);
      expect(view["covered_entity_count"]).toBe(111);
      expect(view["affected_artifact_count"]).toBe(1);
      expect(view["affected_artifact_set_id"]).toBe("sha256:synthetic-set-id");
      const page = view["affected_artifact_page"] as AffectedPageValue;
      expect(page.artifacts).toEqual([{ artifact_id: "art-synthetic", artifact_version_id: "artv-synthetic", display_path: "src/synthetic.ts", coverage_status: "pending", reason_codes: ["pending_embed"], diagnostic_record_ids: [] }]);
      expect(page.has_next).toBe(false);
      expect(page.has_previous).toBe(false);
    });
  });

  it("Frente S-F: falls back to the live semantic_document_status_counts/semantic_affected_documents pair when no semantic_coverage_summary row exists yet", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertStatusRow(opened, provider, { grain: "artifact", documentId: "artv-a", artifactId: "art-a", artifactVersionId: "artv-a", displayPath: "src/a.ts", status: "pending" });
      await markSemanticIndexState(opened, 1, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      // No semantic_coverage_summary row inserted -- this workspace predates
      // materialization (or the reconciler's own write failed, best-effort).
      const dataPort = new CanonicalRecordQueryDataPort(new SqliteCanonicalQuerySnapshotPort(opened.database, cas), { semantic: provider });
      const view = coverageView(await dataPort.execute(semanticOperation("core:search_semantic")));
      expect(view["affected_artifact_count"]).toBe(1);
      const page = view["affected_artifact_page"] as AffectedPageValue;
      expect(page.artifacts.map((item) => item.artifact_id)).toEqual(["art-a"]);
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

  it("Frente S-F: caches packed vector_shards bytes by content_hash -- a second semantic_vectors call for the SAME shards never re-reads CAS", async () => {
    await withSemanticWorkspace(async (opened, cas) => {
      const provider = createLocalHashProvider();
      await seedBaseline(opened);
      await insertSemanticArtifactVersion(opened, { artifactId: "art-1", versionId: "artv-1", path: "src/one.ts", byteLength: 64, validFromGeneration: 1 });
      await insertSemanticArtifactVersion(opened, { artifactId: "art-2", versionId: "artv-2", path: "src/two.ts", byteLength: 64, validFromGeneration: 1 });
      await putSemanticVector(opened, provider, { artifactId: "art-1", versionId: "artv-1", text: "function shardCacheOne() {}" });
      await putSemanticVector(opened, provider, { artifactId: "art-2", versionId: "artv-2", text: "function shardCacheTwo() {}" });

      let reads = 0;
      const countingCas = { read: async (contentHash: string) => { reads += 1; return cas.read(contentHash); } };
      const port = new SqliteCanonicalQuerySnapshotPort(opened.database, countingCas);

      const first = await port.semantic_vectors(scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(first).toHaveLength(2);
      const readsAfterFirst = reads;
      expect(readsAfterFirst).toBeGreaterThan(0);
      expect(port.approxWarmBytes()).toBeGreaterThan(0);

      // A second call for the SAME (already-cached) shards must not issue
      // any new CAS reads.
      const second = await port.semantic_vectors(scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(second).toEqual(first);
      expect(reads).toBe(readsAfterFirst);

      // evictWarmRecords() drops the shard cache too -- the next call reads
      // through CAS again, and still produces the identical result.
      port.evictWarmRecords();
      expect(port.approxWarmBytes()).toBe(0);
      const third = await port.semantic_vectors(scope, provider.profile.embedding_profile_id, provider.binding.executable_binding_digest);
      expect(third).toEqual(first);
      expect(reads).toBeGreaterThan(readsAfterFirst);
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
    await db.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1"]);
    await db.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`]);
    await db.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now]);
    await db.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob:${workspaceId}`, `sha256:${workspaceId}`, 0, "inline"]);
    await db.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, 'art-1', ?, ?, 0, 'utf-8', NULL, 'metadata-digest', 'observation-1', 0, NULL)", [`artv:${workspaceId}`, workspaceId, `blob:${workspaceId}`, `sha256:${workspaceId}`]);
    // The SAME `record_id` bytes AND the SAME payload bytes in both
    // workspaces -- exactly the "content-derived id => identical payload
    // bytes" premise `RecordBodyInterner` relies on (decision 11).
    const payload = recordPayload(body);
    await db.run(
      "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES ('rec-shared', ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, 'digest-rec-shared', ?, ?, 'analysis', 'configuration', 'dependencies')",
      [workspaceId, `artv:${workspaceId}`, digestBytes(payload), payload.byteLength],
    );
    await db.transaction(relationalValueCommands(flattenRelationalValue(workspaceId, "rec-shared", 1, body)));
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
      const bodyWithFacets = { name: "shared-record" };
      for (const [opened, workspaceId] of [[openedA, "ws-interner-a"], [openedB, "ws-interner-b"]] as const) {
        const targetDb = opened.database;
        await targetDb.exec("PRAGMA foreign_keys = OFF");
        await targetDb.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?, ?, ?, ?, ?, ?)", [`registry:${workspaceId}`, workspaceId, "1", "core-digest", "lock-1", "registry-digest-1"]);
        await targetDb.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [`snapshot:${workspaceId}`, workspaceId, 1, `manifest:${workspaceId}`, `registry:${workspaceId}`, "lock-1", "configuration-1", "source-digest", "[]", "records-digest", "projections-digest", "capabilities-digest", now, `snapshot-digest:${workspaceId}`]);
        await targetDb.run("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [workspaceId, `snapshot:${workspaceId}`, 1, `registry:${workspaceId}`, "lock-1", "configuration-1", "freshness-1", 1, now]);
        await targetDb.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", [`blob:${workspaceId}`, `sha256:${workspaceId}`, 0, "inline"]);
        await targetDb.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?, ?, 'art-1', ?, ?, 0, 'utf-8', NULL, 'metadata-digest', 'observation-1', 0, NULL)", [`artv:${workspaceId}`, workspaceId, `blob:${workspaceId}`, `sha256:${workspaceId}`]);
        await targetDb.run(
          "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) VALUES ('rec-shared', ?, 'entity', 'function_declaration', 'core:function', 1, 'test', '1', 'art-1', ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, 'digest-rec-shared', ?, ?, 'analysis', 'configuration', 'dependencies')",
          [workspaceId, `artv:${workspaceId}`, digestBytes(encodeCanonical(bodyWithFacets)), encodeCanonical(bodyWithFacets).byteLength],
        );
        await targetDb.transaction([
          ...relationalValueCommands(flattenRelationalValue(workspaceId, "rec-shared", 1, bodyWithFacets)),
          { kind: "run", sql: "INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, ?, ?, ?)", params: [workspaceId, "rec-shared", 1, 0, "facet-one"] },
          { kind: "run", sql: "INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) VALUES (?, ?, ?, ?, ?)", params: [workspaceId, "rec-shared", 1, 1, "facet-two"] },
        ]);
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
