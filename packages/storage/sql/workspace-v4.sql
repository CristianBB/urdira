
-- v4 workspace catalog schema (P2-1, plan §3). This is the SQLite catalog
-- file only: workspace_meta, the source catalog (source_artifacts,
-- content_blobs, source_observation_batches, source_observations,
-- artifact_versions, artifact_tombstones, source_index_state), snapshots,
-- workspace_current_state, control_plane_state, registry tables,
-- generation_manifests, the candidate lifecycle tables verify/repair/
-- collect actually use, and merkle_roots. Structural data (records,
-- edges, dependencies, metrics, and every candidate-materialization
-- staging table that produced them in v3) has no SQL representation here
-- at all -- it lives in the native segment store under structural/ (Path N,
-- plan §2) or, under the Path S fallback, in its own §2.7 DDL. Lexical and
-- semantic data move to sidecar files: workspace-v4-lexical.sql and
-- workspace-v4-semantic.sql. See docs/evidence/2026-09-02-v4-p2-1-schema.md
-- for the table-by-table keep/move/drop decision.
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
  -- v4 addition (P2-1): ordinal into the native structural store's
  -- artifacts.dict (structural/dict/, see the v4 design doc's §2.2). NULL
  -- until the Rust cold/incremental pipeline assigns one; catalog ids stay
  -- TEXT (see the v4 schema doc), this column only lets the native reader
  -- translate a TEXT artifact_version_id to its dictionary ordinal without a
  -- second lookup table.
  artifact_ordinal INTEGER,
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
-- v4 addition (P2-1, plan §3/§8): historical Merkle roots for the four
-- structural sets (records, graph, dependency, metric). The trees
-- themselves live in structural/merkle/<set>.tree (native store) or are
-- recomputed from record_occurrences/graph_edges/etc. under Path S (§2.7);
-- this table is the durable, queryable authority snapshots.canonical_record_set_digest
-- and projection_set_digests are checked against, and what lifecycle
-- verification compares a from-scratch recomputation to.
CREATE TABLE IF NOT EXISTS merkle_roots (
  set_kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  root BLOB NOT NULL,
  member_count INTEGER NOT NULL,
  PRIMARY KEY (set_kind, generation)
) STRICT;
