
CREATE TABLE IF NOT EXISTS workspace_meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS source_artifacts (
  artifact_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  normalized_uri TEXT NOT NULL,
  normalized_path TEXT,
  display_path TEXT,
  artifact_kind TEXT NOT NULL,
  UNIQUE (workspace_id, artifact_id),
  UNIQUE (workspace_id, normalized_uri)
) STRICT;
CREATE INDEX IF NOT EXISTS source_artifacts_path_idx ON source_artifacts(workspace_id, normalized_path);
CREATE INDEX IF NOT EXISTS source_artifacts_uri_idx ON source_artifacts(workspace_id, normalized_uri, artifact_id);
CREATE TABLE IF NOT EXISTS content_blobs (
  content_blob_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_reference TEXT NOT NULL,
  UNIQUE (content_hash, byte_length)
) STRICT;
CREATE TABLE IF NOT EXISTS source_observation_batches (
  observation_batch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_provider_binding_id TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_provider_version TEXT NOT NULL,
  ordering_domain TEXT NOT NULL,
  observation_mode TEXT NOT NULL,
  coverage_scopes TEXT NOT NULL,
  coverage_completeness TEXT NOT NULL,
  deletion_authority TEXT NOT NULL,
  provider_cursor_before TEXT,
  provider_cursor_after TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL CHECK (observation_count >= 0),
  unavailable_count INTEGER NOT NULL CHECK (unavailable_count >= 0),
  batch_digest TEXT NOT NULL UNIQUE,
  UNIQUE (observation_batch_id, workspace_id)
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_version_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  content_blob_id TEXT NOT NULL REFERENCES content_blobs(content_blob_id),
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  encoding TEXT NOT NULL,
  language_hint TEXT,
  analysis_metadata_digest TEXT NOT NULL,
  created_from_observation_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id, created_from_observation_id) REFERENCES source_observations(workspace_id, artifact_id, source_observation_id),
  UNIQUE (workspace_id, artifact_version_id),
  UNIQUE (workspace_id, artifact_id, artifact_version_id),
  CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_idx ON artifact_versions(artifact_id, valid_from_generation, valid_to_generation);
