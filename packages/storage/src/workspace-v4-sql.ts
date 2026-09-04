import { WORKSPACE_V4_LEXICAL_SCHEMA, WORKSPACE_V4_SCHEMA, WORKSPACE_V4_SEMANTIC_SCHEMA } from "./workspace-v4-sql.generated.js";

/**
 * v4 workspace catalog schema (packages/storage/sql/workspace-v4.sql) and
 * its two sidecar schemas (workspace-v4-lexical.sql, workspace-v4-semantic.sql).
 * Additive and side-by-side with v3: nothing in this module is wired into
 * `openWorkspace`/`registerWorkspaceSerialized` yet -- see
 * docs/evidence/2026-09-02-v4-p2-1-schema.md for the P2-1 scope and the
 * table-by-table keep/move/drop decision.
 */
export { WORKSPACE_V4_LEXICAL_SCHEMA, WORKSPACE_V4_SCHEMA, WORKSPACE_V4_SEMANTIC_SCHEMA };
