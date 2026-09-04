import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_V4_LEXICAL_SCHEMA, WORKSPACE_V4_SCHEMA, WORKSPACE_V4_SEMANTIC_SCHEMA } from "../packages/storage/src/workspace-v4-sql.js";

describe("workspace-v4 SQL authority", () => {
  it("matches the SQL files byte-for-byte in the generated TypeScript", () => {
    expect(WORKSPACE_V4_SCHEMA).toBe(readFileSync("packages/storage/sql/workspace-v4.sql", "utf8"));
    expect(WORKSPACE_V4_LEXICAL_SCHEMA).toBe(readFileSync("packages/storage/sql/workspace-v4-lexical.sql", "utf8"));
    expect(WORKSPACE_V4_SEMANTIC_SCHEMA).toBe(readFileSync("packages/storage/sql/workspace-v4-semantic.sql", "utf8"));
  });

  it("matches the SQL files byte-for-byte in the generated Rust mirror", () => {
    const rust = readFileSync("crates/urdira-indexing-core/src/workspace_v4_sql.rs", "utf8");
    const extractRustConst = (name: string): string => {
      const match = rust.match(new RegExp(`pub const ${name}: &str =\\s*("(?:[^"\\\\]|\\\\.)*")`, "su"));
      if (!match?.[1]) throw new Error(`Could not find Rust constant ${name}`);
      // The generator writes this literal with JSON.stringify, so the
      // matched quoted body is valid JSON (not merely valid Rust syntax);
      // JSON.parse round-trips it exactly, including any Unicode section
      // signs left unescaped by JSON.stringify.
      return JSON.parse(match[1]) as string;
    };
    expect(extractRustConst("WORKSPACE_V4_SCHEMA")).toBe(WORKSPACE_V4_SCHEMA);
    expect(extractRustConst("WORKSPACE_V4_LEXICAL_SCHEMA")).toBe(WORKSPACE_V4_LEXICAL_SCHEMA);
    expect(extractRustConst("WORKSPACE_V4_SEMANTIC_SCHEMA")).toBe(WORKSPACE_V4_SEMANTIC_SCHEMA);
  });

  it("keeps the v4 catalog schema additive and free of dropped structural/lexical/semantic tables", () => {
    expect(WORKSPACE_V4_SCHEMA).toContain("CREATE TABLE IF NOT EXISTS merkle_roots");
    expect(WORKSPACE_V4_SCHEMA).toContain("artifact_ordinal INTEGER");
    // Match on the CREATE TABLE statement itself, not the bare table name:
    // several of these names appear legitimately in this file's own prose
    // comments (e.g. explaining that graph_edges moved to the native store).
    for (const dropped of ["record_occurrences", "record_facets", "record_value_nodes", "identity_assignments", "graph_edges", "artifact_dependencies", "metric_projections", "projection_occurrences", "set_merkle_nodes", "candidate_publication_record_occurrences", "candidate_staged_records", "candidate_fact_deltas", "lexical_documents", "lexical_fts", "vector_projection_rows", "vector_shards"]) {
      expect(WORKSPACE_V4_SCHEMA).not.toContain(`CREATE TABLE IF NOT EXISTS ${dropped} `);
      expect(WORKSPACE_V4_SCHEMA).not.toContain(`CREATE VIRTUAL TABLE IF NOT EXISTS ${dropped} `);
    }
    expect(WORKSPACE_V4_LEXICAL_SCHEMA).toContain("CREATE TABLE IF NOT EXISTS lexical_documents");
    expect(WORKSPACE_V4_SEMANTIC_SCHEMA).toContain("CREATE TABLE IF NOT EXISTS vector_projection_rows");
  });
});
