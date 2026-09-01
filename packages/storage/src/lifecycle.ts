import { copyFile, mkdir, open as openFile, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { computeDigest, computeDigestOverArrayPayload, computeDigestOverMapPayloadWithArrayField, decodeCanonical, digestBytes, digestLogicalValue, encodeCanonical } from "@urdira/canonical";
import type { ProjectionSetDigestEntry, RetentionLease, SnapshotExpirationMarker, SnapshotRetentionPin, SourceReference } from "@urdira/contracts";
import { casObjectRelativeParts, writeCasLayoutMarker, type ContentAddressedStore, type BlobStore } from "./cas.js";
import { StorageError } from "./errors.js";
import { noFaults, type FaultInjector } from "./faults.js";
import { openSqliteDatabase, type SqliteDatabase, type SqliteValue } from "./sqlite.js";
import { digestRelationalValue, hydrateRelationalValue, type RelationalValueRow } from "./relational-values.js";
import { WORKSPACE_V3_SCHEMA } from "./workspace-v3-sql.js";
import { WorkspaceProjectionRepository } from "./projections.js";
import { logicalRecordSetDigest } from "./publication-authority.js";

function canonicalSha256(value: unknown): string { return digestBytes(encodeCanonical(value)); }

export interface RetentionLeaseInput {
  readonly retention_lease_id: string;
  readonly snapshot_id: string;
  readonly holder_type: string;
  readonly holder_id: string;
  readonly now: string;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
}

export interface SnapshotPinInput {
  readonly retention_pin_id: string;
  readonly snapshot_id: string;
  readonly pin_kind: string;
  readonly reason_code: string;
  readonly source_reference: SourceReference;
  readonly created_at: string;
  readonly expires_at: string;
}

export type SnapshotExpirationMarkerInput = SnapshotExpirationMarker;

export interface QueryExecutionInput {
  readonly query_execution_id: string;
  readonly workspace_snapshot_ids: ReadonlyArray<string>;
  readonly query_plan_hash?: string;
  readonly projection_digest?: string;
  readonly scope_digest?: string;
  readonly response_budget_ceiling?: string;
  readonly retention_lease_ids?: ReadonlyArray<string>;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface QueryExecutionRecord {
  readonly query_execution_id: string;
  readonly workspace_id: string;
  readonly workspace_snapshot_ids: readonly string[];
  readonly query_plan_hash: string;
  readonly projection_digest: string;
  readonly scope_digest: string;
  readonly response_budget_ceiling: string;
  readonly retention_lease_ids: readonly string[];
  readonly created_at: string;
  readonly expires_at: string;
  readonly execution_status: string;
}

export interface CollectionOptions {
  readonly now: string;
  readonly batch_size: number;
  readonly epoch_id?: string;
}

export interface CollectionResult {
  readonly epoch_id: string;
  readonly state: string;
  readonly deleted_hashes: ReadonlyArray<string>;
  readonly remaining_candidates: number;
}

export interface VerificationFailure {
  readonly component_kind: string;
  readonly component_id: string;
  readonly error_code: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly failures: ReadonlyArray<VerificationFailure>;
}

export type RepairComponentKind = "cas" | "graph" | "lexical" | "dependency" | "metric" | "vector" | "manifest" | "snapshot" | "live_provider" | "canonical" | "source_catalog" | "registry" | "control_plane" | "current_tuple" | "lease" | "pin";

export interface RepairStorageContext {
  readonly workspace_id: string;
  readonly component_id: string;
  readonly database: SqliteDatabase;
  readonly cas: ContentAddressedStore;
  readonly blobs: BlobStore;
}

export interface SnapshotRebuildPort {
  readonly rebuild: (context: RepairStorageContext) => Promise<void>;
}

export interface LiveProviderReindexPort {
  readonly reindex: (context: RepairStorageContext) => Promise<void>;
}

export interface RepairRequest {
  readonly component_kind: RepairComponentKind;
  readonly component_id: string;
  readonly backup_directory?: string;
  readonly rebuild_entries?: ReadonlyArray<unknown>;
  readonly snapshot_rebuild?: SnapshotRebuildPort;
  readonly live_provider?: LiveProviderReindexPort;
  readonly acknowledge_historical_loss?: boolean;
}

export interface RepairResult {
  readonly component_kind: RepairComponentKind;
  readonly component_id: string;
  readonly action: "restore_exact_object" | "rebuild_derived_projection" | "rebuild_manifest_segment" | "rebuild_queryable_snapshot" | "reindex_live_provider" | "restore_authoritative_state";
  readonly next_step: "verify";
}

export const REPAIR_ORDER = ["restore_exact_object", "rebuild_derived_projection", "rebuild_queryable_snapshot", "reindex_live_provider"] as const;

const MIGRATION_TABLE_NAMES = [
  "workspace_meta", "source_artifacts", "content_blobs", "source_observation_batches", "artifact_versions", "artifact_tombstones", "source_observations", "source_index_state",
  "record_occurrences", "record_facets", "record_value_nodes", "set_merkle_nodes", "registry_snapshots", "registry_namespace_bindings", "snapshots", "workspace_current_state", "control_plane_state", "graph_edges",
  "lexical_documents", "lexical_index_state", "semantic_index_state", "artifact_dependencies", "metric_projections", "vector_shards", "vector_projection_rows",
  "retention_leases", "retention_pins", "snapshot_expiration_markers", "query_executions", "query_manifest_segments", "backup_barriers", "lifecycle_cas_pins",
  "lifecycle_roots", "storage_migrations", "garbage_collection_epochs", "garbage_collection_candidates",
  "candidate_state", "candidate_work_manifests", "candidate_fact_deltas", "candidate_fact_delta_namespaces", "candidate_fact_delta_batches", "candidate_staged_records", "candidate_staged_graph_edges", "candidate_staged_identities", "candidate_staged_dependencies", "candidate_publication_record_occurrences", "candidate_publication_record_facets", "candidate_publication_record_closures", "candidate_publication_identity_assignments", "candidate_publication_projection_occurrences", "candidate_publication_projection_dependencies", "candidate_publication_projection_value_nodes", "candidate_publication_projection_descriptors", "candidate_publication_descriptors", "candidate_materializations", "candidate_issues", "candidate_lookup_dependencies",
  "candidate_retention_leases", "candidate_roots", "candidate_cleanup_markers", "candidate_publication_journal", "generation_manifests",
  "projection_occurrences", "projection_occurrence_dependencies", "projection_value_nodes", "candidate_value_nodes", "identity_assignments",
] as const;

export interface MigrationTableAdapter {
  readonly adapter: string;
  readonly decoder: string;
  readonly adapter_version: number;
  readonly decoder_version: number;
  readonly validation_name: string;
  readonly validate: (table: string, row: MigrationLogicalRow) => void;
  readonly decodeRow: (table: string, row: Record<string, unknown>, logicalColumns?: readonly string[]) => MigrationLogicalRow;
  readonly encodeRow: (table: string, row: MigrationLogicalRow) => Record<string, unknown>;
}

export interface MigrationLogicalRow {
  readonly table: string;
  readonly columns: Readonly<Record<string, unknown>>;
  readonly payloads: Readonly<Record<string, unknown>>;
}

function typedMigrationAdapter(table: string, payloadColumns: readonly string[] = []): MigrationTableAdapter {
  const decodeRow = (name: string, row: Record<string, unknown>, logicalColumns?: readonly string[]): MigrationLogicalRow => {
    if (name !== table) throw new StorageError("storage:migration_table_mismatch", `The ${table} adapter cannot decode ${name}.`);
    const allowed = logicalColumns ? new Set(logicalColumns) : undefined;
    const columns: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (allowed && !allowed.has(column)) continue;
      if (payloadColumns.includes(column)) continue;
      columns[column] = value;
    }
    const payloads: Record<string, unknown> = {};
    for (const column of payloadColumns) {
      if (row[column] === undefined || row[column] === null) { payloads[column] = null; continue; }
      payloads[column] = decodeCanonical(bytes(row[column]));
    }
    return { table, columns, payloads };
  };
  const validate = (name: string, row: MigrationLogicalRow): void => {
    if (name !== table || row.table !== table) throw new StorageError("storage:migration_table_mismatch", `The ${table} adapter received a different logical table.`);
    if (table === "workspace_meta" && (typeof row.columns["key"] !== "string" || !(row.columns["value"] instanceof Uint8Array) && !(row.columns["value"] instanceof ArrayBuffer))) throw new StorageError("storage:migration_row_invalid", "Workspace metadata requires a typed key and value.");
    if (table === "vector_projection_rows" || table === "vector_shards") {
      const elementType = row.columns["element_type"];
      if (elementType !== "float32" && elementType !== "float64") throw new StorageError("storage:migration_row_invalid", `Unsupported persisted vector element type ${String(elementType)}.`);
    }
    for (const [column, value] of Object.entries(row.columns)) if (value !== null && value !== undefined && !["string", "number", "bigint", "boolean"].includes(typeof value) && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new StorageError("storage:migration_row_invalid", `Column ${column} in ${table} has an unsupported typed value.`);
  };
  const encodeRow = (name: string, row: MigrationLogicalRow): Record<string, unknown> => {
    if (name !== table || row.table !== table) throw new StorageError("storage:migration_table_mismatch", `The ${table} adapter cannot encode ${name}.`);
    const encoded: Record<string, unknown> = { ...row.columns };
    for (const column of payloadColumns) encoded[column] = row.payloads[column] === null || row.payloads[column] === undefined ? null : encodeCanonical(row.payloads[column]);
    return encoded;
  };
  return { adapter: `typed-${table}-adapter`, decoder: `typed-${table}-decoder`, adapter_version: 1, decoder_version: 1, validation_name: `validate_${table}_v1`, validate, decodeRow, encodeRow };
}

const MIGRATION_PAYLOAD_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // `index_contract` is a one-byte marker rather than a canonical value. Keep
  // workspace metadata as typed SQLite BLOBs so the v2 shadow copy can move
  // both marker bytes and version values without invoking a legacy decoder.
  workspace_meta: [], source_artifacts: [], source_observation_batches: [], artifact_versions: [], artifact_tombstones: [], source_observations: [], record_occurrences: [], registry_snapshots: [], snapshots: [], workspace_current_state: [], control_plane_state: [], graph_edges: [], lexical_documents: [], lexical_index_state: [], semantic_index_state: [], artifact_dependencies: [], metric_projections: [], vector_shards: [], vector_projection_rows: [], retention_leases: [], retention_pins: [], snapshot_expiration_markers: [], query_executions: [], query_manifest_segments: [], backup_barriers: [], lifecycle_roots: [], storage_migrations: [], garbage_collection_epochs: [], candidate_state: [], candidate_work_manifests: [], candidate_fact_deltas: [], candidate_fact_delta_namespaces: [], candidate_staged_records: [], candidate_staged_graph_edges: [], candidate_staged_identities: [], candidate_staged_dependencies: [], candidate_publication_record_occurrences: [], candidate_publication_record_facets: [], candidate_publication_record_closures: [], candidate_publication_identity_assignments: [], candidate_publication_projection_occurrences: [], candidate_publication_projection_dependencies: [], candidate_publication_projection_value_nodes: [], candidate_publication_projection_descriptors: [], candidate_publication_descriptors: [], candidate_materializations: [], candidate_issues: [], candidate_lookup_dependencies: [], candidate_retention_leases: [], candidate_roots: [], candidate_cleanup_markers: [], candidate_publication_journal: [], generation_manifests: [], projection_occurrences: [], projection_occurrence_dependencies: [], identity_assignments: []
};

/** Every persisted table has a table-specific, versioned decoder and lossless row adapter. */
export const MIGRATION_TABLE_ADAPTERS: Readonly<Record<string, MigrationTableAdapter>> = Object.freeze(Object.fromEntries(MIGRATION_TABLE_NAMES.map((table) => [table, typedMigrationAdapter(table, MIGRATION_PAYLOAD_COLUMNS[table] ?? [])])));

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", "SQLite returned a non-binary payload.");
}
function sqliteValue(value: unknown): SqliteValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:migration_value_invalid", "A migrated SQLite value has an unsupported type.");
}
function nullable(value: string | undefined): SqliteValue { return value ?? null; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function nowId(now: string): string { return `gc:${now}:${Math.random().toString(16).slice(2)}`; }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"); }
function isContentHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function isDigest(value: unknown): value is string { return isContentHash(value); }

/** The three projection kinds `projectionSetDigestEntries` covers (see its doc comment). */
export type ProjectionDigestKind = "graph" | "dependency" | "metric";

/** One row of one kind's digest set, in the exact shape `projectionSetDigestEntries` digests over. */
export interface ProjectionKindDigestRow {
  readonly projection_record_id: string;
  readonly content_digest: string;
}

/**
 * One table's visible-range rows, digested per `projectionSetDigestEntries`'s
 * `digest_source` contract (see that function's doc comment for the two
 * modes' exact guarantees). `idColumn` and `payloadColumn` are interpolated
 * table/column identifiers, never user input -- always one of the three
 * fixed literal table configs `projectionSetDigestEntries` passes.
 */
async function projectionDigestRows(database: SqliteDatabase, workspaceId: string, generation: number, table: string, idColumn: string, _digestSource: "stored" | "recompute"): Promise<Array<{ projection_record_id: string; content_digest: string }>> {
  const visible = "workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)";
  const rows = await database.all<{ row_id: string; valid_from_generation: number; content_digest: string }>(`SELECT ${idColumn} AS row_id, valid_from_generation, content_digest FROM ${table} WHERE ${visible}`, [workspaceId, generation, generation]);
  return rows.map((row) => ({ projection_record_id: `${row.row_id}@${row.valid_from_generation}`, content_digest: row.content_digest }));
}

/**
 * Recomputes the contract-shaped projection-set digest entries from typed
 * logical rows for one generation. Standalone (not a `StorageMaintenance`
 * method) so both `StorageMaintenance.getProjectionSetDigestEntries` (used by
 * `verify()`) and `buildCandidatePublicationPlan`
 * (`./publication-authority.js`, which writes a freshly published snapshot's
 * `projection_set_digests` in the exact shape this verifier expects) compute
 * the identical value from the identical query, with no CAS dependency.
 *
 * Covers **transactional** projection kinds only -- graph, dependency,
 * metric -- each written inside the same publish transaction that writes the
 * snapshot itself, so a snapshot's stored digest is always an accurate
 * description of what that transaction actually wrote. Two
 * **asynchronously-maintained** kinds are deliberately excluded:
 *
 * - "lexical": `lexical_documents`/`lexical_fts` are rebuilt
 *   post-`ready` by the lexical reconciler
 *   (`packages/engine/src/lexical-reconciler.ts`, off-main-thread).
 * - "vector": `vector_shards`/`vector_projection_rows` are rebuilt
 *   post-`ready` by the semantic reconciler
 *   (`packages/engine/src/semantic-reconciler.ts`, in-process -- local-hash
 *   embedding is cheap enough that no worker thread is warranted, unlike
 *   lexical's trigram build).
 *
 * Both run strictly *after* the publish transaction that minted this
 * generation's snapshot has already committed. A publish-time digest over
 * either kind's rows was therefore stale the instant the corresponding
 * post-ready rebuild landed -- this is exactly the documented
 * `storage:projection_set_digest_corrupt` verify gap
 * (`isKnownPreexistingVerifyGap`, `packages/engine/src/workspace-fork.ts`).
 * Excluding both here means a freshly published snapshot verifies cleanly
 * and *stays* clean across lexical rebuilds and semantic (vector) rebuilds
 * alike, instead of merely being clean until the next reconcile pass of
 * either. Snapshots published before lexical was excluded stored a 5-entry
 * array (lexical included); snapshots published between that change and
 * this one stored a 4-entry array (vector still included) -- `verify()`
 * still reports `storage:projection_set_digest_corrupt` for both older
 * shapes, which was already effectively true for any workspace whose
 * lexical or vector index was rebuilt even once after that snapshot's
 * publish.
 *
 * Entries within a kind are ordered by plain UTF-16 code-unit comparison of
 * `projection_record_id` (not `localeCompare`): locale-dependent ordering
 * would make the digest vary by machine locale, and on a large visible set
 * (millions of rows on a real repository) `localeCompare` measured roughly
 * 6x slower than the plain comparator. `content_digest` is the digest of the
 * exact stored canonical payload bytes -- not a decode/re-encode round trip
 * -- because every payload in these tables is written via `encodeCanonical`
 * at publish (`artifactDependencyCommands`/`projectionCommands`,
 * `./publication-authority.js`), copied byte-for-byte by a workspace fork's
 * bulk copy, and re-encoded canonically by migration adapters, so decoding
 * and re-encoding a payload already in canonical form is always an identity
 * transform and changes no digest value.
 *
 * `options.digest_source` picks how each row's `content_digest` is obtained.
 * Both modes are required to agree byte-for-byte on every row -- they apply
 * the identical `digestBytes` leaf recipe to the identical stored bytes --
 * `"stored"` just gets there without re-hashing a BLOB this process (or an
 * earlier one) already hashed once at write time:
 *
 * - `"recompute"` (the default; what `verify()` and fork `verify_mode:
 *   "full"` always ask for): hashes each typed row fresh, exactly as this
 *   function always has, so it still catches real value corruption. When a
 *   row's persisted `content_digest`
 *   column is also populated, this mode additionally compares it against the
 *   freshly recomputed hash and throws `storage:projection_content_digest_corrupt`
 *   on disagreement -- a corrupted digest column is exactly the kind of
 *   corruption `verify()` exists to catch, not a value it should silently
 *   prefer or silently ignore.
 * - `"stored"` (what the publish path and the fork plan path ask for): reads
 *   each row's persisted `content_digest` column instead of its payload
 *   BLOB -- an index-only scan via `<table>_digest_scan_idx`
 *   (`packages/storage/src/schema.ts`) that never touches a payload page --
 *   falling back to hashing the BLOB only for a row whose `content_digest`
 *   is still NULL (a not-yet-backfilled row; see `ensureProjectionContentDigests`
 *   in `./schema.js`). Safe specifically because every write site
 *   (`WorkspaceProjectionRepository.putGraphEdge`/`putMetric`,
 *   `artifactDependencyCommands`, the fork copy path) populates
 *   `content_digest` with this exact same `digestBytes` recipe at insert
 *   time, so "stored" and "recompute" can only ever produce the same value
 *   for the same row.
 */
export async function projectionSetDigestEntries(database: SqliteDatabase, workspaceId: string, generation: number, options?: { readonly digest_source?: "stored" | "recompute"; readonly row_overrides?: Readonly<Partial<Record<ProjectionDigestKind, readonly ProjectionKindDigestRow[]>>> }): Promise<ReadonlyArray<ProjectionSetDigestEntry>> {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new StorageError("storage:invalid_generation", "Projection digest generation must be a non-negative safe integer.");
  const digestSource = options?.digest_source ?? "recompute";
  // `row_overrides` (per-kind) lets a caller that already knows a kind's
  // exact row set -- the warm projection-set digest corpus,
  // `ProjectionSetDigestCorpusEntry` in `./publication-authority.js` -- skip
  // that kind's live SQL read entirely while reusing this function's own
  // sort/digest math unchanged, so a corpus-fed and a SQL-fed call are
  // byte-identical by construction (the same guarantee `digest_source:
  // "stored"` vs `"recompute"` already gives across their two row sources).
  // Only supplied kinds are overridden; an absent kind still reads live.
  const overrides = options?.row_overrides;
  const byKind = new Map<string, { readonly generator: string; readonly rows: readonly ProjectionKindDigestRow[] }>([
    ["graph", { generator: "urdira.storage.graph-adjacency", rows: overrides?.graph ?? await projectionDigestRows(database, workspaceId, generation, "graph_edges", "edge_id", digestSource) }],
    ["dependency", { generator: "urdira.storage.reverse-dependency", rows: overrides?.dependency ?? await projectionDigestRows(database, workspaceId, generation, "artifact_dependencies", "dependency_entry_id", digestSource) }],
    ["metric", { generator: "urdira.storage.metric", rows: overrides?.metric ?? await projectionDigestRows(database, workspaceId, generation, "metric_projections", "metric_id", digestSource) }],
  ]);
  const entries: Array<ProjectionSetDigestEntry> = [];
  for (const [projection_kind, value] of byKind) {
    const rows = [...value.rows].sort((left, right) => (left.projection_record_id < right.projection_record_id ? -1 : left.projection_record_id > right.projection_record_id ? 1 : 0));
    const generator_version = "1";
    const generator_configuration_digest = digestLogicalValue({ workspace_id: workspaceId, projection_kind, generator: value.generator, generator_version }, "urdira:projection-generator:v2");
    // Hash the logical rows directly. No aggregate transport or persistence
    // payload is created on the query/publication hot path.
    const projection_set_digest = digestLogicalValue({ projection_kind, generator: value.generator, generator_version, generator_configuration_digest, entries: rows }, "urdira:projection-set:v2");
    entries.push({ projection_kind, generator: value.generator, generator_version, generator_configuration_digest, projection_set_digest });
  }
  return entries;
}

const PROJECTION_DIGEST_TABLE_CONFIG: Readonly<Record<ProjectionDigestKind, { readonly table: string; readonly idColumn: string }>> = {
  graph: { table: "graph_edges", idColumn: "edge_id" },
  dependency: { table: "artifact_dependencies", idColumn: "dependency_entry_id" },
  metric: { table: "metric_projections", idColumn: "metric_id" },
};

/**
 * The raw per-kind row sets `projectionSetDigestEntries` digests over,
 * fetched with the identical `projectionDigestRows` query that function uses
 * -- exported so the warm projection-set digest corpus
 * (`ProjectionSetDigestCorpusEntry`, `./publication-authority.js`) can seed
 * or refresh itself from a live read (corpus-miss / cold-start path) without
 * a second, possibly-diverging row-fetch implementation. Not sorted (callers
 * that need sorted output -- `projectionSetDigestEntries` itself, or the
 * corpus's own merge step -- sort after merging in whatever rows they end up
 * with, exactly as `projectionSetDigestEntries` already does for a live
 * read).
 */
export async function projectionSetDigestRowsByKind(database: SqliteDatabase, workspaceId: string, generation: number, digestSource: "stored" | "recompute" = "stored"): Promise<Readonly<Record<ProjectionDigestKind, readonly ProjectionKindDigestRow[]>>> {
  const graph = await projectionDigestRows(database, workspaceId, generation, PROJECTION_DIGEST_TABLE_CONFIG.graph.table, PROJECTION_DIGEST_TABLE_CONFIG.graph.idColumn, digestSource);
  const dependency = await projectionDigestRows(database, workspaceId, generation, PROJECTION_DIGEST_TABLE_CONFIG.dependency.table, PROJECTION_DIGEST_TABLE_CONFIG.dependency.idColumn, digestSource);
  const metric = await projectionDigestRows(database, workspaceId, generation, PROJECTION_DIGEST_TABLE_CONFIG.metric.table, PROJECTION_DIGEST_TABLE_CONFIG.metric.idColumn, digestSource);
  return { graph, dependency, metric };
}

function collectContentHashes(value: unknown, hashes: Set<string>): void {
  if (isContentHash(value)) { hashes.add(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectContentHashes(item, hashes); return; }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (key === "content_hash" || key === "content_digest" || key === "payload_cas_digest" || key === "manifest_digest" || key === "contribution_digest" || key === "root_digest" || key === "storage_reference") collectContentHashes(item, hashes);
    else if (item && typeof item === "object") collectContentHashes(item, hashes);
  }
}
async function statPath(path: string): Promise<void> { await import("node:fs/promises").then(({ stat }) => stat(path)).then(() => undefined); }
async function pathExists(path: string): Promise<boolean> { try { await statPath(path); return true; } catch { return false; } }
async function syncFile(path: string): Promise<void> { const handle = await openFile(path, process.platform === "win32" ? "r+" : "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(path: string): Promise<void> { const handle = await openFile(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function syncNamespace(directory: string, installedFile: string): Promise<void> {
  if (process.platform === "win32") await syncFile(installedFile);
  else await syncDirectory(directory);
}
async function removeTree(path: string): Promise<void> { await rm(path, { recursive: true, force: true }); }

/**
 * Pre-flattening (two-level shard) CAS relative path segments, kept only to
 * probe backup archives written before the single-level shard layout
 * (`casObjectRelativeParts` in `./cas.js`). Never used to write a path.
 */
function legacyCasObjectRelativeParts(contentHash: string): readonly [string, string, string, string] {
  const hex = contentHash.slice("sha256:".length);
  return ["sha256", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)];
}

/**
 * Resolves a CAS object's actual path inside a backup/restore directory's
 * `cas/` tree. Backup archives are immutable, read-only content, and one
 * predating the shard flattening still has its objects at the legacy
 * two-level path, so the new-layout path is preferred and the legacy path is
 * probed only when it is missing. Every caller of the resolved path
 * digest-verifies the bytes against `contentHash`, so reading an old-layout
 * backup by content hash is safe either way.
 */
async function resolveCasObjectPathInBackup(backupDirectory: string, contentHash: string): Promise<string> {
  const primary = join(backupDirectory, "cas", ...casObjectRelativeParts(contentHash));
  if (await pathExists(primary)) return primary;
  return join(backupDirectory, "cas", ...legacyCasObjectRelativeParts(contentHash));
}

async function readCasObjectFromBackup(backupDirectory: string, contentHash: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(await resolveCasObjectPathInBackup(backupDirectory, contentHash)));
}

