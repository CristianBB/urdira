
-- v4 semantic sidecar schema (P2-1, plan §1/§3). Lives in
-- <workspace>.semantic.sqlite, separate from the catalog (workspace.sqlite)
-- for the same per-file-writer-lease reason as workspace-v4-lexical.sql.
-- Columns are byte-for-byte identical to v3's
-- vector_shards/vector_projection_rows/semantic_index_state
-- (packages/storage/sql/workspace-v3.sql) so packages/engine/src/semantic-
-- reconciler.ts keeps working unmodified once wired to this file; only the
-- location moved. As in workspace-v4-lexical.sql, the FOREIGN KEY from
-- vector_projection_rows to artifact_versions is dropped because
-- artifact_versions now lives in a different SQLite file and cross-file
-- foreign keys are not enforceable without ATTACH; the FOREIGN KEY to
-- vector_shards is kept because that table stays in this same file.
-- vector_projection_document_ref_idx is intentionally omitted here for the
-- same reason it is omitted from v3: it is created by
-- ensureWorkspaceSchemaCompatibility (not yet ported to v4 -- see the P2-1
-- evidence doc) after the document_grain/document_ref columns are
-- guaranteed present.
CREATE TABLE IF NOT EXISTS vector_shards (
  shard_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  element_type TEXT NOT NULL,
  vector_encoding TEXT NOT NULL,
  normalization TEXT NOT NULL,
  distance_metric TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_hash TEXT NOT NULL UNIQUE,
  storage_reference TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS vector_projection_rows (
  projection_record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  shard_id TEXT NOT NULL REFERENCES vector_shards(shard_id),
  shard_offset INTEGER NOT NULL CHECK (shard_offset >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  vector_digest TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  element_type TEXT NOT NULL,
  vector_encoding TEXT NOT NULL,
  normalization TEXT NOT NULL,
  distance_metric TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  -- Decision 17 (entity-grain semantic documents): NULL/absent means
  -- "artifact" -- every legacy row, and every row this table has ever held
  -- before this column existed -- "entity" marks a row produced by the
  -- reconciler's entity pass. document_ref is the owning entity RECORD id
  -- for an entity row, NULL for an artifact row.
  document_grain TEXT,
  document_ref TEXT,
  PRIMARY KEY (workspace_id, projection_record_id, valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS vector_projection_lookup_idx ON vector_projection_rows(workspace_id, profile_id, executable_binding_id, projection_record_id);
CREATE INDEX IF NOT EXISTS vector_projection_visible_idx ON vector_projection_rows(workspace_id, profile_id, executable_binding_id, valid_from_generation, valid_to_generation, projection_record_id);
-- Marks the last generation for which the async post-ready semantic
-- maintenance job (embedding + vector-row upkeep) fully caught up with
-- artifact_versions under the CURRENT embedding provider. Unlike
-- lexical_index_state, the marker also pins the provider identity
-- (profile_id + executable_binding_id): a provider swap (different model,
-- different runtime binding) makes every previously-embedded vector stale
-- even though completed_generation alone wouldn't change, so
-- core:search_semantic/core:search_hybrid pushdown must treat a marker
-- whose provider fields don't match the caller's configured provider as not
-- current, the same way it treats a stale generation. One row per
-- workspace, replaced wholesale on each successful reconcile pass.
CREATE TABLE IF NOT EXISTS semantic_index_state (
  workspace_id TEXT PRIMARY KEY,
  completed_generation INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  -- Decision 17: a canonical-JSON array of the document grains this marker's
  -- completed_generation is complete FOR, e.g. '["artifact","entity"]'.
  -- NULL for a marker written by a pre-entity-pass reconciler (or never
  -- backfilled) -- read as artifact-only.
  document_grains TEXT,
  -- Decision 17: digest of the ENTITY-ELIGIBILITY POLICY the entity pass ran
  -- under (predicate revision + min span length). A marker whose stored
  -- policy digest differs from the running reconciler's (including NULL) is
  -- NOT entity-complete for the running policy.
  entity_policy_digest TEXT
) STRICT;
-- Plan 2026-09-06 (Frente S-A): per-document semantic materialization
-- status, the source of truth for "affected" (not yet covered) documents --
-- both grains, one row per document per exact vector space
-- (profile_id/executable_binding_id), written by the reconciler's own
-- enumeration in the SAME pass that would otherwise only touch
-- vector_projection_rows. Additive per R22 (CREATE TABLE IF NOT EXISTS);
-- never referenced by a FOREIGN KEY into artifact_versions/record_occurrences
-- for the identical cross-file reason vector_projection_rows already has no
-- such FOREIGN KEY in this file.
CREATE TABLE IF NOT EXISTS semantic_document_status (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  document_grain TEXT NOT NULL,            -- 'artifact' | 'entity'
  document_id TEXT NOT NULL,               -- artifact_version_id or the entity record id
  artifact_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  display_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('covered','pending','excluded','unsupported','failed')),
  reason_codes TEXT NOT NULL DEFAULT '[]', -- JSON array, sorted
  segment_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, executable_binding_id, document_grain, document_id)
) STRICT;
CREATE INDEX IF NOT EXISTS semantic_document_status_affected
  ON semantic_document_status (workspace_id, profile_id, executable_binding_id, status, display_path, artifact_id, document_id);