-- Source reconciliation reads filter by workspace/provider and then apply the
-- generation window. The legacy artifact-only indexes force SQLite to scan
-- the whole catalog for every progressive stage.
CREATE INDEX IF NOT EXISTS artifact_versions_workspace_generation_idx ON artifact_versions(workspace_id, valid_from_generation, valid_to_generation, artifact_id);
CREATE TABLE IF NOT EXISTS artifact_tombstones (
  artifact_tombstone_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  absence_kind TEXT NOT NULL,
  absence_reason_code TEXT NOT NULL,
  last_artifact_version_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  opening_artifact_change_id TEXT NOT NULL,
  closing_artifact_change_id TEXT,
  replacement_artifact_version_id TEXT,
  cause_references TEXT NOT NULL,
  lineage_evidence_record_ids TEXT NOT NULL,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id, last_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, artifact_id, replacement_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  CHECK (valid_to_generation IS NULL OR valid_to_generation > valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS artifact_tombstones_workspace_generation_idx ON artifact_tombstones(workspace_id, valid_from_generation, valid_to_generation, artifact_id);
CREATE TABLE IF NOT EXISTS source_observations (
  source_observation_id TEXT PRIMARY KEY,
  observation_batch_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  source_provider_binding_id TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_provider_version TEXT NOT NULL,
  ordering_domain TEXT NOT NULL,
  observation_mode TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  observed_content_hash TEXT,
  observed_metadata_digest TEXT,
  provider_event_token TEXT,
  provider_sequence TEXT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (observation_batch_id) REFERENCES source_observation_batches(observation_batch_id),
  FOREIGN KEY (observation_batch_id, workspace_id) REFERENCES source_observation_batches(observation_batch_id, workspace_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
  UNIQUE (workspace_id, source_observation_id),
  UNIQUE (workspace_id, artifact_id, source_observation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS source_observations_artifact_idx ON source_observations(artifact_id, observed_at);
CREATE INDEX IF NOT EXISTS source_observations_workspace_binding_idx ON source_observations(workspace_id, source_provider_binding_id, artifact_id, source_observation_id);
CREATE TABLE IF NOT EXISTS source_index_state (
  workspace_id TEXT PRIMARY KEY,
  current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
  state_revision INTEGER NOT NULL CHECK (state_revision > 0),
  checkpoint_id TEXT NOT NULL,
  provider_watermarks TEXT NOT NULL,
  source_state_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS record_occurrences (
  record_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('entity', 'relation', 'fact', 'evidence', 'diagnostic')),
  kind TEXT NOT NULL,
  universal_kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  primary_source_span_artifact_version_id TEXT,
  primary_source_span_start_byte TEXT,
  primary_source_span_end_byte TEXT,
  primary_source_span_start_line TEXT,
  primary_source_span_end_line TEXT,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  -- Not UNIQUE (decision 11): a content revert legally produces a closed row
  -- and a live row that share record_digest with distinct, chain-salted
  -- record_ids -- see docs/decisions/11-content-derived-record-identity.md.
  record_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  body_byte_length INTEGER NOT NULL CHECK (body_byte_length >= 0),
  -- v3 stores the canonical body once. The former record_value_nodes
  -- projection multiplied every small body into several wide rows and made
  -- first publication of million-record workspaces both disk- and
  -- write-amplification bound.
  body_payload BLOB,
  analysis_digest TEXT NOT NULL,
  analysis_configuration_digest TEXT NOT NULL,
  artifact_dependency_digest TEXT NOT NULL,
  FOREIGN KEY (workspace_id, owner_artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, primary_source_span_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS record_occurrences_visible_idx ON record_occurrences(workspace_id, valid_from_generation, valid_to_generation);
-- Snapshot canonical-record digests are read in record_id order at the end of
-- every structural publication.  Keep that read index-only: the body payload
-- is deliberately wide and must not be fetched while hashing the visible set.
CREATE INDEX IF NOT EXISTS record_occurrences_digest_order_idx ON record_occurrences(workspace_id, record_id, valid_from_generation, valid_to_generation, record_digest);
CREATE TABLE IF NOT EXISTS record_facets (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  facet_ordinal INTEGER NOT NULL CHECK (facet_ordinal >= 0),
  facet TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id, valid_from_generation, facet_ordinal),
  FOREIGN KEY (record_id) REFERENCES record_occurrences(record_id)
) STRICT;
-- Serves currentlyVisibleForOwners's owner-narrowed record read
-- (packages/storage/src/repositories.ts). A non-workspace owner index
-- cannot reliably win over the visibility index, so the sole owner access
-- path leads with workspace_id and avoids maintaining two equivalent trees.
-- Without this shape the planner prefers
-- record_occurrences_visible_idx instead -- whose (workspace_id,
-- valid_from_generation <= current) prefix matches essentially EVERY row of
-- a mature workspace, degenerating into a full-workspace scan with a
-- row-by-row owner filter (measured: ~600ms per edit publish at 175k-record
-- scale, inside the scan's prior_state bucket; EXPLAIN QUERY PLAN confirmed
-- the visible_idx choice against a real bench workspace). Leading with
-- (workspace_id, owner_artifact_id) narrows straight to the handful of
-- owner-scoped rows. Same lesson as identity_assignments_owner_idx below:
-- every index on these tables must lead with workspace_id to be usable.
CREATE INDEX IF NOT EXISTS record_occurrences_workspace_owner_idx ON record_occurrences(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation);
-- Incremental structural publication joins the visible owner history and
-- anti-joins candidate record ids; keep the version and record id covered so
-- one-file edits do not scan every historical occurrence payload.
CREATE INDEX IF NOT EXISTS record_occurrences_workspace_owner_version_idx ON record_occurrences(workspace_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, record_id);
-- v2 logical record values.  This table stores typed scalar columns and
-- explicit container edges; it is not a serialized record payload.
CREATE TABLE IF NOT EXISTS record_value_nodes (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  value_path TEXT NOT NULL,
  parent_path TEXT,
  sequence_ordinal INTEGER,
  map_key TEXT,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('null', 'boolean', 'integer', 'real', 'text', 'bytes', 'object', 'array')),
  text_value TEXT,
  integer_value INTEGER,
  real_value REAL,
  bool_value INTEGER,
  bytes_value BLOB,
  PRIMARY KEY (workspace_id, record_id, valid_from_generation, value_path),
  FOREIGN KEY (record_id) REFERENCES record_occurrences(record_id)
) STRICT, WITHOUT ROWID;
-- The WITHOUT-ROWID primary key is the covering access path for every
-- reconstruction query on workspace_id, record_id, valid_from_generation,
-- and value_path.  No production query filters arbitrary values or traverses
-- parent_path; the two former secondary indexes duplicated most of this
-- table and made every FactDelta publish write hundreds of megabytes of
-- redundant B-trees.  Keep the logical columns relational, but do not index
-- columns that are not query predicates.
DROP INDEX IF EXISTS record_value_nodes_record_idx;
DROP INDEX IF EXISTS record_value_nodes_text_idx;
CREATE TABLE IF NOT EXISTS set_merkle_nodes (
  workspace_id TEXT NOT NULL,
  set_kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  node_prefix TEXT NOT NULL,
  node_digest TEXT NOT NULL,
  member_digest TEXT,
  logical_digest TEXT,
  PRIMARY KEY (workspace_id, set_kind, generation, node_prefix)
) STRICT;
CREATE INDEX IF NOT EXISTS set_merkle_nodes_leaf_idx ON set_merkle_nodes(workspace_id, set_kind, generation, member_digest);
CREATE TABLE IF NOT EXISTS registry_snapshots (
  registry_snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  registry_contract_version TEXT NOT NULL,
  core_registry_digest TEXT NOT NULL,
  resolution_lock_id TEXT NOT NULL,
  registry_digest TEXT NOT NULL UNIQUE,
  UNIQUE (workspace_id, registry_snapshot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS registry_namespace_bindings (
  namespace_binding_id TEXT NOT NULL,
  registry_snapshot_id TEXT NOT NULL REFERENCES registry_snapshots(registry_snapshot_id),
  workspace_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  contribution_digest TEXT NOT NULL,
  emission_valid_from_generation TEXT NOT NULL,
  emission_valid_to_generation TEXT,
  PRIMARY KEY (registry_snapshot_id, namespace_binding_id),
  FOREIGN KEY (workspace_id, registry_snapshot_id) REFERENCES registry_snapshots(workspace_id, registry_snapshot_id)
) STRICT;
CREATE INDEX IF NOT EXISTS registry_namespace_bindings_id_idx ON registry_namespace_bindings(namespace_binding_id);
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  parent_snapshot_id TEXT,
  generation_manifest_id TEXT NOT NULL,
  registry_snapshot_id TEXT NOT NULL,
  resolution_lock_id TEXT NOT NULL,
  configuration_revision_id TEXT NOT NULL,
  source_state_digest TEXT NOT NULL,
  source_snapshot_id TEXT,
  snapshot_contract_version INTEGER,
  publication_stage_id TEXT,
  publication_stage_ordinal INTEGER,
  publication_stage_count INTEGER,
  source_observation_watermarks TEXT NOT NULL,
  canonical_record_set_digest TEXT NOT NULL,
  projection_set_digests TEXT NOT NULL,
  capability_state_digest TEXT NOT NULL,
  published_at TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL UNIQUE,
  UNIQUE (workspace_id, generation),
  UNIQUE (workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, parent_snapshot_id) REFERENCES snapshots(workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, registry_snapshot_id) REFERENCES registry_snapshots(workspace_id, registry_snapshot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS workspace_current_state (
  workspace_id TEXT PRIMARY KEY,
  current_snapshot_id TEXT NOT NULL,
  current_generation INTEGER NOT NULL,
  current_registry_snapshot_id TEXT NOT NULL,
  current_resolution_lock_id TEXT NOT NULL,
  current_configuration_revision_id TEXT NOT NULL,
  current_freshness_checkpoint_id TEXT NOT NULL,
  state_revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, current_snapshot_id) REFERENCES snapshots(workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, current_registry_snapshot_id) REFERENCES registry_snapshots(workspace_id, registry_snapshot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS control_plane_state (
  state_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state_kind TEXT NOT NULL,
  state_json TEXT NOT NULL,
  reference_workspace_id TEXT,
  reference_snapshot_id TEXT,
  reference_source_state_digest TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS snapshots_generation_idx ON snapshots(workspace_id, generation);
CREATE INDEX IF NOT EXISTS control_plane_state_kind_idx ON control_plane_state(state_kind, state_key);
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_subject_id TEXT NOT NULL,
  target_subject_id TEXT NOT NULL,
  relation_record_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, edge_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_edges_outbound_idx ON graph_edges(workspace_id, source_subject_id, valid_from_generation, edge_id);
CREATE INDEX IF NOT EXISTS graph_edges_inbound_idx ON graph_edges(workspace_id, target_subject_id, valid_from_generation, edge_id);
CREATE INDEX IF NOT EXISTS graph_edges_outbound_visible_idx ON graph_edges(workspace_id, source_subject_id, valid_from_generation, valid_to_generation, target_subject_id, relation_kind, edge_id);
CREATE INDEX IF NOT EXISTS graph_edges_inbound_visible_idx ON graph_edges(workspace_id, target_subject_id, valid_from_generation, valid_to_generation, source_subject_id, relation_kind, edge_id);
CREATE TABLE IF NOT EXISTS lexical_documents (
  artifact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_reference TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  PRIMARY KEY (workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, artifact_id, artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
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
-- lexical_terms (per-token positional index) was retired before the v3 schema.
DROP TABLE IF EXISTS lexical_terms;
DROP INDEX IF EXISTS lexical_terms_lookup_idx;
-- v3 is destructive: the legacy relational trigram projection and its index
-- are removed rather than migrated. FTS5 is the sole lexical candidate index.
DROP INDEX IF EXISTS lexical_trigrams_lookup_idx;
DROP TABLE IF EXISTS lexical_trigrams;
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
-- Marks the last generation for which the async post-ready semantic
-- maintenance job (embedding + vector-row upkeep,
-- packages/engine/src/semantic-reconciler.ts) fully caught up with
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
  -- backfilled) -- read as artifact-only, so entity coverage is treated as
  -- incomplete even though completed_generation/profile_id/
  -- executable_binding_id all match (see reconcileSemanticProjection's
  -- already-complete fast path in semantic-reconciler.ts).
  document_grains TEXT,
  -- Decision 17: digest of the ENTITY-ELIGIBILITY POLICY the entity pass ran
  -- under (predicate revision + min span length -- see
  -- entityEligibilityPolicyDigest in semantic-reconciler.ts). A marker whose
  -- stored policy digest differs from the running reconciler's (including
  -- NULL: a marker written before policy tracking, or before a predicate
  -- fix) is NOT entity-complete for the running policy, so the entity pass
  -- backfills instead of trusting the already-complete fast path. This is
  -- what lets an eligibility-predicate fix (e.g. the line-based column-0
  -- test that admitted top-level variables) reach ALREADY-complete
  -- workspaces without a generation bump. Only the reconciler consumes it;
  -- the query side's marker-currency check deliberately ignores it (a lane
  -- with slightly-stale eligibility stays available, coverage counts tell
  -- the truth).
  entity_policy_digest TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_dependencies (
  dependency_entry_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  dependency_artifact_id TEXT NOT NULL,
  dependency_artifact_version_id TEXT NOT NULL,
  dependency_role TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dependency_entry_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, dependency_artifact_id, dependency_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS artifact_dependencies_reverse_idx ON artifact_dependencies(workspace_id, dependency_artifact_id, dependency_artifact_version_id, valid_from_generation, dependency_entry_id);
CREATE INDEX IF NOT EXISTS artifact_dependencies_direct_idx ON artifact_dependencies(workspace_id, record_id, valid_from_generation, valid_to_generation, dependency_artifact_id, dependency_artifact_version_id, dependency_role);
CREATE INDEX IF NOT EXISTS artifact_dependencies_digest_scan_idx ON artifact_dependencies(workspace_id, valid_from_generation, valid_to_generation, dependency_entry_id, content_digest);
CREATE TABLE IF NOT EXISTS metric_projections (
  metric_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_record_id TEXT NOT NULL,
  metric_kind TEXT NOT NULL,
  metric_value REAL NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, metric_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS metric_projections_lookup_idx ON metric_projections(workspace_id, projection_record_id, metric_kind, valid_from_generation);
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
  -- for an entity row, NULL for an artifact row. Nullable so a pre-migration
  -- database can ALTER TABLE ... ADD COLUMN these in
  -- (ensureWorkspaceSchemaCompatibility) with no backfill required -- every
  -- existing row is correctly, permanently "artifact" grain by construction.
  document_grain TEXT,
  document_ref TEXT,
  PRIMARY KEY (workspace_id, projection_record_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS vector_projection_lookup_idx ON vector_projection_rows(workspace_id, profile_id, executable_binding_id, projection_record_id);
CREATE INDEX IF NOT EXISTS vector_projection_visible_idx ON vector_projection_rows(workspace_id, profile_id, executable_binding_id, valid_from_generation, valid_to_generation, projection_record_id);
-- Frente S-G (2026-09-08): `vector_projection_by_owner_idx` (the fix for
-- `reconcileSemanticProjection`'s artifact-grain "missing rows" query,
-- confirmed live at n8n scale via EXPLAIN QUERY PLAN -- see
-- `ensureWorkspaceSchemaCompatibility`'s own doc comment on this index in
-- packages/storage/src/schema.ts for the full evidence) is created THERE,
-- not here: `document_grain` is only guaranteed present on a pre-existing
-- (legacy) `vector_projection_rows` table AFTER that function's own
-- `ALTER TABLE ... ADD COLUMN document_grain` migration step runs, which
-- happens strictly AFTER this schema string's own `CREATE INDEX` statements
-- (confirmed live: creating the index here broke
-- `ensureWorkspaceSchemaCompatibility`'s own pre-migration-database-open
-- test with "no such column: document_grain").
-- Plan 2026-09-06 (Frente S-A): per-document semantic materialization status
-- -- byte-for-byte identical to the v4 semantic sidecar's own copy
-- (packages/storage/sql/workspace-v4-semantic.sql), added here too so
-- packages/engine/src/semantic-reconciler.ts (one shared implementation)
-- keeps working unmodified against a v3 single-file workspace, exactly like
-- vector_shards/vector_projection_rows/semantic_index_state above already
-- do. Deliberately no FOREIGN KEY to artifact_versions even though both
-- live in this same file (unlike vector_projection_rows' FK above): keeping
-- v3 and v4 identical here means the reconciler's behavior never depends on
-- which schema it happens to be running against.
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
-- Frente S-F (2026-09-08): superseded by semantic_document_status_affected_v2
-- below -- the original index's column list ends at (status, display_path,
-- artifact_id, document_id); a `status <> 'covered'` (or even `status IN
-- (...)`) predicate only lets SQLite range-scan the trailing
-- (display_path, artifact_id, document_id) order WITHIN one status value at
-- a time, never across the whole set, so `semantic_affected_documents`'s own
-- `ORDER BY display_path, artifact_id, document_id` still needed a real sort
-- (TEMP B-TREE), and document_grain/artifact_version_id/reason_codes were
-- not covered (a rowid lookup per matched row). Measured live
-- (docs/evidence/2026-09-07-v4-semantic-close.md §3.2) at ~94,500 rows:
-- 5.0-5.4s per query. Dropped unconditionally on every schema apply -- a
-- real one-time drop on a pre-existing database, a harmless no-op on a
-- fresh one -- so no workspace keeps paying both indexes' write-side upkeep
-- once this schema string next runs against it.
DROP INDEX IF EXISTS semantic_document_status_affected;
-- `semantic_affected_documents`'s query now reads `ORDER BY status,
-- display_path, artifact_id, document_id` (status FIRST, matching this
-- index's own leading order) with `status IN (...)` instead of `<>`, which
-- SQLite satisfies as one single-pass, already-sorted SEARCH over this
-- index -- confirmed via EXPLAIN QUERY PLAN: no SCAN, no TEMP B-TREE.
-- document_grain/artifact_version_id/reason_codes are trailing covering
-- columns so the same scan also skips a rowid lookup per row
-- (segment_count/generation/updated_at are never read by that query, so
-- they stay out of the index). This groups the affected page's own display
-- order by status first, then path, instead of pure alphabetical across
-- every status -- a deliberate, documented trade (plan §0: performance
-- without compromising the operation's own contract, which never promised a
-- pure-alphabetical cross-status order, only a stable deterministic one).
CREATE INDEX IF NOT EXISTS semantic_document_status_affected_v2
  ON semantic_document_status (workspace_id, profile_id, executable_binding_id, status, display_path, artifact_id, document_id, document_grain, artifact_version_id, reason_codes);
-- Frente S-F (2026-09-08): materialized per-generation coverage summary --
-- `buildSemanticCoverageView` (canonical-query-data-port.ts) previously
-- recomputed `semantic_document_status_counts`/`semantic_affected_documents`
-- from scratch on EVERY core:search_semantic/core:search_hybrid call (5.0-5.4s
-- each at n8n-subset scale, docs/evidence/2026-09-07-v4-semantic-close.md
-- §3.2). The reconciler now writes exactly ONE row here, in the SAME
-- transaction as its own semantic_index_state completion marker, at the
-- close of every pass that reaches a clean/stable state (mirroring
-- semantic_index_state's own "replaced ... on each successful reconcile
-- pass" contract -- see semantic-reconciler.ts). `buildSemanticCoverageView`
-- then reads the newest row for (workspace_id, profile_id,
-- executable_binding_id) with one indexed point lookup (`ORDER BY
-- generation DESC LIMIT 1`, satisfied by this table's own PRIMARY KEY, no
-- extra index needed) instead of two full-table computations. A caller
-- needing a page PAST the embedded first one still calls
-- `core:semantic_affected_page`, which queries `semantic_document_status`
-- directly (via the covering `semantic_document_status_affected_v2` index
-- above) -- this table only ever serves the FIRST page for free. Additive
-- (CREATE TABLE IF NOT EXISTS, R22); never referenced by a FOREIGN KEY for
-- the same cross-file-safety reason semantic_document_status has none
-- above. One row per (workspace, profile, binding, generation) is kept
-- (never overwritten across generations) as a small, bounded audit trail.
CREATE TABLE IF NOT EXISTS semantic_coverage_summary (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  unsupported_artifact_count INTEGER NOT NULL,
  failed_artifact_count INTEGER NOT NULL,
  entity_count INTEGER NOT NULL,
  covered_entity_count INTEGER NOT NULL,
  affected_artifact_count INTEGER NOT NULL,
  affected_artifact_set_id TEXT NOT NULL,
  affected_first_page TEXT NOT NULL, -- canonical JSON array of SemanticAffectedDocumentRow, already limit-capped
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, executable_binding_id, generation)
) STRICT;
-- Frente S-D (2026-09-07, Lever 3): content-addressed cache of already-
-- embedded SEGMENT vectors, keyed by (executable_binding_id, segment_digest)
-- -- a digest of the exact normalized segment text this vector space would
-- embed. Lets the reconciler skip a provider call entirely for a segment
-- whose (text, binding) pair was already embedded by ANY document, in ANY
-- prior generation (an edited file typically keeps ~90% of its segments
-- unchanged across an edit -- plan section 4's own framing). Additive
-- (CREATE TABLE IF NOT EXISTS); never referenced by a FOREIGN KEY (same
-- cross-file-safety reasoning as vector_projection_rows/semantic_document_status
-- above). Vector bytes are stored INLINE (not shard-packed) since a cache
-- row's own lifecycle (no LRU yet, grows with distinct segment content,
-- pruned only by a future retention pass) is unrelated to vector_shards'
-- append-only packing.
CREATE TABLE IF NOT EXISTS semantic_segment_cache (
  workspace_id TEXT NOT NULL,
  executable_binding_id TEXT NOT NULL,
  segment_digest TEXT NOT NULL,
  vector BLOB NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  element_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, executable_binding_id, segment_digest)
) STRICT;
-- NOTE: vector_projection_document_ref_idx (the entity pass's stale-close
-- join / entity-lane scan index over (workspace_id, document_grain,
-- document_ref)) is deliberately NOT created here: initializeSchema runs
-- this raw schema string unconditionally on every open, including a
-- pre-migration database whose vector_projection_rows does not yet have the
-- document_grain/document_ref columns -- an index referencing them here
-- would fail that open before ensureWorkspaceSchemaCompatibility ever got
-- to run its ALTERs. It lives in ensureWorkspaceSchemaCompatibility
-- instead (after the columns are guaranteed), exactly like the
-- content_digest scan indexes -- see ensureProjectionContentDigests's
-- comment for the same trap spelled out.
CREATE TABLE IF NOT EXISTS retention_leases (
  retention_lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  holder_type TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  last_renewed_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE (workspace_id, retention_lease_id)
) STRICT;
CREATE INDEX IF NOT EXISTS retention_leases_active_idx ON retention_leases(workspace_id, snapshot_id, released_at, absolute_expires_at);
CREATE TABLE IF NOT EXISTS retention_pins (
  retention_pin_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  pin_kind TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  source_reference_json TEXT NOT NULL,
  UNIQUE (workspace_id, retention_pin_id)
) STRICT;
CREATE TABLE IF NOT EXISTS snapshot_expiration_markers (
  snapshot_expiration_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expired_at TEXT NOT NULL,
  expiration_reason_code TEXT NOT NULL,
  garbage_collection_epoch_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  UNIQUE (workspace_id, snapshot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS lifecycle_cas_pins (
  workspace_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS query_executions (
  query_execution_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workspace_snapshot_ids TEXT NOT NULL,
  query_plan_hash TEXT NOT NULL,
  projection_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  response_budget_ceiling TEXT NOT NULL,
  retention_lease_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  execution_status TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS query_manifest_segments (
  query_execution_id TEXT NOT NULL REFERENCES query_executions(query_execution_id),
  segment_id TEXT NOT NULL,
  segment_ordinal INTEGER NOT NULL,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  first_ordinal INTEGER NOT NULL,
  last_ordinal INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  -- The durable segment lives in CAS; the table stores only its reference.
  PRIMARY KEY (query_execution_id, segment_id)
) STRICT;
CREATE INDEX IF NOT EXISTS query_manifest_segments_order_idx ON query_manifest_segments(query_execution_id, segment_ordinal);
CREATE TABLE IF NOT EXISTS storage_migrations (
  migration_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  backup_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  migration_state_json TEXT NOT NULL,
  shadow_database_path TEXT,
  shadow_database_digest TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS lifecycle_roots (
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, root_kind, root_id, content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS backup_barriers (
  backup_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS garbage_collection_epochs (
  garbage_collection_epoch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  mark_completed_at TEXT,
  sweep_started_at TEXT,
  completed_at TEXT,
  retention_root_digest TEXT NOT NULL,
  candidate_object_count INTEGER NOT NULL,
  deleted_object_count INTEGER NOT NULL,
  failure_code TEXT,
  workspace_boundaries TEXT NOT NULL,
  candidate_object_digest TEXT NOT NULL,
  deleted_object_digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS garbage_collection_candidates (
  garbage_collection_epoch_id TEXT NOT NULL REFERENCES garbage_collection_epochs(garbage_collection_epoch_id),
  content_hash TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (garbage_collection_epoch_id, content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_state (
  candidate_generation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  base_snapshot_id TEXT,
  base_generation INTEGER,
  base_registry_snapshot_id TEXT,
  target_registry_snapshot_id TEXT NOT NULL,
  base_configuration_revision_id TEXT,
  target_configuration_revision_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  work_manifest_id TEXT,
  source_observation_batch_ids TEXT NOT NULL,
  retention_lease_id TEXT,
  candidate_materialization_id TEXT,
  candidate_digest TEXT,
  created_at TEXT NOT NULL,
  analysis_started_at TEXT,
  ready_at TEXT,
  finished_at TEXT,
  published_snapshot_id TEXT,
  published_generation INTEGER,
  generation_manifest_id TEXT,
  stale_against_snapshot_id TEXT,
  failure_code TEXT,
  issue_ids TEXT NOT NULL,
  frozen_snapshot_id TEXT,
  frozen_generation INTEGER,
  frozen_registry_snapshot_id TEXT,
  frozen_resolution_lock_id TEXT,
  frozen_configuration_revision_id TEXT,
  frozen_source_state_digest TEXT,
  frozen_source_observation_batch_ids TEXT,
  frozen_tuple_digest TEXT,
  UNIQUE (workspace_id, candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_state_recovery_idx ON candidate_state(workspace_id, state, created_at, candidate_generation_id);
CREATE INDEX IF NOT EXISTS candidate_state_target_idx ON candidate_state(workspace_id, target_registry_snapshot_id, target_configuration_revision_id);
CREATE TABLE IF NOT EXISTS candidate_work_manifests (
  work_manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  supersedes_work_manifest_id TEXT,
  base_snapshot_id TEXT,
  invalidation_plan_id TEXT NOT NULL,
  target_registry_snapshot_id TEXT NOT NULL,
  target_configuration_revision_id TEXT NOT NULL,
  artifact_work_set TEXT NOT NULL,
  projection_work_set TEXT NOT NULL,
  created_at TEXT NOT NULL,
  work_digest TEXT NOT NULL,
  UNIQUE (workspace_id, work_digest),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_work_manifests_candidate_idx ON candidate_work_manifests(workspace_id, candidate_generation_id, work_manifest_id);
CREATE TABLE IF NOT EXISTS candidate_fact_deltas (
  fact_delta_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  delta_digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, fact_delta_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_fact_deltas_recovery_idx ON candidate_fact_deltas(workspace_id, candidate_generation_id, accepted_at);
CREATE TABLE IF NOT EXISTS candidate_fact_delta_namespaces (
  fact_delta_key INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  fact_delta_id TEXT NOT NULL,
  producer_id TEXT,
  producer_version TEXT,
  owner_artifact_id TEXT,
  owner_artifact_version_id TEXT,
  analysis_digest TEXT,
  analysis_configuration_digest TEXT,
  UNIQUE (workspace_id, candidate_generation_id, fact_delta_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_fact_delta_batches (
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  fact_delta_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, candidate_generation_id, fact_delta_id, sequence),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT, WITHOUT ROWID;
-- v3 typed staging lanes. Each lane has the promoted scalar layout without a
-- section discriminator. Keep the DDL explicit: CREATE TABLE AS SELECT would
-- silently drop STRICT/WITHOUT ROWID and leave SQLite with dynamic affinity.
CREATE TABLE IF NOT EXISTS candidate_staged_records (
  fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL,
  text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT,
  real_0 REAL, real_1 REAL, real_2 REAL, real_3 REAL,
  integer_0 INTEGER, integer_1 INTEGER, integer_2 INTEGER, integer_3 INTEGER,
  enum_0 INTEGER, enum_1 INTEGER, enum_2 INTEGER, enum_3 INTEGER,
  presence_0 INTEGER, presence_1 INTEGER, presence_2 INTEGER, presence_3 INTEGER, presence_4 INTEGER, presence_5 INTEGER, presence_6 INTEGER, presence_7 INTEGER,
  PRIMARY KEY (fact_delta_key, row_ordinal),
  FOREIGN KEY (fact_delta_key) REFERENCES candidate_fact_delta_namespaces(fact_delta_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_staged_graph_edges (
  fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL,
  text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT,
  real_0 REAL, real_1 REAL, real_2 REAL, real_3 REAL, integer_0 INTEGER, integer_1 INTEGER, integer_2 INTEGER, integer_3 INTEGER,
  enum_0 INTEGER, enum_1 INTEGER, enum_2 INTEGER, enum_3 INTEGER, presence_0 INTEGER, presence_1 INTEGER, presence_2 INTEGER, presence_3 INTEGER, presence_4 INTEGER, presence_5 INTEGER, presence_6 INTEGER, presence_7 INTEGER,
  PRIMARY KEY (fact_delta_key, row_ordinal), FOREIGN KEY (fact_delta_key) REFERENCES candidate_fact_delta_namespaces(fact_delta_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_staged_identities (
  fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL,
  text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT,
  real_0 REAL, real_1 REAL, real_2 REAL, real_3 REAL, integer_0 INTEGER, integer_1 INTEGER, integer_2 INTEGER, integer_3 INTEGER,
  enum_0 INTEGER, enum_1 INTEGER, enum_2 INTEGER, enum_3 INTEGER, presence_0 INTEGER, presence_1 INTEGER, presence_2 INTEGER, presence_3 INTEGER, presence_4 INTEGER, presence_5 INTEGER, presence_6 INTEGER, presence_7 INTEGER,
  PRIMARY KEY (fact_delta_key, row_ordinal), FOREIGN KEY (fact_delta_key) REFERENCES candidate_fact_delta_namespaces(fact_delta_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_staged_dependencies (
  fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL,
  text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT,
  real_0 REAL, real_1 REAL, real_2 REAL, real_3 REAL, integer_0 INTEGER, integer_1 INTEGER, integer_2 INTEGER, integer_3 INTEGER,
  enum_0 INTEGER, enum_1 INTEGER, enum_2 INTEGER, enum_3 INTEGER, presence_0 INTEGER, presence_1 INTEGER, presence_2 INTEGER, presence_3 INTEGER, presence_4 INTEGER, presence_5 INTEGER, presence_6 INTEGER, presence_7 INTEGER,
  PRIMARY KEY (fact_delta_key, row_ordinal), FOREIGN KEY (fact_delta_key) REFERENCES candidate_fact_delta_namespaces(fact_delta_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- Candidate-scoped publication staging mirrors the high-cardinality final
-- canonical tables. It is rebuildable from accepted FactDelta authority and
-- is never query-visible; publication consumes only a sealed descriptor.
CREATE TABLE IF NOT EXISTS candidate_publication_record_occurrences (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, category TEXT NOT NULL,
  kind TEXT NOT NULL, universal_kind TEXT NOT NULL, schema_version INTEGER NOT NULL,
  producer_id TEXT NOT NULL, producer_version TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL,
  primary_source_span_artifact_version_id TEXT,
  primary_source_span_start_byte TEXT, primary_source_span_end_byte TEXT,
  primary_source_span_start_line TEXT, primary_source_span_end_line TEXT,
  valid_from_generation INTEGER NOT NULL, record_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL, body_byte_length INTEGER NOT NULL, body_payload BLOB,
  analysis_digest TEXT NOT NULL, analysis_configuration_digest TEXT NOT NULL,
  artifact_dependency_digest TEXT NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  UNIQUE (candidate_generation_id, record_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_record_facets (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  workspace_id TEXT NOT NULL, record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL, facet_ordinal INTEGER NOT NULL, facet TEXT NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_record_closures (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  workspace_id TEXT NOT NULL, record_id TEXT NOT NULL,
  valid_to_generation INTEGER NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  UNIQUE (candidate_generation_id, record_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_identity_assignments (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  identity_assignment_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  identity_type TEXT NOT NULL, identity_id TEXT NOT NULL, assignment_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL, identity_key_digest TEXT NOT NULL, record_id TEXT NOT NULL,
  previous_record_id TEXT, valid_from_generation INTEGER NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  UNIQUE (candidate_generation_id, identity_assignment_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_projection_occurrences (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  projection_record_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL, projection_key TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL,
  source_artifact_version_ids TEXT NOT NULL, source_record_ids TEXT NOT NULL,
  source_projection_record_ids TEXT NOT NULL, generator TEXT NOT NULL,
  generator_version TEXT NOT NULL, generator_configuration_digest TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL, content_digest TEXT NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  UNIQUE (candidate_generation_id, projection_record_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_projection_dependencies (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  workspace_id TEXT NOT NULL, projection_record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL, source_type TEXT NOT NULL
    CHECK (source_type IN ('artifact_version', 'record', 'projection')),
  source_id TEXT NOT NULL,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_projection_value_nodes (
  candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL,
  workspace_id TEXT NOT NULL, record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL, value_path TEXT NOT NULL,
  parent_path TEXT, sequence_ordinal INTEGER, map_key TEXT,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('null', 'boolean', 'integer', 'real', 'text', 'bytes', 'object', 'array')),
  text_value TEXT, integer_value INTEGER, real_value REAL, bool_value INTEGER, bytes_value BLOB,
  PRIMARY KEY (candidate_generation_id, row_ordinal),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_publication_projection_descriptors (
  candidate_generation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  projection_count INTEGER NOT NULL, dependency_count INTEGER NOT NULL,
  value_node_count INTEGER NOT NULL, first_projection_record_id TEXT,
  last_projection_record_id TEXT, projection_sequence_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_publication_descriptors (
  candidate_generation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  record_count INTEGER NOT NULL, facet_count INTEGER NOT NULL, identity_count INTEGER NOT NULL,
  canonical_byte_length INTEGER NOT NULL, first_record_id TEXT, last_record_id TEXT,
  record_sequence_digest TEXT NOT NULL, identity_sequence_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_materializations (
  candidate_materialization_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT,
  materialization_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  materialization_contract_text TEXT NOT NULL,
  UNIQUE (workspace_id, materialization_digest),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_materializations_candidate_idx ON candidate_materializations(workspace_id, candidate_generation_id, sealed_at);
CREATE TABLE IF NOT EXISTS candidate_issues (
  candidate_issue_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  phase TEXT NOT NULL,
  severity TEXT NOT NULL,
  retryability TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  cause_references TEXT NOT NULL,
  issue_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, candidate_issue_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_issues_candidate_idx ON candidate_issues(workspace_id, candidate_generation_id, created_at, candidate_issue_id);
CREATE TABLE IF NOT EXISTS candidate_lookup_dependencies (
  lookup_dependency_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  consumer_type TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  owner_artifact_id TEXT,
  owner_artifact_version_id TEXT,
  operation TEXT NOT NULL,
  normalized_selector_or_address TEXT NOT NULL,
  selector_digest TEXT NOT NULL,
  previous_result_set_digest TEXT NOT NULL,
  invalidation_scope TEXT NOT NULL,
  valid_from_generation INTEGER,
  valid_to_generation INTEGER,
  dependency_digest TEXT NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, lookup_dependency_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_lookup_dependencies_selector_idx ON candidate_lookup_dependencies(workspace_id, consumer_type, consumer_id, selector_digest);
CREATE TABLE IF NOT EXISTS candidate_retention_leases (
  retention_lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  base_snapshot_id TEXT,
  state TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE (workspace_id, candidate_generation_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_roots (
  root_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, resource_type, content_digest),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_value_nodes (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  value_path TEXT NOT NULL,
  parent_path TEXT,
  sequence_ordinal INTEGER,
  map_key TEXT,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('null', 'boolean', 'integer', 'real', 'text', 'bytes', 'object', 'array')),
  text_value TEXT,
  integer_value INTEGER,
  real_value REAL,
  bool_value INTEGER,
  bytes_value BLOB,
  PRIMARY KEY (workspace_id, record_id, valid_from_generation, value_path)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS candidate_cleanup_markers (
  candidate_generation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  state TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (candidate_generation_id, resource_type, resource_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_cleanup_markers_pending_idx ON candidate_cleanup_markers(candidate_generation_id, state, resource_type, resource_id);
CREATE TABLE IF NOT EXISTS candidate_publication_journal (
  candidate_generation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  generation_manifest_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  UNIQUE (workspace_id, snapshot_id),
  UNIQUE (workspace_id, generation),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_publication_journal_recovery_idx ON candidate_publication_journal(workspace_id, status, generation, candidate_generation_id);
CREATE TABLE IF NOT EXISTS generation_manifests (
  generation_manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  base_snapshot_id TEXT,
  registry_snapshot_id TEXT NOT NULL,
  publication_kind TEXT NOT NULL,
  published_at TEXT NOT NULL,
  artifact_change_set TEXT NOT NULL,
  record_open_set TEXT NOT NULL,
  record_closure_set TEXT NOT NULL,
  identity_assignment_set TEXT NOT NULL,
  projection_change_sets TEXT NOT NULL,
  manifest_digest TEXT NOT NULL UNIQUE,
  UNIQUE (workspace_id, generation),
  UNIQUE (workspace_id, generation_manifest_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS generation_manifests_published_idx ON generation_manifests(workspace_id, generation, candidate_generation_id);
CREATE TABLE IF NOT EXISTS projection_occurrences (
  projection_record_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL,
  projection_key TEXT NOT NULL,
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  source_artifact_version_ids TEXT NOT NULL,
  source_record_ids TEXT NOT NULL,
  source_projection_record_ids TEXT NOT NULL,
  generator TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  generator_configuration_digest TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, projection_record_id, valid_from_generation),
  UNIQUE (workspace_id, projection_key, valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS projection_occurrences_owner_idx ON projection_occurrences(workspace_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation);
CREATE INDEX IF NOT EXISTS projection_occurrences_source_artifact_idx ON projection_occurrences(workspace_id, source_artifact_version_ids, valid_from_generation);
CREATE INDEX IF NOT EXISTS projection_occurrences_source_record_idx ON projection_occurrences(workspace_id, source_record_ids, valid_from_generation);
CREATE TABLE IF NOT EXISTS projection_occurrence_dependencies (
  workspace_id TEXT NOT NULL,
  projection_record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('artifact_version', 'record', 'projection')),
  source_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, projection_record_id, valid_from_generation, source_type, source_id),
  FOREIGN KEY (workspace_id, projection_record_id, valid_from_generation) REFERENCES projection_occurrences(workspace_id, projection_record_id, valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS projection_occurrence_dependencies_reverse_idx ON projection_occurrence_dependencies(workspace_id, source_type, source_id, valid_from_generation);
CREATE TABLE IF NOT EXISTS projection_value_nodes (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  value_path TEXT NOT NULL,
  parent_path TEXT,
  sequence_ordinal INTEGER,
  map_key TEXT,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('null', 'boolean', 'integer', 'real', 'text', 'bytes', 'object', 'array')),
  text_value TEXT,
  integer_value INTEGER,
  real_value REAL,
  bool_value INTEGER,
  bytes_value BLOB,
  PRIMARY KEY (workspace_id, record_id, valid_from_generation, value_path)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS projection_value_nodes_parent_idx ON projection_value_nodes(workspace_id, record_id, valid_from_generation, parent_path, sequence_ordinal, map_key);
CREATE TABLE IF NOT EXISTS identity_assignments (
  identity_assignment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  assignment_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  identity_key_digest TEXT NOT NULL,
  record_id TEXT NOT NULL,
  previous_record_id TEXT,
  -- Derived from the immutable record occurrence in v3. Nullable only so
  -- direct low-level fixtures can still exercise historical row shapes;
  -- production publication leaves both fields NULL and never indexes them.
  owner_artifact_id TEXT,
  owner_artifact_version_id TEXT,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  PRIMARY KEY (workspace_id, identity_assignment_id, valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS identity_assignments_lookup_idx ON identity_assignments(workspace_id, identity_type, identity_id, valid_from_generation, valid_to_generation);
-- Serves currentlyVisibleForOwners's owner-narrowed assignment read
-- (packages/storage/src/repositories.ts): without an owner-led index that
-- query walks every one of the workspace's assignment rows PER PUBLISH
-- (measured: 1.3-1.7s of a ~4.5s edit rescan at 175k-record scale, hiding
-- under the scan's prior_state bucket), because identity_assignments_lookup_idx
-- leads with identity_type/identity_id and cannot narrow by owner. Safe to
-- create inline here (unlike vector_projection_document_ref_idx below):
-- every column named has been part of the base CREATE TABLE since the table
-- first shipped, so no pre-migration database can lack them.
-- Serves workspace-wide owner-migration identity lookups by exact key digest.
CREATE INDEX IF NOT EXISTS identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id);
-- Rust direct publication resolves the predecessor for only the changed
-- identity keys. Leading with the exact key and generation keeps that lookup
-- proportional to the affected owners instead of scanning the workspace's
-- complete assignment history on every incremental generation.
CREATE INDEX IF NOT EXISTS identity_assignments_owner_key_idx ON identity_assignments(workspace_id, identity_type, identity_key, valid_from_generation, valid_to_generation, record_id);
-- CanonicalOccurrenceRepository.currentlyVisible (packages/storage/src/repositories.ts)
-- joins record_occurrences to identity_assignments by (workspace_id, record_id),
-- plus a correlated subquery filtering the same pair with a valid_from_generation/
-- valid_to_generation range, to find each record's current open identity
-- assignment. Neither the primary key (workspace_id, identity_assignment_id,
-- valid_from_generation) nor the UNIQUE (workspace_id, identity_id, record_id,
-- valid_from_generation) constraint nor identity_assignments_lookup_idx above
-- has record_id as a searchable prefix, so without this index SQLite has no
-- way to satisfy either lookup except a full scan of every identity_assignments
-- row for the workspace, once per record_occurrences row -- an O(records *
-- assignments) nested-loop scan. On a workspace whose tables have accumulated
-- real size (tens of thousands of records, e.g. after a few full scans of a
-- real repository that were never garbage-collected), this makes every rescan
-- effectively never return: a single call pinning one CPU core doing native
-- SQLite work, with small/flat process RSS since nothing is materialized into
-- the JS heap, which looks indistinguishable from a hung/looping process. See
-- the final report for this change for a reproduction and measurement.
CREATE INDEX IF NOT EXISTS identity_assignments_record_idx ON identity_assignments(workspace_id, record_id, valid_from_generation, valid_to_generation);