export function storageFilesystemEntryName(prefix: string, logicalId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix) || logicalId.length === 0) throw new StorageError("storage:path_invalid", "Physical storage entry inputs are invalid.");
  return `${prefix}-${digestBytes(new TextEncoder().encode(logicalId)).slice("sha256:".length)}`;
}

/**
 * Parses a `<2-hex-char shard>/<62-hex-char rest>` path relative to the
 * `cas/sha256` root back into its content hash. Only the current
 * single-level shard layout is accepted here: `listCasHashes` below only
 * ever walks a root that `DurableStorage.open`'s layout-marker check has
 * already verified is current (`storage.ts`'s `enforceCasLayoutMarker`), so
 * there is no live single-level-shard root that could still hold a
 * two-level path.
 */
export function casHashFromStorageRelativePath(relativePath: string): string | undefined {
  const components = relativePath.split(/[\\/]/);
  const hex = components.length === 2 ? components.join("") : "";
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : undefined;
}

export class WorkspaceLifecycleRepository {
  constructor(private readonly database: SqliteDatabase, private readonly workspaceId: string, private readonly faults: FaultInjector = noFaults, private readonly blobs?: BlobStore, private readonly rootDir?: string) {}

  private async assertReaderBarrierClear(): Promise<void> {
    const barrier = await this.database.get<{ garbage_collection_epoch_id: string }>("SELECT garbage_collection_epoch_id FROM garbage_collection_epochs WHERE workspace_id = ? AND state IN ('marking', 'sweeping') LIMIT 1", [this.workspaceId]);
    if (barrier) throw new StorageError("storage:gc_reader_barrier", `Garbage-collection epoch ${barrier.garbage_collection_epoch_id} is holding the reader barrier.`);
    if (this.rootDir) {
      const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), read_only: true });
      try {
        const globalBarrier = await catalog.get<{ garbage_collection_epoch_id: string }>("SELECT garbage_collection_epoch_id FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping') LIMIT 1");
        if (globalBarrier) throw new StorageError("storage:gc_reader_barrier", `Garbage-collection epoch ${globalBarrier.garbage_collection_epoch_id} is holding the global reader barrier.`);
      } finally { await catalog.close(); }
    }
  }

  private executionValues(input: QueryExecutionInput): { readonly query_plan_hash: string; readonly projection_digest: string; readonly scope_digest: string; readonly response_budget_ceiling: string; readonly retention_lease_ids: ReadonlyArray<string> } {
    return { query_plan_hash: input.query_plan_hash ?? "", projection_digest: input.projection_digest ?? "", scope_digest: input.scope_digest ?? "", response_budget_ceiling: input.response_budget_ceiling ?? "", retention_lease_ids: input.retention_lease_ids ?? [] };
  }

  private async requireSnapshots(snapshotIds: ReadonlyArray<string>): Promise<void> {
    if (snapshotIds.length === 0 || new Set(snapshotIds).size !== snapshotIds.length) throw new StorageError("storage:snapshot_binding_invalid", "An execution must bind a non-empty set of distinct snapshots.");
    const rows: Array<{ snapshot_id: string }> = [];
    for (let offset = 0; offset < snapshotIds.length; offset += 400) {
      const ids = snapshotIds.slice(offset, offset + 400);
      rows.push(...await this.database.all<{ snapshot_id: string }>(`SELECT snapshot_id FROM snapshots WHERE workspace_id = ? AND snapshot_id IN (${ids.map(() => "?").join(",")})`, [this.workspaceId, ...ids]));
    }
    if (rows.length !== snapshotIds.length) throw new StorageError("storage:snapshot_not_found", "Retention may only reference snapshots retained in this workspace.");
  }

  private async validateExecutionBindings(snapshotIds: ReadonlyArray<string>, leaseIds: ReadonlyArray<string>, createdAt: string): Promise<void> {
    await this.requireSnapshots(snapshotIds);
    if (leaseIds.length !== snapshotIds.length || new Set(leaseIds).size !== leaseIds.length) throw new StorageError("storage:execution_lease_mismatch", "Each bound snapshot must have exactly one distinct retention lease.");
    const leases: Array<{ retention_lease_id: string; snapshot_id: string; released_at: string | null; idle_expires_at: string; absolute_expires_at: string }> = [];
    for (let offset = 0; offset < leaseIds.length; offset += 400) {
      const ids = leaseIds.slice(offset, offset + 400);
      leases.push(...await this.database.all<{ retention_lease_id: string; snapshot_id: string; released_at: string | null; idle_expires_at: string; absolute_expires_at: string }>(`SELECT retention_lease_id, snapshot_id, released_at, idle_expires_at, absolute_expires_at FROM retention_leases WHERE workspace_id = ? AND retention_lease_id IN (${ids.map(() => "?").join(",")})`, [this.workspaceId, ...ids]));
    }
    if (leases.length !== leaseIds.length || leases.some((lease) => lease.released_at !== null || lease.idle_expires_at <= createdAt || lease.absolute_expires_at <= createdAt || !snapshotIds.includes(lease.snapshot_id)) || new Set(leases.map((lease) => lease.snapshot_id)).size !== snapshotIds.length) throw new StorageError("storage:execution_lease_mismatch", "Execution bindings require one valid, unexpired lease for every bound snapshot.");
  }

  async acquireLease(input: RetentionLeaseInput): Promise<RetentionLease> {
    await this.assertReaderBarrierClear();
    await this.requireSnapshots([input.snapshot_id]);
    const existing = await this.database.get<{ snapshot_id: string; holder_type: string; holder_id: string; acquired_at: string; idle_expires_at: string; absolute_expires_at: string; released_at: string | null }>("SELECT snapshot_id, holder_type, holder_id, acquired_at, idle_expires_at, absolute_expires_at, released_at FROM retention_leases WHERE workspace_id = ? AND retention_lease_id = ?", [this.workspaceId, input.retention_lease_id]);
    if (existing) {
      if (existing.released_at !== null || existing.snapshot_id !== input.snapshot_id || existing.holder_type !== input.holder_type || existing.holder_id !== input.holder_id || existing.acquired_at !== input.now || existing.idle_expires_at !== input.idle_expires_at || existing.absolute_expires_at !== input.absolute_expires_at) throw new StorageError("storage:lease_conflict", `Retention lease ${input.retention_lease_id} is immutable.`);
      return this.toLease(input);
    }
    await this.database.run("INSERT INTO retention_leases (retention_lease_id, workspace_id, snapshot_id, holder_type, holder_id, acquired_at, last_renewed_at, idle_expires_at, absolute_expires_at, released_at, release_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)", [input.retention_lease_id, this.workspaceId, input.snapshot_id, input.holder_type, input.holder_id, input.now, input.now, input.idle_expires_at, input.absolute_expires_at]);
    return this.toLease(input);
  }

  async renewLease(retentionLeaseId: string, now: string, idleExpiresAt: string): Promise<void> {
    const result = await this.database.run("UPDATE retention_leases SET last_renewed_at = ?, idle_expires_at = ? WHERE workspace_id = ? AND retention_lease_id = ? AND released_at IS NULL AND absolute_expires_at > ?", [now, idleExpiresAt, this.workspaceId, retentionLeaseId, now]);
    if (result.changes !== 1) throw new StorageError("storage:lease_expired", `Retention lease ${retentionLeaseId} is not active.`);
  }

  async releaseLease(retentionLeaseId: string, releasedAt: string, reason: string): Promise<void> {
    await this.faults.hit("retention.before_release");
    const row = await this.database.get<{ retention_lease_id: string }>("SELECT retention_lease_id FROM retention_leases WHERE workspace_id = ? AND retention_lease_id = ? AND released_at IS NULL", [this.workspaceId, retentionLeaseId]);
    if (!row) return;
    await this.database.transaction([{ kind: "run", sql: "UPDATE retention_leases SET released_at = ?, release_reason = ? WHERE workspace_id = ? AND retention_lease_id = ? AND released_at IS NULL", params: [releasedAt, reason, this.workspaceId, retentionLeaseId] }]);
  }

  async getLease(retentionLeaseId: string): Promise<RetentionLease | undefined> {
    const row = await this.database.get<{ retention_lease_id: string; snapshot_id: string; holder_type: string; holder_id: string; acquired_at: string; last_renewed_at: string; idle_expires_at: string; absolute_expires_at: string; released_at: string | null; release_reason: string | null }>("SELECT retention_lease_id, snapshot_id, holder_type, holder_id, acquired_at, last_renewed_at, idle_expires_at, absolute_expires_at, released_at, release_reason FROM retention_leases WHERE workspace_id = ? AND retention_lease_id = ?", [this.workspaceId, retentionLeaseId]);
    if (!row) return undefined;
    return { retention_lease_id: row.retention_lease_id, workspace_id: this.workspaceId, snapshot_id: row.snapshot_id, holder_type: row.holder_type, holder_id: row.holder_id, acquired_at: row.acquired_at, last_renewed_at: row.last_renewed_at, idle_expires_at: row.idle_expires_at, absolute_expires_at: row.absolute_expires_at, released_at: row.released_at ?? "", release_reason: row.release_reason ?? "" };
  }

  async pinSnapshot(input: SnapshotPinInput): Promise<SnapshotRetentionPin> {
    await this.assertReaderBarrierClear();
    await this.requireSnapshots([input.snapshot_id]);
    const sourceReferenceJson = JSON.stringify(input.source_reference);
    const existing = await this.database.get<{ source_reference_json: string; snapshot_id: string; pin_kind: string; reason_code: string; created_at: string; expires_at: string }>("SELECT source_reference_json, snapshot_id, pin_kind, reason_code, created_at, expires_at FROM retention_pins WHERE workspace_id = ? AND retention_pin_id = ?", [this.workspaceId, input.retention_pin_id]);
    if (existing) {
      if (existing.source_reference_json !== sourceReferenceJson || existing.snapshot_id !== input.snapshot_id || existing.pin_kind !== input.pin_kind || existing.reason_code !== input.reason_code || existing.created_at !== input.created_at || existing.expires_at !== input.expires_at) throw new StorageError("storage:pin_conflict", `Retention pin ${input.retention_pin_id} is immutable.`);
      return this.toPin(input);
    }
    await this.database.run("INSERT INTO retention_pins (retention_pin_id, workspace_id, snapshot_id, pin_kind, reason_code, created_at, expires_at, released_at, release_reason, source_reference_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)", [input.retention_pin_id, this.workspaceId, input.snapshot_id, input.pin_kind, input.reason_code, input.created_at, input.expires_at, sourceReferenceJson]);
    return this.toPin(input);
  }

  async releasePin(retentionPinId: string, releasedAt = new Date().toISOString(), reason = "released"): Promise<void> {
    await this.faults.hit("retention.before_release");
    const row = await this.database.get<{ retention_pin_id: string }>("SELECT retention_pin_id FROM retention_pins WHERE workspace_id = ? AND retention_pin_id = ? AND released_at IS NULL", [this.workspaceId, retentionPinId]);
    if (!row) return;
    await this.database.transaction([{ kind: "run", sql: "UPDATE retention_pins SET released_at = ?, release_reason = ? WHERE workspace_id = ? AND retention_pin_id = ? AND released_at IS NULL", params: [releasedAt, reason, this.workspaceId, retentionPinId] }]);
  }
  async getPin(retentionPinId: string): Promise<SnapshotRetentionPin | undefined> {
    const row = await this.database.get<{ source_reference_json: string; retention_pin_id: string; workspace_id: string; snapshot_id: string; pin_kind: string; reason_code: string; created_at: string; expires_at: string; released_at: string | null; release_reason: string | null }>("SELECT source_reference_json, retention_pin_id, workspace_id, snapshot_id, pin_kind, reason_code, created_at, expires_at, released_at, release_reason FROM retention_pins WHERE workspace_id = ? AND retention_pin_id = ?", [this.workspaceId, retentionPinId]);
    if (!row) return undefined;
    return { retention_pin_id: row.retention_pin_id, workspace_id: row.workspace_id, snapshot_id: row.snapshot_id, pin_kind: row.pin_kind, reason_code: row.reason_code, source_reference: JSON.parse(row.source_reference_json) as SourceReference, created_at: row.created_at, expires_at: row.expires_at, released_at: row.released_at ?? "", release_reason: row.release_reason ?? "" };
  }

  async markSnapshotExpired(input: SnapshotExpirationMarkerInput): Promise<SnapshotExpirationMarker> {
    const existing = await this.database.get<Record<string, unknown>>("SELECT snapshot_expiration_id, workspace_id, snapshot_id, generation, expired_at, expiration_reason_code, garbage_collection_epoch_id, snapshot_digest FROM snapshot_expiration_markers WHERE workspace_id = ? AND snapshot_expiration_id = ?", [this.workspaceId, input.snapshot_expiration_id]);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new StorageError("storage:expiration_conflict", `Snapshot expiration ${input.snapshot_expiration_id} is immutable.`);
      return input;
    }
    await this.database.run("INSERT INTO snapshot_expiration_markers (snapshot_expiration_id, workspace_id, snapshot_id, generation, expired_at, expiration_reason_code, garbage_collection_epoch_id, snapshot_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [input.snapshot_expiration_id, this.workspaceId, input.snapshot_id, input.generation, input.expired_at, input.expiration_reason_code, input.garbage_collection_epoch_id, input.snapshot_digest]);
    return input;
  }

  async getExpirationMarker(snapshotId: string): Promise<SnapshotExpirationMarker | undefined> {
    const row = await this.database.get<Record<string, unknown>>("SELECT snapshot_expiration_id, workspace_id, snapshot_id, generation, expired_at, expiration_reason_code, garbage_collection_epoch_id, snapshot_digest FROM snapshot_expiration_markers WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, snapshotId]);
    return row ? row as unknown as SnapshotExpirationMarker : undefined;
  }

  async pinCasObject(contentHash: string): Promise<void> { await this.assertReaderBarrierClear(); await this.database.run("INSERT INTO lifecycle_cas_pins (workspace_id, content_hash) VALUES (?, ?) ON CONFLICT(workspace_id, content_hash) DO NOTHING", [this.workspaceId, contentHash]); }

  async addRetentionRoot(rootKind: "candidate" | "recovery" | "backup", rootId: string, contentHash: string): Promise<void> {
    await this.assertReaderBarrierClear();
    await this.database.run("INSERT INTO lifecycle_roots (workspace_id, root_kind, root_id, content_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, root_kind, root_id, content_hash) DO NOTHING", [this.workspaceId, rootKind, rootId, contentHash, new Date().toISOString()]);
  }

  async createExecution(input: QueryExecutionInput): Promise<void> {
    await this.assertReaderBarrierClear();
    const execution = this.executionValues(input);
    await this.validateExecutionBindings(input.workspace_snapshot_ids, execution.retention_lease_ids, input.created_at);
    const existing = await this.database.get<{ execution_status: string; workspace_snapshot_ids: string; query_plan_hash: string; projection_digest: string; scope_digest: string; response_budget_ceiling: string; retention_lease_ids: string; created_at: string; expires_at: string }>("SELECT execution_status, workspace_snapshot_ids, query_plan_hash, projection_digest, scope_digest, response_budget_ceiling, retention_lease_ids, created_at, expires_at FROM query_executions WHERE workspace_id = ? AND query_execution_id = ?", [this.workspaceId, input.query_execution_id]);
    if (existing) {
      if (existing.execution_status !== "ready" || existing.workspace_snapshot_ids !== JSON.stringify(input.workspace_snapshot_ids) || existing.query_plan_hash !== execution.query_plan_hash || existing.projection_digest !== execution.projection_digest || existing.scope_digest !== execution.scope_digest || existing.response_budget_ceiling !== execution.response_budget_ceiling || existing.retention_lease_ids !== JSON.stringify(execution.retention_lease_ids) || existing.created_at !== input.created_at || existing.expires_at !== input.expires_at) throw new StorageError("storage:execution_conflict", `Query execution ${input.query_execution_id} conflicts with its immutable metadata.`);
      return;
    }
    await this.database.run("INSERT INTO query_executions (query_execution_id, workspace_id, workspace_snapshot_ids, query_plan_hash, projection_digest, scope_digest, response_budget_ceiling, retention_lease_ids, created_at, expires_at, execution_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')", [input.query_execution_id, this.workspaceId, JSON.stringify(input.workspace_snapshot_ids), execution.query_plan_hash, execution.projection_digest, execution.scope_digest, execution.response_budget_ceiling, JSON.stringify(execution.retention_lease_ids), input.created_at, input.expires_at]);
  }

  async readExecution(executionId: string): Promise<QueryExecutionRecord | undefined> {
    const row = await this.database.get<{ query_execution_id: string; workspace_id: string; workspace_snapshot_ids: string; query_plan_hash: string; projection_digest: string; scope_digest: string; response_budget_ceiling: string; retention_lease_ids: string; created_at: string; expires_at: string; execution_status: string }>("SELECT query_execution_id, workspace_id, workspace_snapshot_ids, query_plan_hash, projection_digest, scope_digest, response_budget_ceiling, retention_lease_ids, created_at, expires_at, execution_status FROM query_executions WHERE workspace_id = ? AND query_execution_id = ?", [this.workspaceId, executionId]);
    if (!row) return undefined;
    const parse = (value: string): readonly string[] => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } };
    return { query_execution_id: row.query_execution_id, workspace_id: row.workspace_id, workspace_snapshot_ids: parse(row.workspace_snapshot_ids), query_plan_hash: row.query_plan_hash, projection_digest: row.projection_digest, scope_digest: row.scope_digest, response_budget_ceiling: row.response_budget_ceiling, retention_lease_ids: parse(row.retention_lease_ids), created_at: row.created_at, expires_at: row.expires_at, execution_status: row.execution_status };
  }

  async appendManifestSegment(executionId: string, segmentId: string, entries: ReadonlyArray<unknown>): Promise<void> {
    await this.faults.hit("manifest.before_append");
    const execution = await this.database.get<{ execution_status: string; expires_at: string }>("SELECT execution_status, expires_at FROM query_executions WHERE workspace_id = ? AND query_execution_id = ?", [this.workspaceId, executionId]);
    if (!execution) throw new StorageError("storage:execution_not_found", `Query execution ${executionId} is not retained.`);
    if (execution.execution_status !== "ready") throw new StorageError("storage:execution_expired", `Query execution ${executionId} is expired.`);
    const payload = encodeCanonical(entries);
    const digest = digestBytes(payload);
    if (!this.blobs) throw new StorageError("storage:manifest_storage_unavailable", "Manifest segments require a content-addressed blob store.");
    const existing = await this.database.get<{ content_digest: string }>("SELECT content_digest FROM query_manifest_segments WHERE query_execution_id = ? AND segment_id = ?", [executionId, segmentId]);
    if (existing) {
      if (existing.content_digest !== digest) throw new StorageError("storage:manifest_conflict", `Manifest segment ${segmentId} is immutable.`);
      return;
    }
    const segmentBlob = await this.blobs.cas.put(payload, { media_type: "application/urdira-manifest" });
    const ordinals = entries.map((entry) => (entry && typeof entry === "object" && "ordinal" in entry && typeof entry.ordinal === "number" ? entry.ordinal : 0));
    const firstOrdinal = ordinals.length === 0 ? 0 : Math.min(...ordinals);
    const lastOrdinal = ordinals.length === 0 ? 0 : Math.max(...ordinals);
    const ordinal = (await this.database.get<{ next_ordinal: number | null }>("SELECT MAX(segment_ordinal) + 1 AS next_ordinal FROM query_manifest_segments WHERE query_execution_id = ?", [executionId]))?.next_ordinal ?? 0;
    // The segment row is an immutable compare-and-set.  A retry after a
    // process crash may reach this point after the blob was durable and the
    // row was committed, so the insert must be idempotent instead of turning
    // a successful retry into a UNIQUE failure.  We verify the stored digest
    // below and reject any attempt to reuse the segment id for different
    // content.
    await this.database.transaction([
      { kind: "run", sql: "INSERT INTO query_manifest_segments (query_execution_id, segment_id, segment_ordinal, entry_count, first_ordinal, last_ordinal, content_digest, storage_reference, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(query_execution_id, segment_id) DO NOTHING", params: [executionId, segmentId, ordinal, entries.length, firstOrdinal, lastOrdinal, digest, segmentBlob.storage_reference, payload.byteLength] },
      { kind: "run", sql: "INSERT INTO lifecycle_roots (workspace_id, root_kind, root_id, content_hash, created_at) VALUES (?, 'query_manifest', ?, ?, ?) ON CONFLICT(workspace_id, root_kind, root_id, content_hash) DO NOTHING", params: [this.workspaceId, `${executionId}/${segmentId}`, digest, new Date().toISOString()] },
    ]);
    const committed = await this.database.get<{ content_digest: string; storage_reference: string; byte_length: number }>("SELECT content_digest, storage_reference, byte_length FROM query_manifest_segments WHERE query_execution_id = ? AND segment_id = ?", [executionId, segmentId]);
    if (committed === undefined || committed.content_digest !== digest || committed.storage_reference !== segmentBlob.storage_reference || committed.byte_length !== payload.byteLength) {
      throw new StorageError("storage:manifest_conflict", `Manifest segment ${segmentId} does not match its durable content-addressed record.`);
    }
    await this.faults.hit("manifest.after_append");
  }

  async hydrateManifest<T = unknown>(executionId: string, start: number, limit: number, now = new Date().toISOString()): Promise<readonly T[]> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new StorageError("storage:manifest_range_invalid", "Manifest hydration ranges must be non-negative safe integers.");
    const execution = await this.database.get<{ execution_status: string; expires_at: string }>("SELECT execution_status, expires_at FROM query_executions WHERE workspace_id = ? AND query_execution_id = ?", [this.workspaceId, executionId]);
    if (!execution || execution.execution_status !== "ready") throw new StorageError("storage:execution_expired", `Query execution ${executionId} is expired.`);
    if (execution.expires_at <= now) throw new StorageError("storage:execution_expired", `Query execution ${executionId} is expired.`);
    if (!this.blobs) throw new StorageError("storage:manifest_storage_unavailable", "Manifest segments require a content-addressed blob store.");
    const end = start + limit;
    const segments = await this.database.all<{ first_ordinal: number; last_ordinal: number; content_digest: string }>("SELECT first_ordinal, last_ordinal, content_digest FROM query_manifest_segments WHERE query_execution_id = ? AND last_ordinal >= ? AND first_ordinal < ? ORDER BY segment_ordinal", [executionId, start, end]);
    const page: unknown[] = [];
    for (const segment of segments) {
      const payload = await this.blobs.cas.read(segment.content_digest);
      if (digestBytes(payload) !== segment.content_digest) throw new StorageError("storage:manifest_corrupt", `Manifest segment ${segment.content_digest} failed verification.`);
      const entries = decodeCanonical(payload, { max_bytes: 256 * 1024 * 1024, max_elements: 10_000_000 }) as unknown[];
      for (const [index, entry] of entries.entries()) {
        const ordinal = entry && typeof entry === "object" && "ordinal" in entry && typeof entry.ordinal === "number" ? entry.ordinal : segment.first_ordinal + index;
        if (ordinal >= start && ordinal < end) page.push(entry);
        if (page.length >= limit) return page as T[];
      }
    }
    return page as T[];
  }

  async hydrateManifestSegment<T = unknown>(executionId: string, segmentId: string, start: number, limit: number, now = new Date().toISOString()): Promise<readonly T[]> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new StorageError("storage:manifest_range_invalid", "Manifest hydration ranges must be non-negative safe integers.");
    const execution = await this.database.get<{ execution_status: string; expires_at: string }>("SELECT execution_status, expires_at FROM query_executions WHERE workspace_id = ? AND query_execution_id = ?", [this.workspaceId, executionId]);
    if (!execution || execution.execution_status !== "ready" || execution.expires_at <= now) throw new StorageError("storage:execution_expired", `Query execution ${executionId} is expired.`);
    if (!this.blobs) throw new StorageError("storage:manifest_storage_unavailable", "Manifest segments require a content-addressed blob store.");
    const rows = await this.database.all<{ first_ordinal: number; content_digest: string }>("SELECT first_ordinal, content_digest FROM query_manifest_segments WHERE query_execution_id = ? AND segment_id = ?", [executionId, segmentId]);
    const page: unknown[] = [];
    for (const segment of rows) {
      const payload = await this.blobs.cas.read(segment.content_digest);
      if (digestBytes(payload) !== segment.content_digest) throw new StorageError("storage:manifest_corrupt", `Manifest segment ${segment.content_digest} failed verification.`);
      const entries = decodeCanonical(payload, { max_bytes: 256 * 1024 * 1024, max_elements: 10_000_000 }) as unknown[];
      for (const [index, entry] of entries.entries()) {
        const ordinal = entry && typeof entry === "object" && "ordinal" in entry && typeof entry.ordinal === "number" ? entry.ordinal : segment.first_ordinal + index;
        if (ordinal >= start && ordinal < start + limit) page.push(entry);
        if (page.length >= limit) return page as T[];
      }
    }
    return page as T[];
  }

  async expireExecutions(now: string): Promise<readonly string[]> {
    const expired = await this.database.all<{ query_execution_id: string; retention_lease_ids: string }>("SELECT query_execution_id, retention_lease_ids FROM query_executions WHERE workspace_id = ? AND execution_status = 'ready' AND expires_at <= ? ORDER BY query_execution_id", [this.workspaceId, now]);
    if (expired.length === 0) return [];
    const expiredIds = new Set(expired.map(({ query_execution_id }) => query_execution_id));
    const retainedLeaseIds = new Set(expired.flatMap((execution) => {
      try { return JSON.parse(execution.retention_lease_ids) as string[]; } catch { return []; }
    }));
    const activeLeases = await this.database.all<{ retention_lease_id: string; holder_id: string }>("SELECT retention_lease_id, holder_id FROM retention_leases WHERE workspace_id = ? AND released_at IS NULL", [this.workspaceId]);
    const commands: Array<{ kind: "run"; sql: string; params: readonly SqliteValue[] }> = [];
    for (const lease of activeLeases) {
      if (!expiredIds.has(lease.holder_id) && !retainedLeaseIds.has(lease.retention_lease_id)) continue;
      commands.push({ kind: "run", sql: "UPDATE retention_leases SET released_at = ?, release_reason = ? WHERE workspace_id = ? AND retention_lease_id = ? AND released_at IS NULL", params: [now, "execution_expired", this.workspaceId, lease.retention_lease_id] });
    }
    for (const { query_execution_id } of expired) commands.push(
      { kind: "run", sql: "DELETE FROM lifecycle_roots WHERE workspace_id = ? AND root_kind = 'query_manifest' AND root_id LIKE ?", params: [this.workspaceId, `${query_execution_id}/%`] },
      { kind: "run", sql: "DELETE FROM query_manifest_segments WHERE query_execution_id = ?", params: [query_execution_id] },
      { kind: "run", sql: "UPDATE query_executions SET execution_status = 'expired' WHERE workspace_id = ? AND query_execution_id = ? AND execution_status = 'ready'", params: [this.workspaceId, query_execution_id] },
    );
    await this.faults.hit("retention.before_expiry_commit");
    await this.database.transaction(commands);
    return expired.map(({ query_execution_id }) => query_execution_id);
  }

  private toLease(input: RetentionLeaseInput): RetentionLease { return { retention_lease_id: input.retention_lease_id, workspace_id: this.workspaceId, snapshot_id: input.snapshot_id, holder_type: input.holder_type, holder_id: input.holder_id, acquired_at: input.now, last_renewed_at: input.now, idle_expires_at: input.idle_expires_at, absolute_expires_at: input.absolute_expires_at, released_at: "", release_reason: "" }; }
  private toPin(input: SnapshotPinInput): SnapshotRetentionPin { return { retention_pin_id: input.retention_pin_id, workspace_id: this.workspaceId, snapshot_id: input.snapshot_id, pin_kind: input.pin_kind, reason_code: input.reason_code, source_reference: input.source_reference, created_at: input.created_at, expires_at: input.expires_at, released_at: "", release_reason: "" }; }
}

