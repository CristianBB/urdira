import { decodeCanonical, digestBytes, encodeCanonical } from "@urdira/canonical";
import type { SqliteCommand, SqliteDatabase } from "./sqlite.js";
import { StorageError } from "./errors.js";
import type { FaultInjector } from "./faults.js";

export const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS storage_meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS installation_workspaces (
  workspace_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL,
  display_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered', 'removed')),
  source_provider_bindings TEXT NOT NULL,
  database_path TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  removed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS installation_model_pack_installations (
  model_pack_installation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  model_pack_id TEXT NOT NULL,
  model_pack_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  removed_at TEXT,
  removal_reason_code TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS installation_cas_objects (
  content_hash TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT,
  storage_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_verified_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS installation_workspaces_active_idx ON installation_workspaces(removed_at, workspace_id);
CREATE INDEX IF NOT EXISTS installation_cas_objects_length_idx ON installation_cas_objects(byte_length);
CREATE TABLE IF NOT EXISTS installation_workspace_leases (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  lease_kind TEXT NOT NULL CHECK (lease_kind IN ('handle', 'relocation')),
  handle_count INTEGER NOT NULL CHECK (handle_count > 0),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_id)
) STRICT;
CREATE INDEX IF NOT EXISTS installation_workspace_leases_workspace_idx ON installation_workspace_leases(workspace_id, lease_kind);
CREATE TABLE IF NOT EXISTS installation_workspace_relocations (
  workspace_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('planned', 'renamed', 'catalog_updated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS installation_gc_barriers (
  garbage_collection_epoch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS installation_gc_roots (
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (root_kind, root_id, content_hash)
) STRICT;
`;

import { WORKSPACE_SCHEMA } from "./workspace-v3-sql.generated.js";
export { WORKSPACE_SCHEMA };

export async function initializeSchema(database: SqliteDatabase, schema: string): Promise<void> {
  await database.exec(schema);
}

export async function ensureWorkspaceSchemaCompatibility(database: SqliteDatabase, faults?: FaultInjector): Promise<void> {
  const contract = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
  const previousFormat = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'storage_format_version'");
  if (contract === undefined) {
    const populated = await database.get<{ count: number }>("SELECT (SELECT COUNT(*) FROM source_artifacts) + (SELECT COUNT(*) FROM record_occurrences) + (SELECT COUNT(*) FROM candidate_state) AS count");
    if (previousFormat !== undefined || (populated?.count ?? 0) > 0) {
      throw new StorageError("core:index_contract_unsupported", "The workspace uses an unsupported pre-v3 index contract; run the explicit v3 migration and re-register the workspace.", { contract_kind: "workspace_index", data_format_version: 3 });
    }
    await database.run("INSERT INTO workspace_meta (key, value) VALUES ('index_contract', ?)", [Uint8Array.of(0x33)]);
  } else {
    const bytes = contract.value instanceof Uint8Array ? contract.value : new Uint8Array(contract.value as ArrayBuffer);
    if (bytes.byteLength !== 1 || bytes[0] !== 0x33) throw new StorageError("core:index_contract_unsupported", "The workspace index contract is not supported by this Urdira v3 runtime; migrate to a fresh v3 data root and reindex.", { contract_kind: "workspace_index", data_format_version: 3 });
  }
  const columns = await database.all<{ name: string }>("PRAGMA table_info(storage_migrations)");
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("shadow_database_path")) await database.exec("ALTER TABLE storage_migrations ADD COLUMN shadow_database_path TEXT");
  if (!names.has("shadow_database_digest")) await database.exec("ALTER TABLE storage_migrations ADD COLUMN shadow_database_digest TEXT");
  const vectorColumns = await database.all<{ name: string }>("PRAGMA table_info(vector_projection_rows)");
  const vectorNames = new Set(vectorColumns.map((column) => column.name));
  if (!vectorNames.has("valid_from_generation")) await database.exec("ALTER TABLE vector_projection_rows ADD COLUMN valid_from_generation INTEGER NOT NULL DEFAULT 0");
  if (!vectorNames.has("valid_to_generation")) await database.exec("ALTER TABLE vector_projection_rows ADD COLUMN valid_to_generation INTEGER");
  // Decision 17: entity-grain lane discrimination -- see the CREATE TABLE
  // comment above. No backfill: every pre-existing row is correctly "artifact"
  // grain with these columns left NULL.
  if (!vectorNames.has("document_grain")) await database.exec("ALTER TABLE vector_projection_rows ADD COLUMN document_grain TEXT");
  if (!vectorNames.has("document_ref")) await database.exec("ALTER TABLE vector_projection_rows ADD COLUMN document_ref TEXT");
  await database.exec("CREATE INDEX IF NOT EXISTS vector_projection_document_ref_idx ON vector_projection_rows(workspace_id, document_grain, document_ref)");
  const semanticIndexStateColumns = await database.all<{ name: string }>("PRAGMA table_info(semantic_index_state)");
  if (!semanticIndexStateColumns.some((column) => column.name === "document_grains")) await database.exec("ALTER TABLE semantic_index_state ADD COLUMN document_grains TEXT");
  if (!semanticIndexStateColumns.some((column) => column.name === "entity_policy_digest")) await database.exec("ALTER TABLE semantic_index_state ADD COLUMN entity_policy_digest TEXT");
  // v3 has no generic staging representation. It was present only in early
  // previews; drop it on open so old workspaces cannot keep paying its
  // storage/index cost.
  await database.exec("DROP TABLE IF EXISTS candidate_staged_rows");
  // This v3 boundary is deliberately destructive. Early v3 preview roots
  // repeated three long ownership keys in every staged logical row. They are
  // not migrated: require a fresh v3 index so the compact fact_delta_key
  // layout is guaranteed for every lane.
  for (const lane of ["candidate_staged_records", "candidate_staged_graph_edges", "candidate_staged_identities", "candidate_staged_dependencies"]) {
    const stagedColumns = await database.all<{ name: string }>(`PRAGMA table_info(${lane})`);
    if (stagedColumns.some((column) => column.name === "workspace_id" || column.name === "fact_delta_rowid")) {
      throw new StorageError("core:index_contract_unsupported", "The workspace uses an unsupported early-v3 staging layout; create a fresh v3 data root and reindex.", { contract_kind: "workspace_index", data_format_version: 3, table: lane });
    }
  }
  const factDeltaNamespaceColumns = await database.all<{ name: string }>("PRAGMA table_info(candidate_fact_delta_namespaces)");
  if (!factDeltaNamespaceColumns.some((column) => column.name === "fact_delta_key")) {
    throw new StorageError("core:index_contract_unsupported", "The workspace uses an unsupported early-v3 FactDelta staging layout; create a fresh v3 data root and reindex.", { contract_kind: "workspace_index", data_format_version: 3, table: "candidate_fact_delta_namespaces" });
  }
  for (const column of ["producer_id", "producer_version", "owner_artifact_id", "owner_artifact_version_id", "analysis_digest", "analysis_configuration_digest"] as const) {
    if (!factDeltaNamespaceColumns.some((entry) => entry.name === column)) await database.exec(`ALTER TABLE candidate_fact_delta_namespaces ADD COLUMN ${column} TEXT`);
  }
  const factDeltaColumns = await database.all<{ name: string }>("PRAGMA table_info(candidate_fact_deltas)");
  if (factDeltaColumns.some((column) => column.name === "delta_payload")) {
    throw new StorageError("core:index_contract_unsupported", "The workspace uses an unsupported pre-v3 FactDelta payload layout; create a fresh v3 data root and reindex.", { contract_kind: "workspace_index", data_format_version: 3, table: "candidate_fact_deltas" });
  }
  // v3 typed staging lanes are WITHOUT ROWID tables whose declared primary
  // key is already the covering b-tree. Older v3 previews accidentally added
  // a second UNIQUE index over that same key, doubling write and storage cost.
  // Drop those redundant indexes on open; this is idempotent and preserves the
  // primary-key uniqueness contract.
  await database.exec("DROP INDEX IF EXISTS candidate_staged_graph_edges_pk; DROP INDEX IF EXISTS candidate_staged_identities_pk; DROP INDEX IF EXISTS candidate_staged_dependencies_pk");
  // Early v3 previews retained a wide metadata covering tree from the
  // relational-body format. Body hydration now reads record_occurrences, so
  // the narrower visibility tree is the real plan and the old tree is pure
  // write/storage amplification.
  await database.exec("DROP INDEX IF EXISTS record_occurrences_query_cover_idx; DROP INDEX IF EXISTS record_occurrences_owner_idx; DROP INDEX IF EXISTS record_occurrences_workspace_owner_kind_idx; DROP INDEX IF EXISTS record_facets_lookup_idx; DROP INDEX IF EXISTS identity_assignments_owner_idx");
  await database.exec("CREATE INDEX IF NOT EXISTS identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id)");
  await ensureCandidateForeignKeys(database, faults);
}

/** The catalog is a destructive v3 boundary; legacy catalogs are never reinterpreted. */
export async function ensureCatalogSchemaCompatibility(database: SqliteDatabase): Promise<void> {
  const contract = await database.get<{ value: unknown }>("SELECT value FROM storage_meta WHERE key = 'index_contract'");
  const workspaceCount = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM installation_workspaces");
  if (contract === undefined) {
    if ((workspaceCount?.count ?? 0) > 0) {
      throw new StorageError("core:index_contract_unsupported", "The catalog uses an unsupported pre-v3 index contract; run the explicit v3 migration and re-register workspaces.", { contract_kind: "catalog", data_format_version: 3 });
    }
    await database.run("INSERT INTO storage_meta (key, value) VALUES ('index_contract', ?)", [Uint8Array.of(0x33)]);
    return;
  }
  const value = contract.value instanceof Uint8Array ? contract.value : new Uint8Array(contract.value as ArrayBuffer);
  if (value.byteLength !== 1 || value[0] !== 0x33) {
    throw new StorageError("core:index_contract_unsupported", "The catalog index contract is not supported by this Urdira v3 runtime; migrate to a fresh v3 data root and reindex.", { contract_kind: "catalog", data_format_version: 3 });
  }
}

async function ensureCandidateForeignKeys(database: SqliteDatabase, faults?: FaultInjector): Promise<void> {
  const tables = [
    {
      name: "candidate_work_manifests",
      index: "candidate_work_manifests_candidate_idx",
      create: `CREATE TABLE candidate_work_manifests (
        work_manifest_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL,
        supersedes_work_manifest_id TEXT, base_snapshot_id TEXT, invalidation_plan_id TEXT NOT NULL,
        target_registry_snapshot_id TEXT NOT NULL, target_configuration_revision_id TEXT NOT NULL,
        artifact_work_set TEXT NOT NULL, projection_work_set TEXT NOT NULL, created_at TEXT NOT NULL,
        work_digest TEXT NOT NULL, UNIQUE (workspace_id, work_digest),
        FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
      ) STRICT`,
      columns: "work_manifest_id, workspace_id, candidate_generation_id, supersedes_work_manifest_id, base_snapshot_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, artifact_work_set, projection_work_set, created_at, work_digest",
    },
    {
      name: "candidate_fact_deltas",
      index: "candidate_fact_deltas_recovery_idx",
      create: `CREATE TABLE candidate_fact_deltas (
        fact_delta_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL,
        delta_digest TEXT NOT NULL, accepted_at TEXT NOT NULL,
        UNIQUE (workspace_id, candidate_generation_id, fact_delta_id),
        FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
      ) STRICT`,
      columns: "fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at",
    },
  ] as const;
  const rebuildCommands: SqliteCommand[] = [];
  for (const table of tables) {
    const foreignKeys = await database.all<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>(`PRAGMA foreign_key_list(${table.name})`);
    if (foreignKeys.length === 1 && foreignKeys[0]?.id === 0 && foreignKeys[0].seq === 0 && foreignKeys[0].table === "candidate_state" && foreignKeys[0].from === "candidate_generation_id" && foreignKeys[0].to === "candidate_generation_id" && foreignKeys[0].on_update === "NO ACTION" && foreignKeys[0].on_delete === "NO ACTION" && foreignKeys[0].match === "NONE") continue;
    const orphan = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name} AS child WHERE NOT EXISTS (SELECT 1 FROM candidate_state AS candidate WHERE candidate.candidate_generation_id = child.candidate_generation_id)`);
    if ((orphan?.count ?? 0) !== 0) throw new StorageError("storage:schema_migration_failed", `${table.name} contains orphaned candidate rows and cannot be rebuilt safely.`);
    const legacy = `${table.name}__legacy`;
    const legacyColumns = new Set((await database.all<{ name: string }>(`PRAGMA table_info(${table.name})`)).map((column) => column.name));
    const sourceColumns = table.name === "candidate_work_manifests"
      ? ["work_manifest_id", "workspace_id", "candidate_generation_id", "supersedes_work_manifest_id", "base_snapshot_id", "invalidation_plan_id", "target_registry_snapshot_id", "target_configuration_revision_id", legacyColumns.has("artifact_work_set") ? "artifact_work_set" : "'[]'", legacyColumns.has("projection_work_set") ? "projection_work_set" : "'[]'", legacyColumns.has("created_at") ? "created_at" : "''", "work_digest"]
      : ["fact_delta_id", "workspace_id", "candidate_generation_id", "delta_digest", "accepted_at"];
    const rebuildSql = `DROP INDEX IF EXISTS ${table.index}; ALTER TABLE ${table.name} RENAME TO ${legacy}; ${table.create}; INSERT INTO ${table.name} (${table.columns}) SELECT ${sourceColumns.join(", ")} FROM ${legacy}; DROP TABLE ${legacy}; CREATE INDEX ${table.index} ON ${table.name}(workspace_id, candidate_generation_id, ${table.name === "candidate_work_manifests" ? "work_manifest_id" : "accepted_at"});`;
    rebuildCommands.push({ kind: "exec", sql: rebuildSql });
  }
  if (rebuildCommands.length > 0) await database.transaction([
    ...rebuildCommands,
    ...(faults?.isPending?.("migration.candidate_fk_rebuild") === true ? [{ kind: "fault" as const, boundary: "migration.candidate_fk_rebuild" }] : []),
  ]);
  const violations = await database.all<Record<string, unknown>>("PRAGMA foreign_key_check");
  if (violations.length > 0) throw new StorageError("storage:schema_migration_failed", "Candidate schema foreign-key validation failed after rebuild.");
}

// v4 (plan §3/§9). A distinct byte from the v3 marker (0x33) so a v3
// database can never be misread as v4 or vice versa: the two schemas are
// structurally incompatible (v4 has no record_occurrences/graph_edges/etc.
// at all), so the only valid transition between them is
// `recreateOutdatedWorkspaceDatabase` (recreate-outdated.ts), never an
// in-place migration. NOT wired into `openWorkspace`/
// `registerWorkspaceSerialized` yet -- see docs/evidence/2026-09-02-v4-p2-1-schema.md.
export const WORKSPACE_V4_INDEX_CONTRACT = 0x34;

/**
 * v4 mirror of `ensureWorkspaceSchemaCompatibility`, scoped to the v4
 * catalog schema (packages/storage/sql/workspace-v4.sql). Unlike the v3
 * function, this has no legacy-preview column/index repairs to run: v4 has
 * no prior shipped shape to be compatible with, so an unstamped, non-empty
 * database is always rejected rather than backfilled. Not called from any
 * production code path yet (P4 wires this into `openWorkspace`).
 */
export async function ensureWorkspaceSchemaCompatibilityV4(database: SqliteDatabase): Promise<void> {
  const contract = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
  if (contract === undefined) {
    const populated = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM source_artifacts");
    if ((populated?.count ?? 0) > 0) {
      throw new StorageError("core:index_contract_unsupported", "The workspace uses an unsupported pre-v4 index contract; recreate the workspace database and reindex.", { contract_kind: "workspace_index", data_format_version: 4 });
    }
    await database.run("INSERT INTO workspace_meta (key, value) VALUES ('index_contract', ?)", [Uint8Array.of(WORKSPACE_V4_INDEX_CONTRACT)]);
    return;
  }
  const bytes = contract.value instanceof Uint8Array ? contract.value : new Uint8Array(contract.value as ArrayBuffer);
  if (bytes.byteLength !== 1 || bytes[0] !== WORKSPACE_V4_INDEX_CONTRACT) {
    throw new StorageError("core:index_contract_unsupported", "The workspace index contract is not supported by this Urdira v4 runtime; recreate the workspace database and reindex.", { contract_kind: "workspace_index", data_format_version: 4 });
  }
}

/**
 * `workspace_meta` key recording which structural-store engine a v4
 * workspace was created with (plan §2/§2.7): `"native"` for the mmap
 * segment store (Path N, structural/), `"sqlite"` for the Path S SQLite
 * fallback. Written once at creation, read at open so a daemon can route
 * queries to the right `CanonicalQuerySnapshotPort` implementation (plan
 * §9) -- neither of which exists yet; these helpers are the meta-key
 * contract other P2 subtasks build on.
 */
export const STRUCTURAL_STORE_META_KEY = "structural_store";

const STRUCTURAL_STORE_VALUES = new Set(["native", "sqlite"]);

export async function readStructuralStore(database: SqliteDatabase): Promise<"native" | "sqlite" | undefined> {
  const row = await database.get<{ value: unknown }>("SELECT value FROM workspace_meta WHERE key = ?", [STRUCTURAL_STORE_META_KEY]);
  if (!row) return undefined;
  const bytes = row.value instanceof Uint8Array ? row.value : row.value instanceof ArrayBuffer ? new Uint8Array(row.value) : undefined;
  if (!bytes) return undefined;
  let decoded: unknown;
  try { decoded = decodeCanonical(bytes); } catch { return undefined; }
  return typeof decoded === "string" && STRUCTURAL_STORE_VALUES.has(decoded) ? (decoded as "native" | "sqlite") : undefined;
}

export async function writeStructuralStore(database: SqliteDatabase, value: "native" | "sqlite"): Promise<void> {
  await database.run(
    "INSERT INTO workspace_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [STRUCTURAL_STORE_META_KEY, encodeCanonical(value)],
  );
}
