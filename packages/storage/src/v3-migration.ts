import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export interface LegacyMigrationWorkspacePreview {
  readonly workspace_id: string;
  readonly database_path: string;
  readonly snapshots: number;
  readonly cursors: number;
}

export interface V3MigrationPreview {
  readonly data_format: 1 | 2 | 3 | "unknown";
  readonly data_root: string;
  readonly v1_detected: boolean;
  readonly workspaces: readonly LegacyMigrationWorkspacePreview[];
  readonly cas_preserved: true;
  readonly confirmation_required: true;
  readonly destination_root: string;
  readonly backup_manifest: string;
}

/** Inventory a legacy root without opening or mutating its workspaces. */
export async function inspectV3DataRoot(dataRoot: string): Promise<V3MigrationPreview> {
  const preview = await inspectLegacyDataRoot(dataRoot);
  const destinationRoot = `${resolve(dataRoot)}-v3`;
  let dataFormat: V3MigrationPreview["data_format"] = preview.data_format === 2 ? 2 : preview.data_format === "unknown" ? "unknown" : 1;
  // Read only the one-byte contract marker so an already-v3 root is not
  // misreported as a legacy index during a migration preview.
  try {
    const catalog = await openSqliteDatabase({ filename: join(resolve(dataRoot), "catalog.sqlite") });
    try {
      const marker = await catalog.get<{ readonly value?: unknown }>("SELECT value FROM storage_meta WHERE key = 'index_contract'");
      const bytes = marker?.value instanceof Uint8Array ? marker.value : marker?.value instanceof ArrayBuffer ? new Uint8Array(marker.value) : undefined;
      if (bytes?.byteLength === 1 && bytes[0] === 0x33) dataFormat = 3;
    } finally { await catalog.close(); }
  } catch { /* an absent catalog is represented by the legacy inventory */ }
  return {
    ...preview,
    data_format: dataFormat,
    // A v3 marker is authoritative: the root is not a v1/v2 legacy root even
    // though the legacy inventory helper cannot interpret its catalog schema.
    v1_detected: dataFormat === 1,
    destination_root: destinationRoot,
    backup_manifest: join(destinationRoot, "migration-backup.json"),
  };
}

/**
 * Prepare a sibling v3 data root. The source root is never deleted and the
 * catalog/workspace files are copied only as a recovery backup; callers then
 * register the inventoried workspaces and reindex them into the new root.
 */
export async function migrateToV3(input: { readonly data_root: string; readonly destination_root?: string; readonly confirm: boolean }): Promise<V3MigrationPreview> {
  const preview = await inspectV3DataRoot(input.data_root);
  const destination = input.destination_root ?? preview.destination_root;
  const effectivePreview: V3MigrationPreview = { ...preview, destination_root: destination, backup_manifest: join(destination, "migration-backup.json") };
  if (!input.confirm) return effectivePreview;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const catalogPath = join(resolve(input.data_root), "catalog.sqlite");
  try { await access(catalogPath); await cp(catalogPath, join(destination, "catalog-legacy-backup.sqlite")); } catch { /* inventory remains valid for an empty root */ }
  await writeFile(join(destination, "migration-backup.json"), `${JSON.stringify({ from_root: resolve(input.data_root), source_format: preview.data_format, workspaces: preview.workspaces, cas_reuse_policy: "verify_scope_length_digest", reindex_required: true, migrated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(destination, "data-format.json"), `${JSON.stringify({ data_format: 3, migrated_from: preview.data_format, migrated_at: new Date().toISOString(), reindex_required: true })}\n`, { mode: 0o600 });
  return { ...effectivePreview, data_format: 3 };
}

async function inspectLegacyDataRoot(dataRoot: string): Promise<{
  readonly data_root: string;
  readonly data_format: 1 | 2 | "unknown";
  readonly v1_detected: boolean;
  readonly workspaces: readonly LegacyMigrationWorkspacePreview[];
  readonly cas_preserved: true;
  readonly confirmation_required: true;
}> {
  const catalogPath = join(dataRoot, "catalog.sqlite");
  try { await access(catalogPath); } catch {
    return { data_root: dataRoot, data_format: "unknown", v1_detected: false, workspaces: [], cas_preserved: true, confirmation_required: true };
  }
  const catalog = await openSqliteDatabase({ filename: catalogPath });
  try {
    const contract = await catalog.get<{ value: unknown }>("SELECT value FROM storage_meta WHERE key = 'index_contract'");
    const bytes = contract?.value instanceof Uint8Array ? contract.value : contract?.value instanceof ArrayBuffer ? new Uint8Array(contract.value) : undefined;
    const dataFormat: 1 | 2 | "unknown" = bytes?.byteLength === 1 && bytes[0] === 0x32 ? 2 : contract === undefined ? "unknown" : 1;
    const workspaces = await catalog.all<{ workspace_id: string; database_path: string }>("SELECT workspace_id, database_path FROM installation_workspaces WHERE removed_at IS NULL ORDER BY workspace_id");
    const result: LegacyMigrationWorkspacePreview[] = [];
    for (const workspace of workspaces) {
      try { await access(workspace.database_path); } catch { result.push({ ...workspace, snapshots: 0, cursors: 0 }); continue; }
      const database = await openSqliteDatabase({ filename: workspace.database_path });
      try { result.push({ ...workspace, snapshots: await countIfTable(database, "snapshots"), cursors: await countIfTable(database, "query_executions") }); }
      finally { await database.close(); }
    }
    return { data_root: dataRoot, data_format: dataFormat, v1_detected: dataFormat !== 2, workspaces: result, cas_preserved: true, confirmation_required: true };
  } finally { await catalog.close(); }
}

async function countIfTable(database: SqliteDatabase, table: string): Promise<number> {
  const exists = await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?", [table]);
  if ((exists?.count ?? 0) === 0) return 0;
  const row = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}
