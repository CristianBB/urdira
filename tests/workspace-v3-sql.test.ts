import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_V3_SCHEMA, WORKSPACE_V3_SCHEMA_DIGEST, assertWorkspaceV3SchemaDigest } from "../packages/storage/src/workspace-v3-sql.js";
import { PUBLICATION_SQL, PUBLICATION_V3_SQL_DIGEST } from "../packages/storage/src/publication-v3-sql.js";

describe("workspace-v3 SQL authority", () => {
  it("matches the digest embedded by the Rust indexing core", () => {
    const sql = readFileSync("packages/storage/sql/workspace-v3.sql", "utf8");
    const rust = readFileSync("crates/urdira-indexing-core/src/workspace_v3_sql.rs", "utf8");
    const match = rust.match(/WORKSPACE_V3_SCHEMA_DIGEST: &str =\s*"([^"]+)"/u);
    expect(match?.[1]).toBe(WORKSPACE_V3_SCHEMA_DIGEST);
    expect(WORKSPACE_V3_SCHEMA).toBe(sql);
    expect(WORKSPACE_V3_SCHEMA_DIGEST).toBe(`sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`);
    expect(WORKSPACE_V3_SCHEMA).toContain("CREATE TABLE IF NOT EXISTS artifact_versions");
  });

  it("keeps fixed publication statements identical across runtimes", () => {
    const sql = readFileSync("packages/storage/sql/publication-v3.sql", "utf8");
    const rust = readFileSync("crates/urdira-indexing-worker/src/publication_v3_sql.rs", "utf8");
    expect(PUBLICATION_V3_SQL_DIGEST).toBe(`sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`);
    expect(rust).toMatch(new RegExp(`PUBLICATION_V3_SQL_DIGEST: &str =\\s+"${PUBLICATION_V3_SQL_DIGEST}"`, "u"));
    expect(PUBLICATION_SQL.candidatePublicationDescriptorEmpty).toContain("candidate_publication_descriptors");
    expect(PUBLICATION_SQL.candidatePublicationProjectionDescriptorEmpty).toContain("candidate_publication_projection_descriptors");
  });

  it("rejects a workspace opened with a divergent schema digest", () => {
    expect(() => assertWorkspaceV3SchemaDigest(WORKSPACE_V3_SCHEMA_DIGEST)).not.toThrow();
    expect(() => assertWorkspaceV3SchemaDigest("sha256:" + "0".repeat(64))).toThrow(/schema digest mismatch/iu);
  });
});
