import { describe, expect, it } from "vitest";
import { generateAllRelationalSql, generateRelationalSql, generatedRelationalTableSpecs, relationalTableSpec } from "../packages/contracts/src/index.js";

describe("Schema IR relational generation", () => {
  it("generates typed table metadata from the authoritative model registry", () => {
    const snapshot = relationalTableSpec("Snapshot");
    expect(snapshot?.generated_from).toBe("Schema IR");
    expect(snapshot?.table_name).toBe("model_snapshot");
    expect(snapshot?.columns.find((column) => column.field_name === "generation")?.sqlite_type).toBe("INTEGER");
    const workspace = relationalTableSpec("Workspace");
    expect(workspace?.child_tables.some((table) => table.parent_field === "source_provider_bindings")).toBe(true);
    expect(snapshot?.indexes).toContain("snapshot_id_idx");
    expect(generatedRelationalTableSpecs.length).toBeGreaterThan(20);
  });

  it("generates executable strict SQL for scalar fields and every registered model", () => {
    expect(generateRelationalSql("MissingModel")).toBeUndefined();
    const snapshot = generateRelationalSql("Snapshot");
    expect(snapshot?.model_name).toBe("Snapshot");
    expect(snapshot?.create_table).toContain("CREATE TABLE IF NOT EXISTS model_snapshot");
    expect(snapshot?.create_table).toContain("generation INTEGER NOT NULL");
    expect(snapshot?.create_table).toContain(") STRICT");
    expect(snapshot?.create_indexes).toContain("CREATE INDEX IF NOT EXISTS model_snapshot_snapshot_id_idx ON model_snapshot (snapshot_id)");
    expect(snapshot?.bind_columns).toContain("snapshot_id");
    expect(generateAllRelationalSql()).toHaveLength(generatedRelationalTableSpecs.length);
  });
});