export class StorageMaintenance {
  constructor(private readonly database: SqliteDatabase, private readonly cas: ContentAddressedStore, private readonly blobs: BlobStore, private readonly rootDir: string, private readonly workspaceId: string, private readonly faults: FaultInjector = noFaults) {}

  async verify(): Promise<VerificationReport> {
    const failures: VerificationFailure[] = [];
    try { const row = await this.database.get<{ quick_check: string }>("PRAGMA quick_check"); if (row?.quick_check !== "ok") failures.push({ component_kind: "sqlite", component_id: this.database.filename, error_code: "quick_check_failed" }); } catch (error) { failures.push({ component_kind: "sqlite", component_id: this.database.filename, error_code: error instanceof Error ? error.name : "sqlite_error" }); }
    const casRows = await this.database.all<{ content_hash: string; component_kind: string; component_id: string }>(`SELECT content_hash, 'lexical' AS component_kind, artifact_id AS component_id FROM lexical_documents WHERE workspace_id = ? UNION ALL SELECT content_hash, 'vector_shard', shard_id FROM vector_shards WHERE workspace_id = ? UNION ALL SELECT content_hash, 'pinned_cas_object', content_hash FROM lifecycle_cas_pins WHERE workspace_id = ? UNION ALL SELECT content_hash, 'retention_root', root_id FROM lifecycle_roots WHERE workspace_id = ? UNION ALL SELECT content_digest, 'manifest_segment', query_execution_id || '/' || segment_id FROM query_manifest_segments WHERE query_execution_id IN (SELECT query_execution_id FROM query_executions WHERE workspace_id = ?) UNION ALL SELECT content_hash, 'content_blob', content_blob_id FROM content_blobs WHERE storage_reference LIKE 'cas:%'`, [this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId]);
    for (const row of casRows) {
      try { await this.cas.read(row.content_hash); } catch (error) { failures.push({ component_kind: row.component_kind, component_id: row.component_id, error_code: error instanceof StorageError ? error.code : "cas_error" }); }
    }
    const vectors = await this.database.all<{ projection_record_id: string; valid_from_generation: number }>("SELECT projection_record_id, valid_from_generation FROM vector_projection_rows WHERE workspace_id = ?", [this.workspaceId]);
    for (const vector of vectors) {
      try { await this.verifyVector(vector.projection_record_id, vector.valid_from_generation); } catch (error) { failures.push({ component_kind: "vector", component_id: vector.valid_from_generation === 0 ? vector.projection_record_id : `${vector.projection_record_id}@${vector.valid_from_generation}`, error_code: error instanceof StorageError ? error.code : "vector_error" }); }
    }
    const graphRows = await this.database.all<{ edge_id: string; source_subject_id: string; target_subject_id: string; relation_record_id: string; relation_kind: string; role: string; evidence_class: string; owner_artifact_id: string; owner_artifact_version_id: string; valid_from_generation: number; valid_to_generation: number | null; content_digest: string }>("SELECT edge_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, content_digest FROM graph_edges WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of graphRows) {
      try {
        const expected = { edge_id: row.edge_id, source_subject_id: row.source_subject_id, target_subject_id: row.target_subject_id, relation_record_id: row.relation_record_id, relation_kind: row.relation_kind, role: row.role, evidence_class: row.evidence_class, owner_artifact_id: row.owner_artifact_id, owner_artifact_version_id: row.owner_artifact_version_id, valid_from_generation: row.valid_from_generation, ...(row.valid_to_generation === null ? {} : { valid_to_generation: row.valid_to_generation }) };
        if (row.content_digest !== digestLogicalValue(expected, "urdira:graph-edge:v2")) throw new StorageError("storage:graph_corrupt", `Graph edge ${row.edge_id} typed columns differ from its logical digest.`);
        await this.requireOwner(row.owner_artifact_id, row.owner_artifact_version_id);
      } catch (error) { failures.push({ component_kind: "graph", component_id: `${row.edge_id}@${row.valid_from_generation}`, error_code: error instanceof StorageError ? error.code : "graph_corrupt" }); }
    }
    const lexicalRows = await this.database.all<{ artifact_id: string; artifact_version_id: string; content_hash: string; byte_length: number; valid_from_generation: number; valid_to_generation: number | null }>("SELECT artifact_id, artifact_version_id, content_hash, byte_length, valid_from_generation, valid_to_generation FROM lexical_documents WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of lexicalRows) {
      try {
        const source = await this.cas.read(row.content_hash);
        if (source.byteLength !== row.byte_length || digestBytes(source) !== row.content_hash) throw new StorageError("storage:lexical_corrupt", `Lexical document ${row.artifact_id} content differs from its CAS metadata.`);
        await this.requireOwner(row.artifact_id, row.artifact_version_id);
      } catch (error) { failures.push({ component_kind: "lexical", component_id: `${row.artifact_id}/${row.artifact_version_id}`, error_code: error instanceof StorageError ? error.code : "lexical_corrupt" }); }
    }
    const dependencyRows = await this.database.all<{ dependency_entry_id: string; record_id: string; owner_artifact_id: string; owner_artifact_version_id: string; dependency_artifact_id: string; dependency_artifact_version_id: string; dependency_role: string; producer_id: string; producer_version: string; valid_from_generation: number; valid_to_generation: number | null; content_digest: string }>("SELECT dependency_entry_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, content_digest FROM artifact_dependencies WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of dependencyRows) {
      try {
        const expected = { dependency_entry_id: row.dependency_entry_id, record_id: row.record_id, owner_artifact_id: row.owner_artifact_id, owner_artifact_version_id: row.owner_artifact_version_id, dependency_artifact_id: row.dependency_artifact_id, dependency_artifact_version_id: row.dependency_artifact_version_id, dependency_role: row.dependency_role, producer_id: row.producer_id, producer_version: row.producer_version, valid_from_generation: row.valid_from_generation, ...(row.valid_to_generation === null ? {} : { valid_to_generation: row.valid_to_generation }) };
        if (row.content_digest !== digestLogicalValue(expected, "urdira:artifact-dependency:v2")) throw new StorageError("storage:dependency_corrupt", `Dependency ${row.dependency_entry_id} typed columns differ from its logical digest.`);
        await this.requireOwner(row.owner_artifact_id, row.owner_artifact_version_id); await this.requireOwner(row.dependency_artifact_id, row.dependency_artifact_version_id);
      } catch (error) { failures.push({ component_kind: "dependency", component_id: `${row.dependency_entry_id}@${row.valid_from_generation}`, error_code: error instanceof StorageError ? error.code : "dependency_corrupt" }); }
    }
    const metricRows = await this.database.all<{ metric_id: string; projection_record_id: string; metric_kind: string; metric_value: number; valid_from_generation: number; valid_to_generation: number | null; content_digest: string; owner_artifact_id: string; owner_artifact_version_id: string }>("SELECT metric_id, projection_record_id, metric_kind, metric_value, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, content_digest FROM metric_projections WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of metricRows) {
      try {
        const expected = { metric_id: row.metric_id, projection_record_id: row.projection_record_id, metric_kind: row.metric_kind, metric_value: row.metric_value, owner_artifact_id: row.owner_artifact_id, owner_artifact_version_id: row.owner_artifact_version_id, valid_from_generation: row.valid_from_generation, ...(row.valid_to_generation === null ? {} : { valid_to_generation: row.valid_to_generation }) };
        if (row.content_digest !== digestLogicalValue(expected, "urdira:metric-projection:v2")) throw new StorageError("storage:metric_corrupt", `Metric ${row.metric_id} typed columns differ from its logical digest.`);
        await this.requireOwner(row.owner_artifact_id, row.owner_artifact_version_id);
      } catch (error) { failures.push({ component_kind: "metric", component_id: `${row.metric_id}@${row.valid_from_generation}`, error_code: error instanceof StorageError ? error.code : "metric_corrupt" }); }
    }
    const manifestRows = await this.database.all<{ query_execution_id: string; segment_id: string; entry_count: number; first_ordinal: number; last_ordinal: number; content_digest: string; storage_reference: string; byte_length: number }>("SELECT query_execution_id, segment_id, entry_count, first_ordinal, last_ordinal, content_digest, storage_reference, byte_length FROM query_manifest_segments WHERE query_execution_id IN (SELECT query_execution_id FROM query_executions WHERE workspace_id = ?)", [this.workspaceId]);
    for (const row of manifestRows) {
      try {
        const payload = await this.cas.read(row.content_digest);
        if (digestBytes(payload) !== row.content_digest || row.storage_reference !== `cas:${row.content_digest}` || row.byte_length !== payload.byteLength) throw new StorageError("storage:manifest_corrupt", `Manifest segment ${row.segment_id} failed its storage metadata check.`);
        const entries = decodeCanonical(payload, { max_bytes: 256 * 1024 * 1024, max_elements: 10_000_000 }) as unknown[];
        const ordinals = entries.map((entry, index) => entry && typeof entry === "object" && "ordinal" in entry && typeof entry.ordinal === "number" ? entry.ordinal : row.first_ordinal + index);
        if (entries.length !== row.entry_count || (entries.length > 0 && (Math.min(...ordinals) !== row.first_ordinal || Math.max(...ordinals) !== row.last_ordinal))) throw new StorageError("storage:manifest_corrupt", `Manifest segment ${row.segment_id} has inconsistent ordinal metadata.`);
      } catch (error) { failures.push({ component_kind: "manifest", component_id: `${row.query_execution_id}/${row.segment_id}`, error_code: error instanceof StorageError ? error.code : "manifest_corrupt" }); }
    }
    const snapshotRows = await this.database.all<{ snapshot_id: string; workspace_id: string; generation: number; parent_snapshot_id: string | null; generation_manifest_id: string; registry_snapshot_id: string; resolution_lock_id: string; configuration_revision_id: string; source_state_digest: string; source_snapshot_id: string | null; snapshot_contract_version: number | null; publication_stage_id: string | null; publication_stage_ordinal: number | null; publication_stage_count: number | null; source_observation_watermarks: string; canonical_record_set_digest: string; projection_set_digests: string; capability_state_digest: string; published_at: string; snapshot_digest: string }>("SELECT snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest FROM snapshots WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of snapshotRows) {
      try {
        const expected = { snapshot_id: String(row["snapshot_id"]), workspace_id: String(row["workspace_id"]), generation: Number(row["generation"]), ...(row["parent_snapshot_id"] === null ? {} : { parent_snapshot_id: String(row["parent_snapshot_id"]) }), generation_manifest_id: String(row["generation_manifest_id"]), registry_snapshot_id: String(row["registry_snapshot_id"]), resolution_lock_id: String(row["resolution_lock_id"]), configuration_revision_id: String(row["configuration_revision_id"]), source_state_digest: String(row["source_state_digest"]), ...(row["source_snapshot_id"] === null ? {} : { source_snapshot_id: String(row["source_snapshot_id"]), snapshot_contract_version: Number(row["snapshot_contract_version"] ?? 2) }), source_observation_watermarks: String(row["source_observation_watermarks"]), canonical_record_set_digest: String(row["canonical_record_set_digest"]), projection_set_digests: String(row["projection_set_digests"]), capability_state_digest: String(row["capability_state_digest"]), published_at: String(row["published_at"]), snapshot_digest: String(row["snapshot_digest"]) };
        if (!(await this.database.get("SELECT registry_snapshot_id FROM registry_snapshots WHERE workspace_id = ? AND registry_snapshot_id = ?", [this.workspaceId, row.registry_snapshot_id]))) throw new StorageError("storage:registry_missing", `Snapshot ${row.snapshot_id} references a registry from another workspace or an absent registry.`);
        const visibleRecords = await this.database.all<{ record_id: string; record_digest: string }>("SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ? AND valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?) ORDER BY record_id", [this.workspaceId, row.generation, row.generation]);
        const recordSetDigest = logicalRecordSetDigest(visibleRecords);
        const projectionEntries = await this.getProjectionSetDigestEntries(row.generation);
        if (isDigest(row.canonical_record_set_digest) && visibleRecords.every((record) => isDigest(record.record_digest)) && row.canonical_record_set_digest !== recordSetDigest) throw new StorageError("storage:canonical_set_digest_corrupt", `Snapshot ${row.snapshot_id} canonical record-set digest does not match visible records.`);
        if (isDigest(row.projection_set_digests)) throw new StorageError("storage:projection_set_digest_corrupt", `Snapshot ${row.snapshot_id} uses a non-normative aggregate projection-set digest.`);
        const declaredProjectionSet = String(row.projection_set_digests);
        if (declaredProjectionSet.startsWith("[")) {
          try {
            const declared = JSON.parse(declaredProjectionSet) as unknown;
            if (Array.isArray(declared) && !sameBytes(encodeCanonical(declared), encodeCanonical(projectionEntries))) throw new StorageError("storage:projection_set_digest_corrupt", `Snapshot ${row.snapshot_id} projection-set entries differ from authoritative projections.`);
          } catch (error) { if (error instanceof StorageError) throw error; throw new StorageError("storage:projection_set_digest_corrupt", `Snapshot ${row.snapshot_id} has malformed projection-set entries.`); }
        }
        if ([row.source_state_digest, row.source_observation_watermarks, row.canonical_record_set_digest, row.projection_set_digests, row.capability_state_digest].every(isDigest)) {
          const snapshotPositive = { ...expected } as Record<string, unknown>;
          delete snapshotPositive["snapshot_digest"];
          const snapshotDigest = computeDigest("core:snapshot", "core:snapshot_digest", 1, "core:SnapshotDigestPayload", 1, snapshotPositive);
          if (row["snapshot_digest"] !== snapshotDigest) throw new StorageError("storage:snapshot_digest_corrupt", `Snapshot ${row.snapshot_id} digest does not match its positive fields.`);
        }
      } catch (error) { failures.push({ component_kind: "snapshot", component_id: row.snapshot_id, error_code: error instanceof StorageError ? error.code : "snapshot_corrupt" }); }
    }
    const authoritativeArtifacts = await this.database.all<{ artifact_id: string; workspace_id: string; normalized_uri: string; normalized_path: string | null; display_path: string | null; artifact_kind: string }>("SELECT artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind FROM source_artifacts WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of authoritativeArtifacts) {
      try {
        const expected = { artifact_id: row.artifact_id, workspace_id: row.workspace_id, normalized_uri: row.normalized_uri, ...(row.normalized_path === null ? {} : { normalized_path: row.normalized_path }), ...(row.display_path === null ? {} : { display_path: row.display_path }), artifact_kind: row.artifact_kind };
        if (row.artifact_id !== expected.artifact_id || row.workspace_id !== expected.workspace_id) throw new StorageError("storage:source_catalog_corrupt", `Artifact ${row.artifact_id} metadata differs from its source catalog row.`);
      } catch (error) { failures.push({ component_kind: "source_catalog", component_id: row.artifact_id, error_code: error instanceof StorageError ? error.code : "source_catalog_corrupt" }); }
    }
    const foreignKeyFailures = await this.database.all<Record<string, unknown>>("PRAGMA foreign_key_check");
    if (foreignKeyFailures.length > 0) failures.push({ component_kind: "source_catalog", component_id: "foreign_keys", error_code: "storage:source_catalog_closure_corrupt" });
    const authoritativeBlobs = await this.database.all<{ content_blob_id: string; content_hash: string; byte_length: number; storage_reference: string }>("SELECT content_blob_id, content_hash, byte_length, storage_reference FROM content_blobs");
    for (const row of authoritativeBlobs) {
      try {
        if (row.storage_reference === `cas:${row.content_hash}`) { const source = await this.cas.read(row.content_hash); if (source.byteLength !== row.byte_length || digestBytes(source) !== row.content_hash) throw new StorageError("storage:source_blob_corrupt", `Content blob ${row.content_blob_id} failed its CAS digest or length check.`); }
      } catch (error) { failures.push({ component_kind: "source_catalog", component_id: row.content_blob_id, error_code: error instanceof StorageError ? error.code : "source_blob_corrupt" }); }
    }
    const registryRows = await this.database.all<{ registry_snapshot_id: string; workspace_id: string; registry_contract_version: string; core_registry_digest: string; resolution_lock_id: string; registry_digest: string }>("SELECT registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest FROM registry_snapshots WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of registryRows) {
      try {
        const bindings = await this.database.all<Record<string, unknown>>("SELECT namespace_binding_id, workspace_id, namespace, plugin_id, plugin_version, contribution_digest, emission_valid_from_generation, emission_valid_to_generation FROM registry_namespace_bindings WHERE workspace_id = ? AND registry_snapshot_id = ? ORDER BY namespace_binding_id", [this.workspaceId, row.registry_snapshot_id]);
        const positive = { registry_snapshot_id: row.registry_snapshot_id, registry_contract_version: row.registry_contract_version, core_registry_digest: row.core_registry_digest, resolution_lock_id: row.resolution_lock_id, namespace_bindings: bindings };
        const expectedRegistryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, positive);
        if (row.registry_digest !== expectedRegistryDigest) throw new StorageError("storage:registry_digest_corrupt", `Registry snapshot ${row.registry_snapshot_id} digest does not match its retained namespace closure.`);
      }
      catch (error) { failures.push({ component_kind: "registry", component_id: row.registry_snapshot_id, error_code: error instanceof StorageError ? error.code : "registry_corrupt" }); }
    }
    const controlRows = await this.database.all<{ state_key: string; workspace_id: string; state_kind: string; state_json: string; reference_workspace_id: string | null; reference_snapshot_id: string | null; reference_source_state_digest: string | null; updated_at: string }>("SELECT state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at FROM control_plane_state WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of controlRows) {
      try {
        const payload = JSON.parse(row.state_json) as Record<string, unknown>;
        if (row.workspace_id !== this.workspaceId || row.state_key.length === 0 || row.state_kind.length === 0 || Number.isNaN(Date.parse(row.updated_at)) || !payload || Array.isArray(payload) || payload["workspace_id"] !== row.workspace_id) throw new StorageError("storage:control_plane_corrupt", `Control state ${row.state_key} has invalid persisted metadata.`);
        if (row.reference_workspace_id !== null && payload["workspace_id"] !== row.reference_workspace_id) throw new StorageError("storage:control_plane_corrupt", `Control state ${row.state_key} has a mismatched workspace reference.`);
        if (row.reference_snapshot_id !== null) {
          if (payload["snapshot_id"] !== row.reference_snapshot_id) throw new StorageError("storage:control_plane_corrupt", `Control state ${row.state_key} has a mismatched snapshot reference.`);
          const snapshot = await this.database.get<{ workspace_id: string; source_state_digest: string }>("SELECT workspace_id, source_state_digest FROM snapshots WHERE snapshot_id = ?", [row.reference_snapshot_id]);
          if (!snapshot || snapshot.workspace_id !== this.workspaceId || (row.reference_source_state_digest !== null && snapshot.source_state_digest !== row.reference_source_state_digest)) throw new StorageError("storage:control_plane_corrupt", `Control state ${row.state_key} has an invalid snapshot/source closure.`);
        }
        if (row.reference_source_state_digest !== null && payload["source_state_digest"] !== row.reference_source_state_digest) throw new StorageError("storage:control_plane_corrupt", `Control state ${row.state_key} has a mismatched source-state reference.`);
        const hashes = new Set<string>(); collectContentHashes(payload, hashes); for (const hash of hashes) await this.cas.read(hash);
      }
      catch (error) { failures.push({ component_kind: "control_plane", component_id: row.state_key, error_code: error instanceof StorageError ? error.code : "control_plane_corrupt" }); }
    }
    const currentRows = await this.database.all<{ workspace_id: string; current_snapshot_id: string; current_generation: number; current_registry_snapshot_id: string }>("SELECT workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id FROM workspace_current_state WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of currentRows) {
      try { const snapshot = await this.database.get<{ snapshot_id: string; registry_snapshot_id: string }>("SELECT snapshot_id, registry_snapshot_id FROM snapshots WHERE workspace_id = ? AND snapshot_id = ? AND generation = ?", [this.workspaceId, row.current_snapshot_id, row.current_generation]); if (!snapshot || snapshot.registry_snapshot_id !== row.current_registry_snapshot_id) throw new StorageError("storage:current_tuple_corrupt", `Current tuple ${row.workspace_id} references a non-current snapshot or registry.`); }
      catch (error) { failures.push({ component_kind: "current_tuple", component_id: row.workspace_id, error_code: error instanceof StorageError ? error.code : "current_tuple_corrupt" }); }
    }
    const leaseRows = await this.database.all<{ retention_lease_id: string; snapshot_id: string; released_at: string | null; release_reason: string | null }>("SELECT retention_lease_id, snapshot_id, released_at, release_reason FROM retention_leases WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of leaseRows) {
      try { if (!(await this.database.get("SELECT snapshot_id FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, row.snapshot_id]))) throw new StorageError("storage:snapshot_not_found", `Lease ${row.retention_lease_id} references a missing snapshot.`); }
      catch (error) { failures.push({ component_kind: "lease", component_id: row.retention_lease_id, error_code: error instanceof StorageError ? error.code : "lease_audit_corrupt" }); }
    }
    const pinRows = await this.database.all<{ retention_pin_id: string; snapshot_id: string; released_at: string | null; release_reason: string | null }>("SELECT retention_pin_id, snapshot_id, released_at, release_reason FROM retention_pins WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of pinRows) {
      try { if (!(await this.database.get("SELECT snapshot_id FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, row.snapshot_id]))) throw new StorageError("storage:snapshot_not_found", `Pin ${row.retention_pin_id} references a missing snapshot.`); }
      catch (error) { failures.push({ component_kind: "pin", component_id: row.retention_pin_id, error_code: error instanceof StorageError ? error.code : "pin_audit_corrupt" }); }
    }
    const canonicalRows = await this.database.all<Record<string, unknown>>("SELECT * FROM record_occurrences WHERE workspace_id = ?", [this.workspaceId]);
    for (const row of canonicalRows) {
      try {
        const body = row["body_payload"] == null
          ? hydrateRelationalValue(await this.database.all<Record<string, unknown> & RelationalValueRow>("SELECT workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value FROM record_value_nodes WHERE workspace_id = ? AND record_id = ? AND valid_from_generation = ? ORDER BY value_path", [this.workspaceId, String(row["record_id"]), Number(row["valid_from_generation"])]))
          : decodeCanonical(bytes(row["body_payload"]));
        const logicalPayload = digestRelationalValue(body);
        if (logicalPayload.byte_length !== Number(row["body_byte_length"]) || logicalPayload.digest !== row["body_digest"]) throw new StorageError("storage:canonical_corrupt", `Canonical record ${row["record_id"]} differs from its typed value digest.`);
        await this.requireOwner(String(row["owner_artifact_id"]), String(row["owner_artifact_version_id"]));
      } catch (error) { failures.push({ component_kind: "canonical", component_id: String(row["record_id"]), error_code: error instanceof StorageError ? error.code : "canonical_corrupt" }); }
    }
    const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), read_only: true });
    try {
      const registration = await catalog.get<{ workspace_id: string; database_path: string; removed_at: string | null }>("SELECT workspace_id, database_path, removed_at FROM installation_workspaces WHERE workspace_id = ?", [this.workspaceId]);
      if (!registration || registration.removed_at !== null) failures.push({ component_kind: "control_plane", component_id: this.workspaceId, error_code: "storage:catalog_workspace_missing" });
      else {
        try { if (registration.workspace_id !== this.workspaceId || !(await pathExists(registration.database_path))) throw new StorageError("storage:catalog_workspace_corrupt", `Catalog registration ${this.workspaceId} does not close over an installed workspace database.`); }
        catch (error) { failures.push({ component_kind: "control_plane", component_id: this.workspaceId, error_code: error instanceof StorageError ? error.code : "storage:catalog_workspace_corrupt" }); }
      }
      const installations = await catalog.all<{ model_pack_installation_id: string; manifest_digest: string }>("SELECT model_pack_installation_id, manifest_digest FROM installation_model_pack_installations WHERE removed_at IS NULL");
      for (const installation of installations) {
        try { await this.cas.read(installation.manifest_digest); }
        catch (error) { failures.push({ component_kind: "source_catalog", component_id: installation.model_pack_installation_id, error_code: error instanceof StorageError ? error.code : "storage:catalog_installation_corrupt" }); }
      }
      const roots = await catalog.all<{ root_kind: string; root_id: string; content_hash: string }>("SELECT root_kind, root_id, content_hash FROM installation_gc_roots");
      for (const root of roots) {
        try { await this.cas.read(root.content_hash); }
        catch (error) { failures.push({ component_kind: "control_plane", component_id: `${root.root_kind}/${root.root_id}`, error_code: error instanceof StorageError ? error.code : "storage:catalog_root_corrupt" }); }
      }
    } catch (error) {
      failures.push({ component_kind: "control_plane", component_id: "catalog", error_code: error instanceof StorageError ? error.code : "storage:catalog_unavailable" });
    } finally { await catalog.close(); }
    return { ok: failures.length === 0, failures };
  }

  async repair(request: RepairRequest): Promise<RepairResult> {
    if (request.component_kind === "cas") {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", "Exact CAS repair requires a verified backup directory.");
      const payload = await readCasObjectFromBackup(request.backup_directory, request.component_id);
      if (digestBytes(payload) !== request.component_id) throw new StorageError("storage:repair_source_corrupt", `Backup object ${request.component_id} failed verification.`);
      await this.cas.put(payload, { content_hash: request.component_id });
      await this.cas.read(request.component_id);
      return { component_kind: "cas", component_id: request.component_id, action: "restore_exact_object", next_step: "verify" };
    }
    const projections = new WorkspaceProjectionRepository(this.database, this.blobs, this.workspaceId);
    if (request.component_kind === "graph") {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", "Graph repair requires a verified backup directory because the current projection row is untrusted.");
      await this.verifyBackupDirectory(request.backup_directory);
      const [edgeId, edgeGeneration] = request.component_id.split("@");
      const generation = edgeGeneration === undefined ? 0 : Number(edgeGeneration);
      const backupDb = await openSqliteDatabase({ filename: join(request.backup_directory, "workspace.sqlite"), read_only: true });
      const row = await backupDb.get<{ edge_id: string; source_subject_id: string; target_subject_id: string; relation_record_id: string; relation_kind: string; role: string; evidence_class: string; owner_artifact_id: string; owner_artifact_version_id: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT edge_id, source_subject_id, target_subject_id, relation_record_id, relation_kind, role, evidence_class, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation FROM graph_edges WHERE workspace_id = ? AND edge_id = ? AND valid_from_generation = ?", [this.workspaceId, edgeId ?? request.component_id, generation]);
      if (!row) throw new StorageError("storage:repair_component_missing", `Graph projection ${request.component_id} is missing.`);
      await this.database.run("DELETE FROM graph_edges WHERE workspace_id = ? AND edge_id = ? AND valid_from_generation = ?", [this.workspaceId, edgeId ?? request.component_id, generation]);
      const { valid_to_generation: graphEnd, ...graphValue } = row;
      await projections.putGraphEdge(graphEnd === null ? graphValue : { ...graphValue, valid_to_generation: graphEnd });
      await backupDb.close();
    } else if (request.component_kind === "lexical") {
      const [artifactId, artifactVersionId] = request.component_id.split("/");
      const row = await this.database.get<{ content_hash: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT content_hash, valid_from_generation, valid_to_generation FROM lexical_documents WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", [this.workspaceId, artifactId ?? "", artifactVersionId ?? ""]);
      if (!row) throw new StorageError("storage:repair_component_missing", `Lexical projection ${request.component_id} is missing.`);
      const text = new TextDecoder().decode(await this.cas.read(row.content_hash));
      await this.database.transaction([
        { kind: "run", sql: "DELETE FROM lexical_fts WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", params: [this.workspaceId, artifactId ?? request.component_id, artifactVersionId ?? ""] },
        { kind: "run", sql: "DELETE FROM lexical_documents WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", params: [this.workspaceId, artifactId ?? request.component_id, artifactVersionId ?? ""] },
      ]);
      const lexicalValue = { artifact_id: artifactId ?? "", artifact_version_id: artifactVersionId ?? "", text, valid_from_generation: row.valid_from_generation };
      await projections.putLexicalDocument(row.valid_to_generation === null ? lexicalValue : { ...lexicalValue, valid_to_generation: row.valid_to_generation });
    } else if (request.component_kind === "dependency") {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", "Dependency repair requires a verified backup directory because the current projection row is untrusted.");
      await this.verifyBackupDirectory(request.backup_directory);
      const [dependencyId, dependencyGeneration] = request.component_id.split("@");
      const generation = dependencyGeneration === undefined ? 0 : Number(dependencyGeneration);
      const backupDb = await openSqliteDatabase({ filename: join(request.backup_directory, "workspace.sqlite"), read_only: true });
      const row = await backupDb.get<{ dependency_entry_id: string; record_id: string; owner_artifact_id: string; owner_artifact_version_id: string; dependency_artifact_id: string; dependency_artifact_version_id: string; dependency_role: string; producer_id: string; producer_version: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT dependency_entry_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation FROM artifact_dependencies WHERE workspace_id = ? AND dependency_entry_id = ? AND valid_from_generation = ?", [this.workspaceId, dependencyId ?? request.component_id, generation]);
      if (!row) throw new StorageError("storage:repair_component_missing", `Dependency projection ${request.component_id} is missing.`);
      await this.database.run("DELETE FROM artifact_dependencies WHERE workspace_id = ? AND dependency_entry_id = ? AND valid_from_generation = ?", [this.workspaceId, dependencyId ?? request.component_id, generation]);
      const { valid_to_generation: dependencyEnd, ...dependencyValue } = row;
      await projections.putDependency(dependencyEnd === null ? dependencyValue : { ...dependencyValue, valid_to_generation: dependencyEnd });
      await backupDb.close();
    } else if (request.component_kind === "metric") {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", "Metric repair requires a verified backup directory because the current projection row is untrusted.");
      await this.verifyBackupDirectory(request.backup_directory);
      const [metricId, metricGeneration] = request.component_id.split("@");
      const generation = metricGeneration === undefined ? 0 : Number(metricGeneration);
      const backupDb = await openSqliteDatabase({ filename: join(request.backup_directory, "workspace.sqlite"), read_only: true });
      const row = await backupDb.get<{ metric_id: string; projection_record_id: string; metric_kind: string; metric_value: number; owner_artifact_id: string; owner_artifact_version_id: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT metric_id, projection_record_id, metric_kind, metric_value, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation FROM metric_projections WHERE workspace_id = ? AND metric_id = ? AND valid_from_generation = ?", [this.workspaceId, metricId ?? request.component_id, generation]);
      if (!row) throw new StorageError("storage:repair_component_missing", `Metric projection ${request.component_id} is missing.`);
      await this.database.run("DELETE FROM metric_projections WHERE workspace_id = ? AND metric_id = ? AND valid_from_generation = ?", [this.workspaceId, metricId ?? request.component_id, generation]);
      const { valid_to_generation: metricEnd, ...metricValue } = row;
      await projections.putMetric(metricEnd === null ? metricValue : { ...metricValue, valid_to_generation: metricEnd });
      await backupDb.close();
    } else if (request.component_kind === "vector") {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", "Vector repair requires a verified backup directory because the current projection row is untrusted.");
      await this.verifyBackupDirectory(request.backup_directory);
      const [projectionRecordId, generationText] = request.component_id.split("@");
      const generation = generationText === undefined ? 0 : Number(generationText);
      const backupDb = await openSqliteDatabase({ filename: join(request.backup_directory, "workspace.sqlite"), read_only: true });
      try {
        const row = await backupDb.get<{ projection_record_id: string; shard_id: string; shard_offset: number; byte_length: number; vector_digest: string; owner_artifact_id: string; owner_artifact_version_id: string; profile_id: string; executable_binding_id: string; dimensions: number; element_type: string; vector_encoding: string; normalization: string; distance_metric: string; valid_from_generation: number; valid_to_generation: number | null; document_grain: string | null; document_ref: string | null }>("SELECT projection_record_id, shard_id, shard_offset, byte_length, vector_digest, owner_artifact_id, owner_artifact_version_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, valid_from_generation, valid_to_generation, document_grain, document_ref FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", [this.workspaceId, projectionRecordId ?? request.component_id, generation]);
        if (!row) throw new StorageError("storage:repair_component_missing", `Vector projection ${request.component_id} is missing from the verified backup.`);
        const shard = await backupDb.get<{ shard_id: string; profile_id: string; executable_binding_id: string; dimensions: number; element_type: string; vector_encoding: string; normalization: string; distance_metric: string; byte_length: number; content_hash: string; storage_reference: string; created_at: string }>("SELECT shard_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, byte_length, content_hash, storage_reference, created_at FROM vector_shards WHERE workspace_id = ? AND shard_id = ?", [this.workspaceId, row.shard_id]);
        if (!shard) throw new StorageError("storage:repair_component_missing", `Vector shard ${row.shard_id} is missing from the verified backup.`);
        const shardBytes = await readCasObjectFromBackup(request.backup_directory, shard.content_hash);
        if (digestBytes(shardBytes) !== shard.content_hash) throw new StorageError("storage:repair_source_corrupt", `Backup vector shard ${shard.content_hash} failed verification.`);
        await unlink(this.cas.objectPath(shard.content_hash)).catch((error) => { if (!isMissing(error)) throw error; });
        await this.cas.put(shardBytes, { content_hash: shard.content_hash });
        await this.database.run("INSERT INTO vector_shards (shard_id, workspace_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, byte_length, content_hash, storage_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shard_id) DO UPDATE SET profile_id = excluded.profile_id, executable_binding_id = excluded.executable_binding_id, dimensions = excluded.dimensions, element_type = excluded.element_type, vector_encoding = excluded.vector_encoding, normalization = excluded.normalization, distance_metric = excluded.distance_metric, byte_length = excluded.byte_length, content_hash = excluded.content_hash, storage_reference = excluded.storage_reference, created_at = excluded.created_at", [shard.shard_id, this.workspaceId, shard.profile_id, shard.executable_binding_id, shard.dimensions, shard.element_type, shard.vector_encoding, shard.normalization, shard.distance_metric, shard.byte_length, shard.content_hash, shard.storage_reference, shard.created_at]);
        await this.database.run("DELETE FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ? AND valid_from_generation = ?", [this.workspaceId, projectionRecordId ?? request.component_id, generation]);
        await this.database.run("INSERT INTO vector_projection_rows (projection_record_id, workspace_id, shard_id, shard_offset, byte_length, vector_digest, owner_artifact_id, owner_artifact_version_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, valid_from_generation, valid_to_generation, document_grain, document_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [row.projection_record_id, this.workspaceId, row.shard_id, row.shard_offset, row.byte_length, row.vector_digest, row.owner_artifact_id, row.owner_artifact_version_id, row.profile_id, row.executable_binding_id, row.dimensions, row.element_type, row.vector_encoding, row.normalization, row.distance_metric, row.valid_from_generation, row.valid_to_generation, row.document_grain, row.document_ref]);
      } finally { await backupDb.close(); }
    } else if (["canonical", "source_catalog", "registry", "control_plane", "current_tuple", "lease", "pin"].includes(request.component_kind)) {
      if (!request.backup_directory) throw new StorageError("storage:repair_source_missing", `${request.component_kind} repair requires a verified backup directory.`);
      await this.verifyBackupDirectory(request.backup_directory);
      const replacement = join(this.rootDir, "repairs", `authoritative-${randomUUID()}.sqlite`);
      const recovery = `${this.database.filename}.authoritative-recovery-${randomUUID()}`;
      await mkdir(dirname(replacement), { recursive: true });
      await copyFile(join(request.backup_directory, "workspace.sqlite"), replacement);
      await syncFile(replacement);
      await this.database.transaction([{ kind: "replace_database", destination: replacement, recovery }]);
      const report = await this.verify();
      if (!report.ok) {
        const rollback = `${this.database.filename}.authoritative-rollback-${randomUUID()}`;
        await this.database.transaction([{ kind: "replace_database", destination: recovery, recovery: rollback }]);
        await removeTree(rollback);
        throw new StorageError("storage:repair_verify_failed", `Authoritative-state repair verification found ${report.failures.length} corrupt component(s).`);
      }
      await removeTree(recovery);
      return { component_kind: request.component_kind, component_id: request.component_id, action: "restore_authoritative_state", next_step: "verify" };
    } else if (request.component_kind === "snapshot") {
      if (request.backup_directory) {
        await this.verifyBackupDirectory(request.backup_directory);
        const backupDatabase = await openSqliteDatabase({ filename: join(request.backup_directory, "workspace.sqlite"), read_only: true });
        try {
          const snapshot = await backupDatabase.get<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshots WHERE workspace_id = ? AND snapshot_id = ?", [this.workspaceId, request.component_id]);
          if (!snapshot) throw new StorageError("storage:repair_component_missing", `Snapshot ${request.component_id} is missing from the verified backup.`);
        } finally { await backupDatabase.close(); }
        const replacement = join(this.rootDir, "repairs", `snapshot-${randomUUID()}.sqlite`);
        const recovery = `${this.database.filename}.snapshot-recovery-${randomUUID()}`;
        await mkdir(dirname(replacement), { recursive: true });
        await copyFile(join(request.backup_directory, "workspace.sqlite"), replacement);
        await syncFile(replacement);
        await this.database.transaction([{ kind: "replace_database", destination: replacement, recovery }]);
        const report = await this.verify();
        if (!report.ok) {
          const rollback = `${this.database.filename}.snapshot-rollback-${randomUUID()}`;
          await this.database.transaction([{ kind: "replace_database", destination: recovery, recovery: rollback }]);
          await removeTree(rollback);
          throw new StorageError("storage:repair_verify_failed", `Snapshot repair verification found ${report.failures.length} corrupt component(s): ${report.failures.map((failure) => `${failure.component_kind}/${failure.component_id}/${failure.error_code}`).join(", ")}.`);
        }
        await removeTree(recovery);
      } else if (request.snapshot_rebuild) {
        await request.snapshot_rebuild.rebuild({ workspace_id: this.workspaceId, component_id: request.component_id, database: this.database, cas: this.cas, blobs: this.blobs });
        const report = await this.verify();
        if (!report.ok) throw new StorageError("storage:repair_verify_failed", `Snapshot rebuild verification found ${report.failures.length} corrupt component(s).`);
      } else {
        throw new StorageError("storage:repair_source_missing", "Snapshot repair requires a verified retained snapshot or a generic rebuild port.");
      }
      return { component_kind: request.component_kind, component_id: request.component_id, action: "rebuild_queryable_snapshot", next_step: "verify" };
    } else if (request.component_kind === "live_provider") {
      if (!request.acknowledge_historical_loss) throw new StorageError("storage:repair_ack_required", "Live-provider reindex requires explicit acknowledgement that historical equivalence cannot be restored.");
      if (!request.live_provider) throw new StorageError("storage:repair_source_missing", "Live-provider repair requires a generic reindex port.");
      await request.live_provider.reindex({ workspace_id: this.workspaceId, component_id: request.component_id, database: this.database, cas: this.cas, blobs: this.blobs });
      const report = await this.verify();
      if (!report.ok) throw new StorageError("storage:repair_verify_failed", `Live-provider reindex verification found ${report.failures.length} corrupt component(s).`);
      return { component_kind: request.component_kind, component_id: request.component_id, action: "reindex_live_provider", next_step: "verify" };
    } else {
      const [executionId, segmentId] = request.component_id.split("/");
      if (!executionId || !segmentId || !request.rebuild_entries) throw new StorageError("storage:repair_rebuild_input_missing", `Manifest repair ${request.component_id} requires canonical entries.`);
      await this.database.run("DELETE FROM query_manifest_segments WHERE query_execution_id = ? AND segment_id = ?", [executionId, segmentId]);
      const lifecycle = new WorkspaceLifecycleRepository(this.database, this.workspaceId, noFaults, this.blobs, this.rootDir);
      await lifecycle.appendManifestSegment(executionId, segmentId, request.rebuild_entries);
      return { component_kind: request.component_kind, component_id: request.component_id, action: "rebuild_manifest_segment", next_step: "verify" };
    }
    return { component_kind: request.component_kind, component_id: request.component_id, action: "rebuild_derived_projection", next_step: "verify" };
  }

  async createBackup(destination: string): Promise<void> {
    if (await this.hasActiveGcBarrier()) throw new StorageError("storage:gc_reader_barrier", "An active garbage-collection barrier prevents a consistent backup.");
    const backupId = `backup:${randomUUID()}`;
    const staging = `${resolve(destination)}.tmp-${randomUUID()}`;
    await mkdir(staging, { recursive: true });
    await this.database.run("INSERT INTO backup_barriers (backup_id, workspace_id, state, started_at, completed_at) VALUES (?, ?, 'active', ?, NULL)", [backupId, this.workspaceId, new Date().toISOString()]);
    try {
      const beforeHashes = await this.reachableHashes();
      await this.faults.hit("backup.before_snapshot");
      await this.database.transaction([{ kind: "backup", destination: join(staging, "workspace.sqlite") }]);
      await this.normalizeBackupBarriers(join(staging, "workspace.sqlite"));
      const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), busy_timeout_ms: 5_000 });
      try { await catalog.transaction([{ kind: "backup", destination: join(staging, "catalog.sqlite") }]); }
      finally { await catalog.close(); }
      await this.faults.hit("backup.after_snapshot");
      const hashes = new Set([...beforeHashes, ...await this.reachableHashes()]);
      const databaseBytes = new Uint8Array(await readFile(join(staging, "workspace.sqlite")));
      const catalogBytes = new Uint8Array(await readFile(join(staging, "catalog.sqlite")));
      const executionIds = await this.database.all<{ query_execution_id: string }>("SELECT query_execution_id FROM query_executions WHERE workspace_id = ? ORDER BY query_execution_id", [this.workspaceId]);
      const manifest: { workspace_id: string; database_file: string; database_digest: string; catalog_file: string; catalog_digest: string; content_hashes: string[]; execution_ids: string[] } = { workspace_id: this.workspaceId, database_file: "workspace.sqlite", database_digest: digestBytes(databaseBytes), catalog_file: "catalog.sqlite", catalog_digest: digestBytes(catalogBytes), content_hashes: [...hashes].sort(), execution_ids: executionIds.map((row) => row.query_execution_id) };
      await mkdir(join(staging, "cas"), { recursive: true });
      await writeCasLayoutMarker(join(staging, "cas"));
      for (const contentHash of manifest.content_hashes) {
        const source = this.cas.objectPath(contentHash);
        const target = join(staging, "cas", ...casObjectRelativeParts(contentHash));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        await syncFile(target);
      }
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await syncFile(join(staging, "manifest.json"));
      await this.verifyBackupDirectory(staging);
      await syncNamespace(staging, join(staging, "manifest.json"));
      await this.faults.hit("backup.before_publish");
      try { await statPath(destination); throw new StorageError("storage:backup_target_exists", `Backup destination ${destination} already exists.`); } catch (error) { if (!isMissing(error)) throw error; }
      await rename(staging, destination);
      await syncNamespace(dirname(resolve(destination)), join(resolve(destination), "manifest.json"));
      await this.faults.hit("backup.after_publish");
      await this.database.run("UPDATE backup_barriers SET state = 'completed', completed_at = ? WHERE backup_id = ?", [new Date().toISOString(), backupId]);
    } catch (error) {
      await this.database.run("UPDATE backup_barriers SET state = 'failed', completed_at = ? WHERE backup_id = ?", [new Date().toISOString(), backupId]).catch(() => undefined);
      await removeTree(staging);
      throw error;
    }
  }

  async restoreBackup(source: string, destination: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as { workspace_id: string; database_file: string; database_digest?: string; catalog_file?: string; catalog_digest?: string; content_hashes: string[] };
    if (manifest.workspace_id !== this.workspaceId) throw new StorageError("storage:backup_workspace_mismatch", "Backup workspace identity does not match the restore target.");
    const staging = `${resolve(destination)}.tmp-${randomUUID()}`;
    try {
      await this.verifyBackupDirectory(source);
      await mkdir(join(staging, "cas"), { recursive: true });
      await writeCasLayoutMarker(join(staging, "cas"));
      await copyFile(join(source, manifest.database_file), join(staging, "workspace.sqlite"));
      await syncFile(join(staging, "workspace.sqlite"));
      if (manifest.catalog_file) { await copyFile(join(source, manifest.catalog_file), join(staging, "catalog.sqlite")); await syncFile(join(staging, "catalog.sqlite")); }
      for (const contentHash of manifest.content_hashes) {
        const target = join(staging, "cas", ...casObjectRelativeParts(contentHash));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(await resolveCasObjectPathInBackup(source, contentHash), target);
        await syncFile(target);
      }
      await copyFile(join(source, "manifest.json"), join(staging, "manifest.json"));
      if (manifest.catalog_file) {
        const restoredDatabasePath = join(resolve(destination), "workspace.sqlite");
        await this.rebaseRestoredCatalog(join(staging, manifest.catalog_file), restoredDatabasePath, resolve(destination));
        const restoredCatalogBytes = new Uint8Array(await readFile(join(staging, manifest.catalog_file)));
        const restoredManifest = { ...manifest, catalog_digest: digestBytes(restoredCatalogBytes) };
        await writeFile(join(staging, "manifest.json"), JSON.stringify(restoredManifest, null, 2), "utf8");
        await syncFile(join(staging, "manifest.json"));
      }
      await this.verifyBackupDirectory(staging, join(resolve(destination), "workspace.sqlite"));
      try { await statPath(destination); throw new StorageError("storage:restore_target_exists", `Restore destination ${destination} already exists.`); } catch (error) { if (!isMissing(error)) throw error; }
      await syncNamespace(staging, join(staging, "manifest.json"));
      await rename(staging, destination);
      await syncNamespace(dirname(resolve(destination)), join(resolve(destination), "manifest.json"));
      await this.verifyBackupDirectory(resolve(destination), join(resolve(destination), "workspace.sqlite"));
    } catch (error) {
      await removeTree(staging);
      throw error;
    }
  }

  private async rebaseRestoredCatalog(catalogPath: string, restoredDatabasePath: string, restoredRoot: string): Promise<void> {
    const catalog = await openSqliteDatabase({ filename: catalogPath });
    try {
      const registration = await catalog.get<{ workspace_id: string }>("SELECT workspace_id FROM installation_workspaces WHERE workspace_id = ?", [this.workspaceId]);
      if (!registration) throw new StorageError("storage:backup_corrupt", "Restored catalog has no target workspace registration.");
      await catalog.run("UPDATE installation_workspaces SET canonical_root = ?, display_root = ?, database_path = ? WHERE workspace_id = ?", [restoredRoot, restoredRoot, restoredDatabasePath, this.workspaceId]);
    } finally { await catalog.close(); }
  }

  private async verifyBackupDirectory(directory: string, expectedDatabasePath?: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { workspace_id: string; database_file: string; database_digest?: string; catalog_file?: string; catalog_digest?: string; content_hashes: string[] };
    if (manifest.workspace_id !== this.workspaceId) throw new StorageError("storage:backup_workspace_mismatch", "Backup workspace identity does not match the verifier.");
    const databasePath = join(directory, manifest.database_file);
    const databaseBytes = new Uint8Array(await readFile(databasePath));
    if (manifest.database_digest && digestBytes(databaseBytes) !== manifest.database_digest) throw new StorageError("storage:backup_corrupt", "Backup database digest verification failed.");
    const database = await openSqliteDatabase({ filename: databasePath, read_only: true });
    try {
      const quickCheck = await database.get<{ quick_check: string }>("PRAGMA quick_check");
      if (quickCheck?.quick_check !== "ok") throw new StorageError("storage:backup_corrupt", "Backup database quick check failed.");
    } finally { await database.close(); }
    if (manifest.catalog_file) {
      const catalogPath = join(directory, manifest.catalog_file);
      const catalogBytes = new Uint8Array(await readFile(catalogPath));
      if (manifest.catalog_digest && digestBytes(catalogBytes) !== manifest.catalog_digest) throw new StorageError("storage:backup_corrupt", "Backup catalog digest verification failed.");
      const catalog = await openSqliteDatabase({ filename: catalogPath, read_only: true });
      try {
        const quickCheck = await catalog.get<{ quick_check: string }>("PRAGMA quick_check");
        if (quickCheck?.quick_check !== "ok") throw new StorageError("storage:backup_corrupt", "Backup catalog quick check failed.");
        const registration = await catalog.get<{ workspace_id: string; database_path: string }>("SELECT workspace_id, database_path FROM installation_workspaces WHERE workspace_id = ?", [this.workspaceId]);
        if (!registration) throw new StorageError("storage:backup_corrupt", "Backup catalog does not retain the workspace registration.");
        if (expectedDatabasePath && resolve(registration.database_path) !== resolve(expectedDatabasePath)) throw new StorageError("storage:backup_corrupt", "Backup catalog workspace path was not rebased to the restored database.");
        if (expectedDatabasePath && resolve(directory) === dirname(resolve(expectedDatabasePath)) && !(await pathExists(registration.database_path))) throw new StorageError("storage:backup_corrupt", "Restored catalog workspace database path is not usable.");
      } finally { await catalog.close(); }
    }
    for (const contentHash of manifest.content_hashes) {
      const content = await readCasObjectFromBackup(directory, contentHash);
      if (digestBytes(content) !== contentHash) throw new StorageError("storage:backup_corrupt", `Backup CAS object ${contentHash} failed verification.`);
    }
  }

  private async normalizeBackupBarriers(databasePath: string): Promise<void> {
    const database = await openSqliteDatabase({ filename: databasePath });
    try { await database.run("DELETE FROM backup_barriers WHERE state = 'active'"); }
    finally { await database.close(); }
  }

  async migrate(targetVersion: number): Promise<void> {
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new StorageError("storage:migration_invalid", "Storage format versions must be positive safe integers.");
    const meta = await this.database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'storage_format_version'");
    let currentVersion = 1;
    if (meta) {
      try {
        const decoded = decodeCanonical(bytes(meta.value));
        if (typeof decoded !== "number" || !Number.isSafeInteger(decoded) || decoded < 1) throw new Error("unsupported storage format");
        currentVersion = decoded;
      } catch (error) {
        if (error instanceof StorageError && error.code === "storage:migration_format_invalid") throw error;
        throw new StorageError("storage:migration_format_invalid", "The persisted storage format metadata is not a supported version.", { cause: error instanceof Error ? error.message : String(error) });
      }
    }
    if (targetVersion <= currentVersion) return;
    await this.faults.hit("migration.before_backup");
    const running = await this.database.all<{ migration_id: string; to_version: number }>("SELECT migration_id, to_version FROM storage_migrations WHERE workspace_id = ? AND state = 'running' AND to_version = ? ORDER BY started_at", [this.workspaceId, targetVersion]);
    for (const attempt of running) await this.database.run("UPDATE storage_migrations SET state = 'aborted', completed_at = ? WHERE migration_id = ? AND state = 'running'", [new Date().toISOString(), attempt.migration_id]);
    const migrationId = `migration:${currentVersion}:${targetVersion}:${randomUUID()}`;
    const migrationEntryName = storageFilesystemEntryName("migration", migrationId);
    const backupPath = join(this.rootDir, "backups", migrationEntryName);
    await this.createBackup(backupPath);
    const migrationStartedAt = new Date().toISOString();
    const shadowPath = join(this.rootDir, "migrations", `${migrationEntryName}.sqlite`);
    const recoveryPath = `${this.database.filename}.migration-recovery-${randomUUID()}`;
    const initialStateJson = JSON.stringify({ migration_id: migrationId, from_version: currentVersion, to_version: targetVersion, backup_path: backupPath, shadow_database_path: shadowPath, recovery_path: recoveryPath });
    await this.database.run("INSERT INTO storage_migrations (migration_id, workspace_id, from_version, to_version, state, backup_path, started_at, completed_at, migration_state_json, shadow_database_path, shadow_database_digest) VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, ?, ?, NULL)", [migrationId, this.workspaceId, currentVersion, targetVersion, backupPath, migrationStartedAt, initialStateJson, shadowPath]);
    await mkdir(dirname(shadowPath), { recursive: true });
    const logicalColumns = await this.createTypedShadowDatabase(shadowPath);
    const sourceEquivalenceDigest = await this.databaseEquivalenceDigest(this.database, logicalColumns, true);
    const shadowEquivalenceDigest = await this.verifyShadowDatabase(shadowPath, sourceEquivalenceDigest, logicalColumns);
    const stateJson = JSON.stringify({ migration_id: migrationId, from_version: currentVersion, to_version: targetVersion, backup_path: backupPath, shadow_database_path: shadowPath, shadow_database_digest: shadowEquivalenceDigest, recovery_path: recoveryPath });
    await this.faults.hit("migration.after_shadow_copy");
    await this.faults.hit("migration.before_swap");
    await this.database.transaction([{ kind: "replace_database", destination: shadowPath, recovery: recoveryPath }]);
    await this.database.run("UPDATE storage_migrations SET shadow_database_digest = ?, migration_state_json = ? WHERE migration_id = ? AND state = 'running'", [shadowEquivalenceDigest, stateJson, migrationId]);
    await this.verifyReadOnlyDatabase(this.database.filename);
    await this.faults.hit("migration.before_publish");
    await this.database.transaction([
      { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES ('storage_format_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [encodeCanonical(targetVersion)] },
      { kind: "run", sql: "UPDATE storage_migrations SET state = 'completed', completed_at = ? WHERE migration_id = ? AND state = 'running'", params: [new Date().toISOString(), migrationId] },
    ]);
    await this.faults.hit("migration.after_swap");
  }

  async reconcileMigration(migrationId: string): Promise<"completed" | "aborted" | "unchanged"> {
    const row = await this.database.get<{ to_version: number; state: string; shadow_database_path: string | null; shadow_database_digest: string | null; migration_state_json: string }>("SELECT to_version, state, shadow_database_path, shadow_database_digest, migration_state_json FROM storage_migrations WHERE workspace_id = ? AND migration_id = ?", [this.workspaceId, migrationId]);
    if (!row || row.state !== "running") return "unchanged";
    const payload = JSON.parse(row.migration_state_json) as { recovery_path?: string };
    const shadowPath = row.shadow_database_path;
    const recoveryPath = payload.recovery_path;
    const shadowExists = shadowPath ? await pathExists(shadowPath) : false;
    const recoveryExists = recoveryPath ? await pathExists(recoveryPath) : false;
    // A process can die immediately after the atomic database swap and before
    // the shadow digest update reaches SQLite. In that window the destination
    // is already the verified shadow database, the shadow path is gone, and
    // the recovery copy is still present. Treat the durable swap boundary as
    // authoritative: startup schema checks have already opened the swapped
    // database successfully, so finish publication instead of incorrectly
    // aborting a migration whose final receipt was not flushed.
    if (!shadowExists && recoveryExists && !row.shadow_database_digest) {
      await this.verifyReadOnlyDatabase(this.database.filename);
      await this.database.transaction([
        { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES ('storage_format_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [encodeCanonical(row.to_version)] },
        { kind: "run", sql: "UPDATE storage_migrations SET state = 'completed', completed_at = COALESCE(completed_at, ?) WHERE workspace_id = ? AND migration_id = ? AND state = 'running'", params: [new Date().toISOString(), this.workspaceId, migrationId] },
      ]);
      await removeTree(recoveryPath!);
      return "completed";
    }
    if (!shadowExists && row.shadow_database_digest) {
      const quickCheck = await this.database.get<{ quick_check: string }>("PRAGMA quick_check");
      const currentDigest = quickCheck?.quick_check === "ok" ? await this.databaseEquivalenceDigest(this.database) : "";
      if (currentDigest === row.shadow_database_digest) {
        await this.verifyReadOnlyDatabase(this.database.filename);
        await this.database.transaction([
          { kind: "run", sql: "INSERT INTO workspace_meta (key, value) VALUES ('storage_format_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [encodeCanonical(row.to_version)] },
          { kind: "run", sql: "UPDATE storage_migrations SET state = 'completed', completed_at = COALESCE(completed_at, ?) WHERE workspace_id = ? AND migration_id = ? AND state = 'running'", params: [new Date().toISOString(), this.workspaceId, migrationId] },
        ]);
        if (recoveryExists && recoveryPath) await removeTree(recoveryPath);
        return "completed";
      }
      if (recoveryExists && recoveryPath) {
        const rollbackPath = `${this.database.filename}.migration-recovery-rollback-${randomUUID()}`;
        await this.database.transaction([{ kind: "replace_database", destination: recoveryPath, recovery: rollbackPath }]);
        await removeTree(rollbackPath);
      }
    }
    if (shadowExists && shadowPath) await removeTree(shadowPath);
    if (recoveryExists && recoveryPath) await removeTree(recoveryPath);
    await this.database.run("UPDATE storage_migrations SET state = 'aborted', completed_at = COALESCE(completed_at, ?), migration_state_json = ? WHERE workspace_id = ? AND migration_id = ? AND state = 'running'", [new Date().toISOString(), JSON.stringify({ ...payload, recovery_action: "rollback" }), this.workspaceId, migrationId]);
    return "aborted";
  }

  private canonicalizeMigrationProjectionRow(row: MigrationLogicalRow): MigrationLogicalRow {
    const payload = Object.values(row.payloads)[0];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return row;
    const columns = { ...row.columns } as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) if (key in columns) columns[key] = value;
    return { ...row, columns };
  }

  private async databaseEquivalenceDigest(database: SqliteDatabase, logicalColumns?: Readonly<Record<string, readonly string[]>>, canonicalizeProjections = false): Promise<string> {
    const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'lexical_fts%' ORDER BY name");
    const exportRows: unknown[] = [];
    for (const table of tables) {
      if (table.name === "storage_migrations") continue;
      const adapter = MIGRATION_TABLE_ADAPTERS[table.name];
      if (!adapter) throw new StorageError("storage:migration_adapter_missing", `No lossless migration adapter is registered for table ${table.name}.`);
      const quoted = `"${table.name.replaceAll('"', '""')}"`;
      const rows = await database.all<Record<string, unknown>>(`SELECT * FROM ${quoted}`);
      const encodedRows = rows.map((row) => {
        const logical = adapter.decodeRow(table.name, row, logicalColumns?.[table.name]);
        adapter.validate(table.name, logical);
        return encodeCanonical(canonicalizeProjections ? this.canonicalizeMigrationProjectionRow(logical) : logical);
      }).sort((left, right) => digestBytes(left).localeCompare(digestBytes(right)));
      exportRows.push({ name: table.name, rows: encodedRows });
    }
    return digestBytes(encodeCanonical(exportRows));
  }

  private async createTypedShadowDatabase(shadowPath: string): Promise<Readonly<Record<string, readonly string[]>>> {
    await removeTree(shadowPath);
    await mkdir(dirname(shadowPath), { recursive: true });
    await this.validateMigrationAdapters(this.database);
    const shadow = await openSqliteDatabase({ filename: shadowPath });
    try {
      await shadow.exec(WORKSPACE_V3_SCHEMA);
      await shadow.exec("PRAGMA foreign_keys = OFF");
      const tables = await this.database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'lexical_fts%' ORDER BY name");
      const logicalColumns: Record<string, readonly string[]> = {};
      for (const table of tables) {
        const adapter = MIGRATION_TABLE_ADAPTERS[table.name];
        if (!adapter) throw new StorageError("storage:migration_adapter_missing", `No lossless migration adapter is registered for table ${table.name}.`);
        const sourceColumns = await this.database.all<{ name: string }>(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`);
        const targetColumns = await shadow.all<{ name: string }>(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`);
        const sourceNames = new Set(sourceColumns.map(({ name }) => name));
        const columns = targetColumns.map(({ name }) => name);
        if (columns.some((name) => !sourceNames.has(name))) throw new StorageError("storage:migration_schema_unknown", `The typed adapter for ${table.name} cannot decode a missing logical column.`);
        logicalColumns[table.name] = columns;
        const quoted = `"${table.name.replaceAll('"', '""')}"`;
        const placeholders = columns.map(() => "?").join(", ");
        const rows = await this.database.all<Record<string, unknown>>(`SELECT * FROM ${quoted}`);
        for (const row of rows) {
          const decoded = adapter.decodeRow(table.name, row, columns);
          adapter.validate(table.name, decoded);
          const encoded = adapter.encodeRow(table.name, decoded);
          const values = columns.map((column) => sqliteValue(encoded[column]));
          await shadow.run(`INSERT INTO ${quoted} (${columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ")}) VALUES (${placeholders})`, values);
        }
      }
      // FTS5 is a derived virtual table and therefore intentionally excluded
      // from the typed relational equivalence scan. Preserve its current
      // candidate rows during a destructive v3 shadow swap; lexical_documents
      // remains the authoritative CAS-backed projection and the reconciler can
      // rebuild FTS5 later if its completion marker is stale.
      const lexicalRows = await this.database.all<{ workspace_id: string; artifact_id: string; artifact_version_id: string; content: string }>("SELECT workspace_id, artifact_id, artifact_version_id, content FROM lexical_fts");
      for (const row of lexicalRows) await shadow.run("INSERT INTO lexical_fts (workspace_id, artifact_id, artifact_version_id, content) VALUES (?, ?, ?, ?)", [row.workspace_id, row.artifact_id, row.artifact_version_id, row.content]);
      await shadow.exec("PRAGMA foreign_keys = ON");
      const foreignKeyFailures = await shadow.all<Record<string, unknown>>("PRAGMA foreign_key_check");
      if (foreignKeyFailures.length > 0) throw new StorageError("storage:migration_foreign_key_failed", "The typed shadow database contains invalid foreign-key references.");
      return logicalColumns;
    } finally {
      await shadow.close();
    }
  }

  private async verifyShadowDatabase(shadowPath: string, expectedDigest: string, logicalColumns: Readonly<Record<string, readonly string[]>>): Promise<string> {
    const shadow = await openSqliteDatabase({ filename: shadowPath, read_only: true });
    try {
      const quickCheck = await shadow.get<{ quick_check: string }>("PRAGMA quick_check");
      if (quickCheck?.quick_check !== "ok") throw new StorageError("storage:migration_shadow_corrupt", "Migration shadow database failed SQLite verification.");
      await this.validateMigrationAdapters(shadow, logicalColumns);
      const actualDigest = await this.databaseEquivalenceDigest(shadow, logicalColumns, true);
      if (actualDigest !== expectedDigest) throw new StorageError("storage:migration_shadow_mismatch", "Migration shadow database is not logically equivalent to the source.");
      const roots = await this.reachableHashesForDatabase(shadow, this.workspaceId);
      for (const hash of roots) await this.cas.read(hash);
      const report = await new StorageMaintenance(shadow, this.cas, this.blobs, this.rootDir, this.workspaceId).verify();
      if (!report.ok) throw new StorageError("storage:migration_shadow_verify_failed", `Migration shadow verification found ${report.failures.length} corrupt component(s).`);
      return actualDigest;
    } finally { await shadow.close(); }
  }

  private async validateMigrationAdapters(database: SqliteDatabase, logicalColumns?: Readonly<Record<string, readonly string[]>>): Promise<void> {
    const tables = await database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'lexical_fts%' ORDER BY name");
    for (const table of tables) {
      if (!(table.name in MIGRATION_TABLE_ADAPTERS)) throw new StorageError("storage:migration_adapter_missing", `No lossless migration adapter is registered for table ${table.name}.`);
      const adapter = MIGRATION_TABLE_ADAPTERS[table.name];
      if (!adapter || adapter.adapter_version !== 1 || adapter.decoder_version !== 1 || typeof adapter.validate !== "function" || adapter.validation_name.length === 0) throw new StorageError("storage:migration_adapter_invalid", `The migration adapter for ${table.name} is not versioned and typed.`);
      const quoted = `"${table.name.replaceAll('"', '""')}"`;
      const rows = await database.all<Record<string, unknown>>(`SELECT * FROM ${quoted}`);
      for (const row of rows) {
        try {
          const decoded = adapter.decodeRow(table.name, row, logicalColumns?.[table.name]);
          adapter.validate(table.name, decoded);
          const encoded = adapter.encodeRow(table.name, decoded);
          const roundTrip = adapter.decodeRow(table.name, encoded, logicalColumns?.[table.name]);
          adapter.validate(table.name, roundTrip);
          if (!sameBytes(encodeCanonical(decoded), encodeCanonical(roundTrip))) throw new Error("typed logical row changed during round trip");
        } catch (error) {
          const detail = error && typeof error === "object" && "details" in error ? JSON.stringify((error as { readonly details?: unknown }).details) : undefined;
          throw new StorageError("storage:migration_decoder_failed", `Typed migration decoder failed for ${table.name}.`, { cause: error instanceof Error ? error.message : String(error), ...(detail === undefined ? {} : { detail }) });
        }
      }
    }
  }

  private async verifyReadOnlyDatabase(filename: string): Promise<void> {
    const readOnly = await openSqliteDatabase({ filename, read_only: true });
    try {
      const quickCheck = await readOnly.get<{ quick_check: string }>("PRAGMA quick_check");
      if (quickCheck?.quick_check !== "ok") throw new StorageError("storage:migration_readonly_verify_failed", "Read-only post-swap SQLite verification failed.");
      const report = await new StorageMaintenance(readOnly, this.cas, this.blobs, this.rootDir, this.workspaceId).verify();
      if (!report.ok) throw new StorageError("storage:migration_readonly_verify_failed", `Read-only post-swap verification found ${report.failures.length} corrupt component(s).`);
    } finally { await readOnly.close(); }
  }

  async compact(): Promise<{ readonly checkpointed: boolean }> {
    await this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    await this.database.exec("PRAGMA incremental_vacuum(1000)");
    return { checkpointed: true };
  }

  repairOrder(): typeof REPAIR_ORDER { return REPAIR_ORDER; }

  async collect(options: CollectionOptions): Promise<CollectionResult> {
    const epochId = options.epoch_id ?? nowId(options.now);
    try {
      return await this.collectAttempt({ ...options, epoch_id: epochId });
    } catch (error) {
      await this.markEpochFailed(epochId, options.now, error).catch(() => undefined);
      await this.setGlobalBarrier(epochId, "completed", options.now).catch(() => undefined);
      throw error;
    }
  }

  private async collectAttempt(options: CollectionOptions & { readonly epoch_id: string }): Promise<CollectionResult> {
    if (!Number.isSafeInteger(options.batch_size) || options.batch_size <= 0) throw new StorageError("storage:collection_invalid", "Collection batch size must be a positive safe integer.");
    const epochId = options.epoch_id;
    if (await this.hasActiveBackupBarrier()) throw new StorageError("storage:backup_active", "A verified backup barrier is active; collection must wait.");
    let epoch = await this.database.get<{ state: string; candidate_object_count: number }>("SELECT state, candidate_object_count FROM garbage_collection_epochs WHERE workspace_id = ? AND garbage_collection_epoch_id = ?", [this.workspaceId, epochId]);
    if (!epoch) {
      await this.setGlobalBarrier(epochId, "marking", options.now);
      await this.faults.hit("collection.before_mark");
      await this.database.run("INSERT INTO garbage_collection_epochs (garbage_collection_epoch_id, workspace_id, state, started_at, mark_completed_at, sweep_started_at, completed_at, retention_root_digest, candidate_object_count, deleted_object_count, failure_code, workspace_boundaries, candidate_object_digest, deleted_object_digest) VALUES (?, ?, 'marking', ?, NULL, NULL, NULL, ?, 0, 0, NULL, ?, ?, ?)", [epochId, this.workspaceId, options.now, digestBytes(encodeCanonical([])), JSON.stringify([this.workspaceId]), digestBytes(encodeCanonical([])), digestBytes(encodeCanonical([]))]);
      const roots = await this.reachableHashesAllWorkspaces();
      const all = await this.listCasHashes();
      const candidates = all.filter((hash) => !roots.has(hash)).sort();
      if (candidates.length > 0) {
        await this.database.transaction(candidates.map((hash) => ({ kind: "run" as const, sql: "INSERT INTO garbage_collection_candidates (garbage_collection_epoch_id, content_hash) VALUES (?, ?)", params: [epochId, hash] as readonly SqliteValue[] })));
      }
      await this.database.run("UPDATE garbage_collection_epochs SET state = 'sweeping', mark_completed_at = ?, sweep_started_at = ?, retention_root_digest = ?, candidate_object_count = ?, workspace_boundaries = ?, candidate_object_digest = ? WHERE garbage_collection_epoch_id = ?", [options.now, options.now, digestBytes(encodeCanonical([...roots].sort())), candidates.length, JSON.stringify([this.workspaceId]), digestBytes(encodeCanonical(candidates)), epochId]);
      await this.setGlobalBarrier(epochId, "sweeping", options.now);
      await this.faults.hit("collection.after_mark");
      epoch = { state: "sweeping", candidate_object_count: candidates.length };
    } else if (epoch.state === "marking") {
      await this.setGlobalBarrier(epochId, "marking", options.now);
      const roots = await this.reachableHashesAllWorkspaces();
      const all = await this.listCasHashes();
      const candidates = all.filter((hash) => !roots.has(hash)).sort();
      await this.database.run("DELETE FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ?", [epochId]);
      if (candidates.length > 0) await this.database.transaction(candidates.map((hash) => ({ kind: "run" as const, sql: "INSERT INTO garbage_collection_candidates (garbage_collection_epoch_id, content_hash) VALUES (?, ?)", params: [epochId, hash] as readonly SqliteValue[] })));
      await this.database.run("UPDATE garbage_collection_epochs SET state = 'sweeping', mark_completed_at = ?, sweep_started_at = ?, retention_root_digest = ?, candidate_object_count = ?, workspace_boundaries = ?, candidate_object_digest = ? WHERE garbage_collection_epoch_id = ?", [options.now, options.now, digestBytes(encodeCanonical([...roots].sort())), candidates.length, JSON.stringify([this.workspaceId]), digestBytes(encodeCanonical(candidates)), epochId]);
      await this.setGlobalBarrier(epochId, "sweeping", options.now);
      await this.faults.hit("collection.after_mark");
    } else if (epoch.state === "sweeping") {
      await this.setGlobalBarrier(epochId, "sweeping", options.now);
    } else if (epoch.state === "recovered" || epoch.state === "failed") {
      await this.setGlobalBarrier(epochId, "marking", options.now);
      const roots = await this.reachableHashesAllWorkspaces();
      const all = await this.listCasHashes();
      const candidates = all.filter((hash) => !roots.has(hash)).sort();
      await this.database.run("DELETE FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ?", [epochId]);
      if (candidates.length > 0) await this.database.transaction(candidates.map((hash) => ({ kind: "run" as const, sql: "INSERT INTO garbage_collection_candidates (garbage_collection_epoch_id, content_hash) VALUES (?, ?)", params: [epochId, hash] as readonly SqliteValue[] })));
      await this.database.run("UPDATE garbage_collection_epochs SET state = 'sweeping', mark_completed_at = ?, sweep_started_at = ?, retention_root_digest = ?, candidate_object_count = ?, failure_code = NULL, workspace_boundaries = ?, candidate_object_digest = ? WHERE garbage_collection_epoch_id = ?", [options.now, options.now, digestBytes(encodeCanonical([...roots].sort())), candidates.length, JSON.stringify([this.workspaceId]), digestBytes(encodeCanonical(candidates)), epochId]);
      await this.setGlobalBarrier(epochId, "sweeping", options.now);
      epoch = { state: "sweeping", candidate_object_count: candidates.length };
    }
    await this.faults.hit("collection.before_sweep");
    const candidates = await this.database.all<{ content_hash: string }>("SELECT content_hash FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ? AND deleted_at IS NULL ORDER BY content_hash LIMIT ?", [epochId, options.batch_size]);
    const deleted: string[] = [];
    for (const candidate of candidates) {
      if (await this.hasActiveBackupBarrier()) throw new StorageError("storage:backup_active", "A verified backup barrier became active during collection.");
      const freshRoots = await this.reachableHashesAllWorkspaces();
      if (freshRoots.has(candidate.content_hash)) {
        await this.database.run("UPDATE garbage_collection_candidates SET deleted_at = 'retained' WHERE garbage_collection_epoch_id = ? AND content_hash = ? AND deleted_at IS NULL", [epochId, candidate.content_hash]);
        continue;
      }
      try { await unlink(this.cas.objectPath(candidate.content_hash)); } catch (error) { if (!isMissing(error)) throw new StorageError("storage:collection_delete_failed", `Could not delete ${candidate.content_hash}.`, { cause: error instanceof Error ? error.message : String(error) }); }
      await this.database.run("UPDATE garbage_collection_candidates SET deleted_at = ? WHERE garbage_collection_epoch_id = ? AND content_hash = ?", [options.now, epochId, candidate.content_hash]);
      deleted.push(candidate.content_hash);
    }
    const remaining = (await this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ? AND deleted_at IS NULL", [epochId]))?.count ?? 0;
    if (remaining === 0) {
      await this.database.run("UPDATE garbage_collection_epochs SET state = 'completed', sweep_started_at = COALESCE(sweep_started_at, ?), completed_at = ?, deleted_object_count = (SELECT COUNT(*) FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ? AND deleted_at IS NOT NULL AND deleted_at <> 'retained') WHERE garbage_collection_epoch_id = ?", [options.now, options.now, epochId, epochId]);
      await this.setGlobalBarrier(epochId, "completed", options.now);
    } else await this.database.run("UPDATE garbage_collection_epochs SET state = 'sweeping', sweep_started_at = COALESCE(sweep_started_at, ?), deleted_object_count = (SELECT COUNT(*) FROM garbage_collection_candidates WHERE garbage_collection_epoch_id = ? AND deleted_at IS NOT NULL AND deleted_at <> 'retained') WHERE garbage_collection_epoch_id = ?", [options.now, epochId, epochId]);
    await this.faults.hit("collection.after_sweep");
    return { epoch_id: epochId, state: remaining === 0 ? "completed" : "sweeping", deleted_hashes: deleted, remaining_candidates: remaining };
  }

  private async requireOwner(artifactId: string, artifactVersionId: string): Promise<void> {
    const row = await this.database.get<{ artifact_id: string }>("SELECT artifact_id FROM artifact_versions WHERE workspace_id = ? AND artifact_id = ? AND artifact_version_id = ?", [this.workspaceId, artifactId, artifactVersionId]);
    if (!row) throw new StorageError("storage:projection_owner_missing", `Projection owner ${artifactId}/${artifactVersionId} is missing.`);
  }

  /** Recompute the contract-shaped projection entries from typed logical rows. */
  async getProjectionSetDigestEntries(generation: number): Promise<ReadonlyArray<ProjectionSetDigestEntry>> {
    return await projectionSetDigestEntries(this.database, this.workspaceId, generation);
  }

  private async verifyVector(projectionRecordId: string, generation?: number): Promise<void> {
    const row = await this.database.get<{ shard_id: string; shard_offset: number; byte_length: number; vector_digest: string; owner_artifact_id: string; owner_artifact_version_id: string; profile_id: string; executable_binding_id: string; dimensions: number; element_type: string; vector_encoding: string; normalization: string; distance_metric: string; valid_from_generation: number; valid_to_generation: number | null }>("SELECT shard_id, shard_offset, byte_length, vector_digest, owner_artifact_id, owner_artifact_version_id, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric, valid_from_generation, valid_to_generation FROM vector_projection_rows WHERE workspace_id = ? AND projection_record_id = ? AND (? IS NULL OR valid_from_generation <= ? AND (valid_to_generation IS NULL OR valid_to_generation > ?)) ORDER BY valid_from_generation DESC LIMIT 1", [this.workspaceId, projectionRecordId, generation ?? null, generation ?? null, generation ?? null]);
    if (!row) throw new StorageError("storage:vector_missing", `Vector ${projectionRecordId} is missing.`);
    if ((row.element_type !== "float32" && row.element_type !== "float64") || (row.vector_encoding !== "float32-le" && row.vector_encoding !== "float64-le") || (row.element_type === "float32" && row.vector_encoding !== "float32-le") || (row.element_type === "float64" && row.vector_encoding !== "float64-le") || row.byte_length !== row.dimensions * (row.element_type === "float32" ? 4 : 8)) throw new StorageError("storage:vector_corrupt", `Vector ${projectionRecordId} has invalid declared encoding metadata.`);
    await this.requireOwner(row.owner_artifact_id, row.owner_artifact_version_id);
    const shard = await this.database.get<{ content_hash: string; byte_length: number; profile_id: string; executable_binding_id: string; dimensions: number; element_type: string; vector_encoding: string; normalization: string; distance_metric: string }>("SELECT content_hash, byte_length, profile_id, executable_binding_id, dimensions, element_type, vector_encoding, normalization, distance_metric FROM vector_shards WHERE workspace_id = ? AND shard_id = ?", [this.workspaceId, row.shard_id]);
    if (!shard) throw new StorageError("storage:vector_shard_missing", `Vector shard ${row.shard_id} is not retained.`);
    if (shard.profile_id !== row.profile_id || shard.executable_binding_id !== row.executable_binding_id || shard.dimensions !== row.dimensions || shard.element_type !== row.element_type || shard.vector_encoding !== row.vector_encoding || shard.normalization !== row.normalization || shard.distance_metric !== row.distance_metric) throw new StorageError("storage:vector_corrupt", `Vector shard ${row.shard_id} metadata is inconsistent.`);
    const source = await this.cas.read(shard.content_hash);
    if (source.byteLength !== shard.byte_length || row.shard_offset < 0 || row.shard_offset + row.byte_length > source.byteLength) throw new StorageError("storage:vector_corrupt", `Vector ${projectionRecordId} falls outside its shard materialization.`);
    if (digestBytes(source.slice(row.shard_offset, row.shard_offset + row.byte_length)) !== row.vector_digest) throw new StorageError("storage:vector_corrupt", `Vector ${projectionRecordId} is corrupt.`);
  }

  private async reachableHashes(): Promise<Set<string>> {
    const hashes = await this.reachableHashesForDatabase(this.database, this.workspaceId);
    for (const hash of await this.catalogReachableHashes()) hashes.add(hash);
    return hashes;
  }

  private async reachableHashesForDatabase(database: SqliteDatabase, workspaceId: string | undefined): Promise<Set<string>> {
    const scope = workspaceId === undefined ? "" : " WHERE workspace_id = ?";
    const manifestScope = workspaceId === undefined ? "" : " WHERE query_execution_id IN (SELECT query_execution_id FROM query_executions WHERE workspace_id = ?)";
    const rows = await database.all<{ content_hash: string }>(`
      SELECT content_hash FROM lexical_documents${scope}
      UNION SELECT content_hash FROM vector_shards${scope}
      UNION SELECT content_hash FROM lifecycle_cas_pins${scope}
      UNION SELECT content_hash FROM lifecycle_roots${scope}
      UNION SELECT content_digest AS content_hash FROM query_manifest_segments${manifestScope}
      UNION SELECT content_hash FROM content_blobs WHERE storage_reference LIKE 'cas:%'
    `, workspaceId === undefined ? [] : [workspaceId, workspaceId, workspaceId, workspaceId, workspaceId]);
    const hashes = new Set(rows.map((row) => row.content_hash));
    return await this.expandCasClosure(hashes);
  }

  private async expandCasClosure(hashes: Set<string>): Promise<Set<string>> {
    const pending = [...hashes];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const hash = pending.pop();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      try { collectContentHashes(decodeCanonical(await this.cas.read(hash)), hashes); } catch { /* non-canonical CAS assets have no discoverable transitive references */ }
      for (const discovered of hashes) if (!seen.has(discovered)) pending.push(discovered);
    }
    return hashes;
  }

  private async workspaceDatabases(): Promise<SqliteDatabase[]> {
    const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), read_only: true });
    try {
      const rows = await catalog.all<{ database_path: string }>("SELECT database_path FROM installation_workspaces ORDER BY workspace_id");
      const retained = [] as Array<{ database_path: string }>;
      for (const row of rows) if (await pathExists(row.database_path)) retained.push(row);
      return await Promise.all(retained.map((row) => openSqliteDatabase({ filename: row.database_path, read_only: true })));
    } finally { await catalog.close(); }
  }

  private async reachableHashesAllWorkspaces(): Promise<Set<string>> {
    const databases = await this.workspaceDatabases();
    const hashes = new Set<string>();
    try {
      for (const database of databases) {
        const found = await this.reachableHashesForDatabase(database, undefined);
        for (const hash of found) hashes.add(hash);
      }
      for (const hash of await this.catalogReachableHashes()) hashes.add(hash);
    } finally { await Promise.all(databases.map((database) => database.close())); }
    return hashes;
  }

  private async catalogReachableHashes(): Promise<Set<string>> {
    const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), read_only: true });
    try {
      const hashes = new Set<string>();
      const roots = await catalog.all<{ content_hash: string }>("SELECT content_hash FROM installation_gc_roots");
      for (const row of roots) hashes.add(row.content_hash);
      const installations = await catalog.all<{ manifest_digest: string }>("SELECT manifest_digest FROM installation_model_pack_installations");
      for (const row of installations) hashes.add(row.manifest_digest);
      return await this.expandCasClosure(hashes);
    } finally { await catalog.close(); }
  }

  private async hasActiveGcBarrier(): Promise<boolean> {
    const local = await this.database.get<{ garbage_collection_epoch_id: string }>("SELECT garbage_collection_epoch_id FROM garbage_collection_epochs WHERE workspace_id = ? AND state IN ('marking', 'sweeping') LIMIT 1", [this.workspaceId]);
    if (local) return true;
    const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite"), read_only: true });
    try { return Boolean(await catalog.get<{ garbage_collection_epoch_id: string }>("SELECT garbage_collection_epoch_id FROM installation_gc_barriers WHERE state IN ('marking', 'sweeping') LIMIT 1")); }
    finally { await catalog.close(); }
  }

  private async markEpochFailed(epochId: string, now: string, error: unknown): Promise<void> {
    const failureCode = error instanceof StorageError ? error.code : "storage:collection_failed";
    await this.database.run("UPDATE garbage_collection_epochs SET state = 'failed', completed_at = COALESCE(completed_at, ?), failure_code = ? WHERE workspace_id = ? AND garbage_collection_epoch_id = ? AND state IN ('marking', 'sweeping')", [now, failureCode, this.workspaceId, epochId]);
  }

  private async hasActiveBackupBarrier(): Promise<boolean> {
    const databases = await this.workspaceDatabases();
    try {
      for (const database of databases) {
        const active = await database.get<{ backup_id: string }>("SELECT backup_id FROM backup_barriers WHERE state = 'active' LIMIT 1");
        if (active) return true;
      }
      return false;
    } finally { await Promise.all(databases.map((database) => database.close())); }
  }

  private async setGlobalBarrier(epochId: string, state: "marking" | "sweeping" | "completed", now: string): Promise<void> {
    const catalog = await openSqliteDatabase({ filename: join(this.rootDir, "catalog.sqlite") });
    try {
      await catalog.run(`INSERT INTO installation_gc_barriers (garbage_collection_epoch_id, workspace_id, state, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(garbage_collection_epoch_id) DO UPDATE SET state = excluded.state, completed_at = excluded.completed_at`,
      [epochId, this.workspaceId, state, now, state === "completed" ? now : null]);
    } finally { await catalog.close(); }
  }

  private async listCasHashes(): Promise<readonly string[]> {
    const root = join(this.cas.rootDir, "sha256");
    const result: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const contentHash = casHashFromStorageRelativePath(relative(root, path));
          if (contentHash) result.push(contentHash);
        }
      }
    };
    await walk(root);
    return result;
  }
}
