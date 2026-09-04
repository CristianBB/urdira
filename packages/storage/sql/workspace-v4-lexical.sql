
-- v4 lexical sidecar schema (P2-1, plan §1/§3). Lives in
-- <workspace>.lexical.sqlite, a file separate from the catalog
-- (workspace.sqlite): the async post-ready lexical maintenance job's writer
-- lease must never contend with the structural writer lease again (see the
-- v4 design doc's per-file-lock rationale). Columns are byte-for-byte
-- identical to v3's lexical_documents/lexical_fts/lexical_index_state
-- (packages/storage/sql/workspace-v3.sql) so the existing reconcilers
-- (packages/engine/src/*) keep working unmodified once wired to this file;
-- only the location moved. One exception, forced by the file split rather
-- than chosen: the FOREIGN KEY from lexical_documents to artifact_versions
-- is dropped here because artifact_versions now lives in a different SQLite
-- file (workspace.sqlite) and SQLite cannot enforce a foreign key across
-- database files without an explicit ATTACH. workspace_id/artifact_id
-- columns are unchanged; referential integrity across the two files is the
-- writer's responsibility, exactly as it already is for every other
-- catalog-referencing column in this schema (e.g. control_plane_state's
-- reference_workspace_id has never had a declared FK either).
CREATE TABLE IF NOT EXISTS lexical_documents (
  artifact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_reference TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  PRIMARY KEY (workspace_id, artifact_id, artifact_version_id)
) STRICT;
-- FTS5 is the candidate generator for literal search. The trigram tokenizer
-- keeps substring semantics while exact CAS verification below remains the
-- authority for offsets and case sensitivity.
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_fts USING fts5(
  workspace_id UNINDEXED,
  artifact_id UNINDEXED,
  artifact_version_id UNINDEXED,
  content,
  tokenize = 'trigram'
);
-- Marks the last generation for which the async post-ready lexical
-- maintenance job (documents + FTS5) fully caught up with
-- artifact_versions. Query pushdown for core:search_text only trusts the
-- FTS5 index when completed_generation equals the workspace's current
-- generation; otherwise it falls back to a corpus scan. One row per
-- workspace, replaced wholesale on each successful reconcile pass.
CREATE TABLE IF NOT EXISTS lexical_index_state (
  workspace_id TEXT PRIMARY KEY,
  completed_generation INTEGER NOT NULL
) STRICT;
