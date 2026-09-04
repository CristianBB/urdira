import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase, type SqliteDatabase } from "../packages/storage/src/sqlite.js";
import {
  STRUCTURAL_STORE_META_KEY,
  WORKSPACE_V4_INDEX_CONTRACT,
  ensureWorkspaceSchemaCompatibilityV4,
  initializeSchema,
  readStructuralStore,
  writeStructuralStore,
} from "../packages/storage/src/schema.js";
import { WORKSPACE_V4_SCHEMA } from "../packages/storage/src/workspace-v4-sql.js";
import { StorageError } from "../packages/storage/src/errors.js";

describe("v4 schema compatibility gate + structural_store meta key", () => {
  let root: string | undefined;
  let database: SqliteDatabase | undefined;
  afterEach(async () => {
    await database?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function freshDatabase(): Promise<SqliteDatabase> {
    root = await mkdtemp(join(tmpdir(), "urdira-v4-schema-gate-"));
    database = await openSqliteDatabase({ filename: join(root, "workspace.sqlite") });
    await initializeSchema(database, WORKSPACE_V4_SCHEMA);
    return database;
  }

  it("stamps 0x34 on an empty database and accepts it on a later call", async () => {
    const db = await freshDatabase();
    await ensureWorkspaceSchemaCompatibilityV4(db);
    const row = await db.get<{ value: Uint8Array }>("SELECT value FROM workspace_meta WHERE key = 'index_contract'");
    expect(row?.value).toBeInstanceOf(Uint8Array);
    expect([...(row?.value ?? [])]).toEqual([WORKSPACE_V4_INDEX_CONTRACT]);
    // Idempotent: a second call against the now-stamped database succeeds.
    await expect(ensureWorkspaceSchemaCompatibilityV4(db)).resolves.toBeUndefined();
  });

  it("rejects a populated, unstamped database (a v3 database opened as v4)", async () => {
    const db = await freshDatabase();
    await db.run(
      "INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?, ?, ?, ?, ?, ?)",
      ["artifact:one", "workspace:one", "file:///a.ts", "a.ts", "a.ts", "source_file"],
    );
    await expect(ensureWorkspaceSchemaCompatibilityV4(db)).rejects.toMatchObject({ code: "core:index_contract_unsupported" });
  });

  it("rejects a database stamped with the v3 contract byte", async () => {
    const db = await freshDatabase();
    await db.run("INSERT INTO workspace_meta (key, value) VALUES ('index_contract', ?)", [Uint8Array.of(0x33)]);
    await expect(ensureWorkspaceSchemaCompatibilityV4(db)).rejects.toMatchObject({ code: "core:index_contract_unsupported" });
  });

  it("round-trips the structural_store meta key and returns undefined when absent or unrecognized", async () => {
    const db = await freshDatabase();
    expect(await readStructuralStore(db)).toBeUndefined();

    await writeStructuralStore(db, "native");
    expect(await readStructuralStore(db)).toBe("native");

    await writeStructuralStore(db, "sqlite");
    expect(await readStructuralStore(db)).toBe("sqlite");

    await db.run("UPDATE workspace_meta SET value = ? WHERE key = ?", [new TextEncoder().encode("not-canonical-json"), STRUCTURAL_STORE_META_KEY]);
    expect(await readStructuralStore(db)).toBeUndefined();
  });
});

describe("StorageError shape used by the v4 gate", () => {
  it("carries the contract_kind/data_format_version details", () => {
    const error = new StorageError("core:index_contract_unsupported", "x", { contract_kind: "workspace_index", data_format_version: 4 });
    expect(error.details).toEqual({ contract_kind: "workspace_index", data_format_version: 4 });
  });
});
