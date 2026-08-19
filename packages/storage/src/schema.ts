import { digestBytes } from "@urdira/canonical";
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
  database_path TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL,
  removed_at TEXT,
  workspace_payload BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS installation_model_pack_installations (
  model_pack_installation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  model_pack_id TEXT NOT NULL,
  model_pack_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  removed_at TEXT,
  removal_reason_code TEXT,
  installation_payload BLOB NOT NULL
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
  root_payload BLOB NOT NULL,
  PRIMARY KEY (root_kind, root_id, content_hash)
) STRICT;
`;

export const WORKSPACE_SCHEMA = `
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
  artifact_payload BLOB NOT NULL,
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
  observation_batch_payload BLOB NOT NULL,
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
  artifact_version_payload BLOB NOT NULL,
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
  artifact_tombstone_payload BLOB NOT NULL,
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
  observation_payload BLOB NOT NULL,
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
  payload_digest TEXT NOT NULL,
  payload_byte_length INTEGER NOT NULL CHECK (payload_byte_length >= 0),
  payload_inline BLOB,
  payload_cas_digest TEXT,
  record_payload BLOB NOT NULL,
  CHECK ((payload_inline IS NOT NULL AND payload_cas_digest IS NULL) OR (payload_inline IS NULL AND payload_cas_digest IS NOT NULL)),
  FOREIGN KEY (workspace_id, owner_artifact_id) REFERENCES source_artifacts(workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, primary_source_span_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS record_occurrences_owner_idx ON record_occurrences(owner_artifact_id, owner_artifact_version_id, valid_from_generation);
CREATE INDEX IF NOT EXISTS record_occurrences_visible_idx ON record_occurrences(workspace_id, valid_from_generation, valid_to_generation);
-- Serves currentlyVisibleForOwners's owner-narrowed record read
-- (packages/storage/src/repositories.ts). record_occurrences_owner_idx above
-- cannot: it does not lead with workspace_id, so the planner prefers
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
CREATE INDEX IF NOT EXISTS record_occurrences_workspace_owner_kind_idx ON record_occurrences(workspace_id, owner_artifact_id, category, kind, valid_from_generation, valid_to_generation);
CREATE TABLE IF NOT EXISTS registry_snapshots (
  registry_snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  registry_contract_version TEXT NOT NULL,
  core_registry_digest TEXT NOT NULL,
  resolution_lock_id TEXT NOT NULL,
  registry_digest TEXT NOT NULL UNIQUE,
  registry_payload BLOB NOT NULL,
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
  source_observation_watermarks TEXT NOT NULL,
  canonical_record_set_digest TEXT NOT NULL,
  projection_set_digests TEXT NOT NULL,
  capability_state_digest TEXT NOT NULL,
  published_at TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL UNIQUE,
  snapshot_payload BLOB NOT NULL,
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
  current_payload BLOB NOT NULL,
  FOREIGN KEY (workspace_id, current_snapshot_id) REFERENCES snapshots(workspace_id, snapshot_id),
  FOREIGN KEY (workspace_id, current_registry_snapshot_id) REFERENCES registry_snapshots(workspace_id, registry_snapshot_id)
) STRICT;
CREATE TABLE IF NOT EXISTS control_plane_state (
  state_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state_kind TEXT NOT NULL,
  payload BLOB NOT NULL,
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
  edge_payload BLOB NOT NULL,
  -- digestBytes(edge_payload), computed once at write time by every writer
  -- (WorkspaceProjectionRepository.putGraphEdge) instead of re-hashed by
  -- every projectionSetDigestEntries("stored") scan. Nullable so a
  -- pre-migration database can ALTER TABLE ... ADD COLUMN this in and
  -- backfill lazily (ensureWorkspaceSchemaCompatibility); a NULL here is a
  -- transient backfill state, never a legitimate steady-state value, and the
  -- "stored" read path falls back to hashing edge_payload for any row that
  -- still has one.
  content_digest TEXT,
  PRIMARY KEY (workspace_id, edge_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_edges_outbound_idx ON graph_edges(workspace_id, source_subject_id, valid_from_generation, edge_id);
CREATE INDEX IF NOT EXISTS graph_edges_inbound_idx ON graph_edges(workspace_id, target_subject_id, valid_from_generation, edge_id);
CREATE TABLE IF NOT EXISTS lexical_documents (
  artifact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  storage_reference TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  document_payload BLOB NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, artifact_id, artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
-- lexical_terms (per-token positional index) is retired: no reader ever
-- queried it, and search_text runs entirely off lexical_trigrams. These two
-- statements shed the table/index from databases created before this
-- change; nothing below ever recreates them.
DROP TABLE IF EXISTS lexical_terms;
DROP INDEX IF EXISTS lexical_terms_lookup_idx;
CREATE TABLE IF NOT EXISTS lexical_trigrams (
  workspace_id TEXT NOT NULL,
  trigram TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version_id TEXT NOT NULL,
  trigram_payload BLOB NOT NULL,
  PRIMARY KEY (workspace_id, trigram, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS lexical_trigrams_lookup_idx ON lexical_trigrams(workspace_id, trigram, artifact_id);
-- Marks the last generation for which the async post-ready lexical
-- maintenance job (documents + trigrams) fully caught up with
-- artifact_versions. Query pushdown for core:search_text only trusts the
-- trigram index when completed_generation equals the workspace's current
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
  dependency_payload BLOB NOT NULL,
  -- Same digestBytes(dependency_payload) precomputation as graph_edges.content_digest above; see that column's comment.
  content_digest TEXT,
  PRIMARY KEY (workspace_id, dependency_entry_id, valid_from_generation),
  FOREIGN KEY (workspace_id, owner_artifact_id, owner_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id),
  FOREIGN KEY (workspace_id, dependency_artifact_id, dependency_artifact_version_id) REFERENCES artifact_versions(workspace_id, artifact_id, artifact_version_id)
) STRICT;
CREATE INDEX IF NOT EXISTS artifact_dependencies_reverse_idx ON artifact_dependencies(workspace_id, dependency_artifact_id, dependency_artifact_version_id, valid_from_generation, dependency_entry_id);
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
  metric_payload BLOB NOT NULL,
  -- Same digestBytes(metric_payload) precomputation as graph_edges.content_digest above; see that column's comment.
  content_digest TEXT,
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
  created_at TEXT NOT NULL,
  shard_payload BLOB NOT NULL
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
  vector_payload BLOB NOT NULL,
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
  lease_payload BLOB NOT NULL,
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
  pin_payload BLOB NOT NULL,
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
  marker_payload BLOB NOT NULL,
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
  execution_status TEXT NOT NULL,
  execution_payload BLOB NOT NULL
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
  segment_payload BLOB NOT NULL,
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
  migration_payload BLOB NOT NULL,
  shadow_database_path TEXT,
  shadow_database_digest TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS lifecycle_roots (
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  root_payload BLOB NOT NULL,
  PRIMARY KEY (workspace_id, root_kind, root_id, content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS backup_barriers (
  backup_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  backup_payload BLOB NOT NULL
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
  epoch_payload BLOB NOT NULL
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
  candidate_payload BLOB NOT NULL,
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
  work_digest TEXT NOT NULL,
  work_manifest_payload BLOB NOT NULL,
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
  delta_payload BLOB NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, fact_delta_id),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_fact_deltas_recovery_idx ON candidate_fact_deltas(workspace_id, candidate_generation_id, accepted_at);
CREATE TABLE IF NOT EXISTS candidate_materializations (
  candidate_materialization_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT,
  materialization_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  materialization_payload BLOB NOT NULL,
  UNIQUE (workspace_id, materialization_digest),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_materializations_candidate_idx ON candidate_materializations(workspace_id, candidate_generation_id, sealed_at);
CREATE TABLE IF NOT EXISTS candidate_template_segments (
  workspace_id TEXT NOT NULL,
  candidate_materialization_id TEXT NOT NULL,
  set_kind TEXT NOT NULL,
  segment_ordinal INTEGER NOT NULL,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  first_ordinal INTEGER NOT NULL,
  last_ordinal INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  storage_reference TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (workspace_id, candidate_materialization_id, set_kind, segment_ordinal)
) STRICT;
CREATE INDEX IF NOT EXISTS candidate_template_segments_order_idx ON candidate_template_segments(workspace_id, candidate_materialization_id, set_kind, segment_ordinal);
CREATE TABLE IF NOT EXISTS candidate_issues (
  candidate_issue_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_generation_id TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  phase TEXT NOT NULL,
  severity TEXT NOT NULL,
  retryability TEXT NOT NULL,
  scope_payload BLOB NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  cause_references TEXT NOT NULL,
  payload BLOB NOT NULL,
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
  dependency_payload BLOB NOT NULL,
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
  lease_payload BLOB NOT NULL,
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
  root_payload BLOB NOT NULL,
  UNIQUE (workspace_id, candidate_generation_id, resource_type, content_digest),
  FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_cleanup_markers (
  candidate_generation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  state TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  marker_payload BLOB NOT NULL,
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
  journal_payload BLOB NOT NULL,
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
  manifest_payload BLOB NOT NULL,
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
  projection_payload BLOB NOT NULL,
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
  dependency_payload BLOB NOT NULL,
  PRIMARY KEY (workspace_id, projection_record_id, valid_from_generation, source_type, source_id),
  FOREIGN KEY (workspace_id, projection_record_id, valid_from_generation) REFERENCES projection_occurrences(workspace_id, projection_record_id, valid_from_generation)
) STRICT;
CREATE INDEX IF NOT EXISTS projection_occurrence_dependencies_reverse_idx ON projection_occurrence_dependencies(workspace_id, source_type, source_id, valid_from_generation);
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
  owner_artifact_id TEXT NOT NULL,
  owner_artifact_version_id TEXT NOT NULL,
  valid_from_generation INTEGER NOT NULL,
  valid_to_generation INTEGER,
  assignment_payload BLOB NOT NULL,
  PRIMARY KEY (workspace_id, identity_assignment_id, valid_from_generation),
  UNIQUE (workspace_id, identity_id, record_id, valid_from_generation)
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
CREATE INDEX IF NOT EXISTS identity_assignments_owner_idx ON identity_assignments(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation);
-- Serves workspace-wide owner-migration identity lookups by exact key digest.
CREATE INDEX IF NOT EXISTS identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id);
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
`;

export async function initializeSchema(database: SqliteDatabase, schema: string): Promise<void> {
  await database.exec(schema);
}

export async function ensureWorkspaceSchemaCompatibility(database: SqliteDatabase, faults?: FaultInjector): Promise<void> {
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
  await ensureProjectionContentDigests(database);
  await database.exec("CREATE INDEX IF NOT EXISTS identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id)");
  await ensureCandidateForeignKeys(database, faults);
}

// The three transactional projection tables `projectionSetDigestEntries`
// digests every publish (`packages/storage/src/lifecycle.ts`), each with its
// own row-id column but an otherwise identical `content_digest` story: a
// nullable `TEXT` column added by `ALTER TABLE` on a pre-migration database,
// backfilled from the still-present payload BLOB, then covered by an index
// that lets the "stored" read path answer `projectionSetDigestEntries`
// without visiting a payload page at all.
const PROJECTION_CONTENT_DIGEST_TABLES = [
  { table: "graph_edges", idColumn: "edge_id", payloadColumn: "edge_payload", index: "graph_edges_digest_scan_idx" },
  { table: "artifact_dependencies", idColumn: "dependency_entry_id", payloadColumn: "dependency_payload", index: "artifact_dependencies_digest_scan_idx" },
  { table: "metric_projections", idColumn: "metric_id", payloadColumn: "metric_payload", index: "metric_projections_digest_scan_idx" },
] as const;

async function ensureProjectionContentDigests(database: SqliteDatabase): Promise<void> {
  for (const { table, idColumn, payloadColumn, index } of PROJECTION_CONTENT_DIGEST_TABLES) {
    const columns = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "content_digest")) await database.exec(`ALTER TABLE ${table} ADD COLUMN content_digest TEXT`);
    await backfillProjectionContentDigests(database, table, idColumn, payloadColumn);
    // Covers exactly what `projectionSetDigestEntries("stored")` selects
    // (`packages/storage/src/lifecycle.ts`) -- id, generation validity, and
    // the digest itself -- so that scan is answered entirely from this
    // index, never touching a `${payloadColumn}` BLOB page. Created here
    // (after the column is guaranteed to exist) rather than inline in
    // `WORKSPACE_SCHEMA` above, because `initializeSchema` runs that raw
    // schema string unconditionally on every open, including a
    // pre-migration database that has not yet had `content_digest` added --
    // an index referencing that column would fail on such a database if it
    // lived there instead of here.
    await database.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(workspace_id, valid_from_generation, valid_to_generation, ${idColumn}, content_digest)`);
  }
}

function blobBytes(table: string, rowId: unknown, validFromGeneration: unknown, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("storage:invalid_blob", `${table} row ${String(rowId)}@${String(validFromGeneration)} has a non-binary payload during content_digest backfill.`);
}

/**
 * Idempotent and re-runnable: only rows whose `content_digest` is still NULL
 * are selected, so a crash mid-backfill (or simply re-opening an
 * already-backfilled database) finds nothing left to do. The digest recipe
 * -- `digestBytes` of the exact stored payload bytes -- is identical to the
 * one every write site now computes at insert time
 * (`WorkspaceProjectionRepository.putGraphEdge`/`putMetric`,
 * `artifactDependencyCommands` in `./publication-authority.js`) and the one
 * `projectionSetDigestEntries("recompute")` uses, so a backfilled column can
 * never disagree with a freshly recomputed hash of the same bytes.
 */
async function backfillProjectionContentDigests(database: SqliteDatabase, table: string, idColumn: string, payloadColumn: string): Promise<void> {
  const rows = await database.all<{ workspace_id: string; row_id: string; valid_from_generation: number; payload: unknown }>(`SELECT workspace_id, ${idColumn} AS row_id, valid_from_generation, ${payloadColumn} AS payload FROM ${table} WHERE content_digest IS NULL`);
  if (rows.length === 0) return;
  // The UPDATE's WHERE must lead with workspace_id: every index on these
  // tables (the PRIMARY KEY included) has it as the leading column, so an
  // update keyed by (idColumn, valid_from_generation) alone cannot use any
  // of them and degrades to one full table scan PER ROW -- quadratic over
  // the table, minutes of CPU on a real workspace during daemon startup.
  const commands: SqliteCommand[] = rows.map((row) => ({
    kind: "run" as const,
    sql: `UPDATE ${table} SET content_digest = ? WHERE workspace_id = ? AND ${idColumn} = ? AND valid_from_generation = ?`,
    params: [digestBytes(blobBytes(table, row.row_id, row.valid_from_generation, row.payload)), row.workspace_id, row.row_id, row.valid_from_generation],
  }));
  await database.transactionChunked(commands);
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
        work_digest TEXT NOT NULL, work_manifest_payload BLOB NOT NULL, UNIQUE (workspace_id, work_digest),
        FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
      ) STRICT`,
      columns: "work_manifest_id, workspace_id, candidate_generation_id, supersedes_work_manifest_id, base_snapshot_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, work_digest, work_manifest_payload",
    },
    {
      name: "candidate_fact_deltas",
      index: "candidate_fact_deltas_recovery_idx",
      create: `CREATE TABLE candidate_fact_deltas (
        fact_delta_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL,
        delta_digest TEXT NOT NULL, accepted_at TEXT NOT NULL, delta_payload BLOB NOT NULL,
        UNIQUE (workspace_id, candidate_generation_id, fact_delta_id),
        FOREIGN KEY (candidate_generation_id) REFERENCES candidate_state(candidate_generation_id)
      ) STRICT`,
      columns: "fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at, delta_payload",
    },
  ] as const;
  const rebuildCommands: SqliteCommand[] = [];
  for (const table of tables) {
    const foreignKeys = await database.all<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>(`PRAGMA foreign_key_list(${table.name})`);
    if (foreignKeys.length === 1 && foreignKeys[0]?.id === 0 && foreignKeys[0].seq === 0 && foreignKeys[0].table === "candidate_state" && foreignKeys[0].from === "candidate_generation_id" && foreignKeys[0].to === "candidate_generation_id" && foreignKeys[0].on_update === "NO ACTION" && foreignKeys[0].on_delete === "NO ACTION" && foreignKeys[0].match === "NONE") continue;
    const orphan = await database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name} AS child WHERE NOT EXISTS (SELECT 1 FROM candidate_state AS candidate WHERE candidate.candidate_generation_id = child.candidate_generation_id)`);
    if ((orphan?.count ?? 0) !== 0) throw new StorageError("storage:schema_migration_failed", `${table.name} contains orphaned candidate rows and cannot be rebuilt safely.`);
    const legacy = `${table.name}__legacy`;
    const rebuildSql = `DROP INDEX IF EXISTS ${table.index}; ALTER TABLE ${table.name} RENAME TO ${legacy}; ${table.create}; INSERT INTO ${table.name} (${table.columns}) SELECT ${table.columns} FROM ${legacy}; DROP TABLE ${legacy}; CREATE INDEX ${table.index} ON ${table.name}(workspace_id, candidate_generation_id, ${table.name === "candidate_work_manifests" ? "work_manifest_id" : "accepted_at"});`;
    rebuildCommands.push({ kind: "exec", sql: rebuildSql });
  }
  if (rebuildCommands.length > 0) await database.transaction([
    ...rebuildCommands,
    ...(faults?.isPending?.("migration.candidate_fk_rebuild") === true ? [{ kind: "fault" as const, boundary: "migration.candidate_fk_rebuild" }] : []),
  ]);
  const violations = await database.all<Record<string, unknown>>("PRAGMA foreign_key_check");
  if (violations.length > 0) throw new StorageError("storage:schema_migration_failed", "Candidate schema foreign-key validation failed after rebuild.");
}
