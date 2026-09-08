
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
-- Frente S-G (2026-09-08): `reconcileSemanticProjection`'s own ARTIFACT-grain
-- "missing rows" query (semantic-reconciler.ts) runs a `NOT EXISTS` against
-- this table correlated by `(workspace_id, owner_artifact_id,
-- owner_artifact_version_id)`, filtered further by `document_grain IS NULL`
-- (artifact rows only), `valid_to_generation IS NULL` (open rows only), and
-- `profile_id`/`executable_binding_id`. Neither index above leads with the
-- owner columns -- `vector_projection_visible_idx` leads with
-- `(workspace_id, profile_id, executable_binding_id, ...)`, so the
-- correlated subquery could only narrow to EVERY open row for the whole
-- vector space (all of it, once entity-grain embedding has run) and then
-- scan that entire set by hand for each of the ~20k outer artifact_versions
-- rows. Confirmed live via `EXPLAIN QUERY PLAN` at n8n scale (72,922 open
-- entity rows, 20,149 artifact_versions rows): `SEARCH vpr USING INDEX
-- vector_projection_visible_idx (workspace_id=?)` -- a correlated scalar
-- subquery re-scanning up to 72,922 rows per outer row, ~1.47 BILLION
-- comparisons total, the reconciler's OWN full artifact pass never observed
-- completing within any prior frente's own measurement (S-C through S-F)
-- because entity-grain work always dominated or crashed first -- this cost
-- was real but had never been reached before. This new index leads with the
-- exact correlated columns instead, turning that same subquery into one
-- indexed point lookup per outer row (`SEARCH ... USING INDEX
-- vector_projection_by_owner_idx (workspace_id=? AND owner_artifact_id=? AND
-- owner_artifact_version_id=? AND document_grain=?)`, confirmed via
-- `EXPLAIN QUERY PLAN` -- no more full-vector-space rescans). Safe to create
-- here (unlike the v3 catalog's own identical copy, moved to
-- `ensureWorkspaceSchemaCompatibility` in packages/storage/src/schema.ts):
-- this sidecar's `vector_projection_rows.document_grain` column has been
-- part of the base `CREATE TABLE` since this file's very first version
-- (decision 17 was designed into v4 from P2-1 onward) -- there is no legacy
-- v4 sidecar predating it the way v3's catalog has one predating its own
-- later `ALTER TABLE ... ADD COLUMN document_grain` migration.
CREATE INDEX IF NOT EXISTS vector_projection_by_owner_idx ON vector_projection_rows(workspace_id, owner_artifact_id, owner_artifact_version_id, document_grain, valid_to_generation, profile_id, executable_binding_id);
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
