#![forbid(unsafe_code)]

use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::{self, Write as _};
use std::fs;
use std::fs::{File, OpenOptions, remove_file};
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;
use urdira_native_core::structural_kernel_batch;
pub use urdira_native_core::{
    MAX_BATCH_FRAMED_BYTES, MAX_BATCH_RECORDS, StructuralKernelBatch,
    StructuralKernelCanonicalBatch, StructuralKernelDependency, StructuralKernelRecord,
    StructuralKernelResult, StructuralPublicationRecord, structural_kernel_batch_parts,
    structural_kernel_canonical_batch, structural_kernel_canonical_batch_parts,
    structural_kernel_canonical_batch_parts_with_records,
};
use urdira_worker_protocol::AuthoritativeChangeSet;

pub const CORE_PROTOCOL_VERSION: u16 = 1;
pub const MAX_GROUP_OWNERS: usize = 64;
pub const MAX_GROUP_ROWS: usize = 4_096;
pub const MAX_GROUP_BYTES: usize = 16 * 1024 * 1024;
mod workspace_v3_sql;
pub use workspace_v3_sql::WORKSPACE_V3_SCHEMA_DIGEST;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError(pub String);

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CoreError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EngineDescriptor {
    pub engine_id: String,
    pub engine_version: String,
    pub implementation_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GenerationRequest {
    pub operation_id: String,
    pub workspace_id: String,
    pub candidate_generation_id: String,
    /// Private sidecar observed at every cancellation checkpoint. It lets a
    /// synchronous worker observe an abort without duplicating the writer or
    /// introducing a second command loop.
    #[serde(default)]
    pub cancellation_path: Option<PathBuf>,
    /// When enabled, final v3 rows are selected directly from the core-owned
    /// TEMP relation and the durable candidate payload tables stay metadata-
    /// only. This is private to the composition worker cutover.
    #[serde(default)]
    pub direct_publication: bool,
    pub source_snapshot_id: String,
    /// Immutable content-addressed source root captured by the host before
    /// handing the generation to Rust. Engines may resolve source blobs only
    /// through this explicit coordinate; they must not inspect a checkout.
    pub cas_root: String,
    pub source_state_digest: String,
    pub base_generation: u64,
    pub registry_snapshot_id: String,
    pub configuration_revision_id: String,
    pub resolution_lock_id: String,
    #[serde(default)]
    pub workspace_schema_digest: Option<String>,
    pub change_set: AuthoritativeChangeSet,
    /// Generic candidate lifecycle metadata persisted by the core writer.
    #[serde(default)]
    pub candidate: Option<Value>,
    #[serde(default)]
    pub frozen_base: Option<Value>,
    #[serde(default)]
    pub work_manifest: Option<Value>,
    pub engine: EngineDescriptor,
    pub deadline_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OwnerObservation {
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub owner_path: String,
    /// Private staging lane. Syntax and semantic observations for one owner
    /// may share the same per-lane cursor sequence in a combined generation;
    /// the lane keeps those receipts independent without changing public v3
    /// rows or their ordering.
    #[serde(default = "default_observation_lane")]
    pub lane: String,
    pub sequence: u64,
    pub final_batch: bool,
    pub records: Vec<StructuralKernelRecord>,
    pub dependencies: Vec<StructuralKernelDependency>,
    pub byte_length: usize,
    pub owner_digest: String,
    /// The producer's stable FactDelta id, when available. Rust reuses it
    /// during publication so replay does not allocate a parallel namespace.
    #[serde(default)]
    pub fact_delta_id: Option<String>,
    /// Producer delta digest used for the durable acceptance receipt.
    #[serde(default)]
    pub delta_digest: Option<String>,
}

impl OwnerObservation {
    pub fn batch(&self) -> StructuralKernelBatch {
        StructuralKernelBatch {
            records: self.records.clone(),
            dependencies: self.dependencies.clone(),
        }
    }
    fn rows(&self) -> usize {
        self.records.len() + self.dependencies.len()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PhysicalGroup {
    pub group_sequence: u64,
    pub owners: Vec<OwnerObservation>,
}

/// Canonical wire form emitted by a language engine after UCE/ID sealing. It
/// avoids sending a second nested object graph through the worker boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalOwnerObservation {
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub owner_path: String,
    /// Same private lane marker as `OwnerObservation`; omitted wire payloads
    /// use the neutral structural lane for generic language engines.
    #[serde(default = "default_observation_lane")]
    pub lane: String,
    pub sequence: u64,
    pub final_batch: bool,
    pub canonical_records: Vec<String>,
    pub canonical_dependencies: Vec<String>,
    pub byte_length: usize,
    pub owner_digest: String,
    /// Stable producer FactDelta identity, when the language engine already
    /// assigned one. Keeping it on the canonical wire form lets publication
    /// reuse the exact receipt namespace instead of minting a synthetic id.
    #[serde(default)]
    pub fact_delta_id: Option<String>,
    #[serde(default)]
    pub delta_digest: Option<String>,
    /// Language-engine diagnostic codes used only while Rust reconstructs the
    /// producer receipt digest. They never enter the public SQLite schema.
    #[serde(default)]
    pub diagnostic_codes: Vec<String>,
}

fn default_observation_lane() -> String {
    "structural".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalPhysicalGroup {
    pub group_sequence: u64,
    pub owners: Vec<CanonicalOwnerObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GroupReceipt {
    pub operation_id: String,
    pub candidate_generation_id: String,
    pub group_sequence: u64,
    pub owner_count: usize,
    pub row_count: usize,
    pub byte_length: usize,
    pub group_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GenerationDescriptor {
    pub operation_id: String,
    pub candidate_generation_id: String,
    pub group_count: usize,
    pub owner_count: usize,
    pub row_count: usize,
    pub byte_length: usize,
    pub ordered_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GroupAcceptance {
    Inserted(GroupReceipt),
    AlreadyAccepted(GroupReceipt),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProgressEvent {
    pub operation_id: String,
    pub phase: String,
    pub completed_groups: usize,
    pub completed_owners: usize,
    pub completed_rows: usize,
}

/// Immutable source coordinate read by a language engine from the workspace
/// catalog.  The core deliberately exposes no language-specific fields or
/// decoded bytes: engines select their own paths and read verified CAS blobs
/// using these coordinates while the application process remains out of the
/// structural input loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentSourceArtifact {
    pub artifact_id: String,
    pub artifact_version_id: String,
    pub path: String,
    pub content_hash: String,
    pub byte_length: usize,
}

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    /// Shares the same cancellation flag with an engine API that accepts an
    /// `&AtomicBool` instead of the core token wrapper.
    pub fn atomic(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}

pub trait LanguageEngine {
    fn describe(&self) -> Result<EngineDescriptor, CoreError>;
    fn prepare(
        &mut self,
        request: &GenerationRequest,
        cancellation: &CancellationToken,
    ) -> Result<Vec<String>, CoreError>;
    fn analyze_group(
        &mut self,
        owners: &[String],
        cancellation: &CancellationToken,
    ) -> Result<PhysicalGroup, CoreError>;
    fn acknowledge(&mut self, descriptor: &GenerationDescriptor) -> Result<(), CoreError>;
    fn cancel(&mut self) -> Result<(), CoreError>;
    fn shutdown(&mut self) -> Result<(), CoreError>;
}

pub trait PublicationSink {
    fn publish(
        &mut self,
        transaction: &Transaction<'_>,
        request: &GenerationRequest,
        descriptor: &GenerationDescriptor,
    ) -> Result<(), CoreError>;
}

/// Generic v3 candidate sink owned by the indexing core. Language engines
/// only emit `StructuralKernelRecord`/`StructuralKernelDependency`; this sink
/// performs the receipt namespace, typed staging and candidate relation
/// promotion for every language without a TypeScript-shaped writer.
pub struct CandidatePublicationSink;

impl PublicationSink for CandidatePublicationSink {
    fn publish(
        &mut self,
        transaction: &Transaction<'_>,
        request: &GenerationRequest,
        descriptor: &GenerationDescriptor,
    ) -> Result<(), CoreError> {
        let promotion_started = Instant::now();
        let generation_fact_delta_id = format!("fact-delta:{}", request.operation_id);
        let accepted_at = request.operation_id.as_str();
        transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                (&generation_fact_delta_id, &request.workspace_id, &request.candidate_generation_id, &descriptor.ordered_digest, accepted_at),
            )
            .map_err(sql_error)?;
        let namespace_changes = transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_delta_namespaces (workspace_id, candidate_generation_id, fact_delta_id, producer_id, producer_version, analysis_digest, analysis_configuration_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (&request.workspace_id, &request.candidate_generation_id, &generation_fact_delta_id, &request.engine.engine_id, &request.engine.engine_version, &descriptor.ordered_digest, &request.configuration_revision_id),
            )
            .map_err(sql_error)?;
        if namespace_changes > 1 {
            return Err(CoreError(
                "candidate FactDelta namespace changes assertion failed".into(),
            ));
        }

        // Owner receipts are projected set-wise from the bounded TEMP relation.
        // This preserves the idempotent namespace/digest checks while removing
        // one Rust/SQLite round trip per owner from the publication critical
        // path (the former loop was 512+ queries on the admission corpus).
        let conflicting_receipt: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM urdira_core_owner_stage AS s JOIN candidate_fact_deltas AS d ON d.workspace_id = ?1 AND d.candidate_generation_id = ?2 AND d.fact_delta_id = COALESCE(s.fact_delta_id, ?3 || ':' || s.owner_artifact_id || ':' || s.observation_lane || ':' || s.sequence) WHERE s.operation_id = ?4 AND s.candidate_generation_id = ?2 AND d.delta_digest <> COALESCE(s.delta_digest, s.owner_digest) AND NOT EXISTS (SELECT 1 FROM candidate_fact_delta_namespaces AS n WHERE n.workspace_id = ?1 AND n.candidate_generation_id = ?2 AND n.fact_delta_id = d.fact_delta_id AND n.owner_artifact_id = s.owner_artifact_id AND n.owner_artifact_version_id = s.owner_artifact_version_id))",
                params![&request.workspace_id, &request.candidate_generation_id, &generation_fact_delta_id, &request.operation_id],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if conflicting_receipt {
            return Err(CoreError(
                "candidate owner receipt digest conflicts with an existing receipt".into(),
            ));
        }
        let expected_owner_receipts: i64 = transaction
            .query_row(
                "SELECT COUNT(DISTINCT COALESCE(fact_delta_id, ?1 || ':' || owner_artifact_id || ':' || observation_lane || ':' || sequence)) FROM urdira_core_owner_stage WHERE operation_id = ?2 AND candidate_generation_id = ?3",
                params![&generation_fact_delta_id, &request.operation_id, &request.candidate_generation_id],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        let namespace_owner_changes = transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_delta_namespaces (workspace_id, candidate_generation_id, fact_delta_id, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, analysis_digest, analysis_configuration_digest) SELECT ?1, ?2, COALESCE(fact_delta_id, ?3 || ':' || owner_artifact_id || ':' || observation_lane || ':' || sequence), ?4, ?5, owner_artifact_id, owner_artifact_version_id, owner_digest, ?6 FROM urdira_core_owner_stage WHERE operation_id = ?7 AND candidate_generation_id = ?2",
                params![&request.workspace_id, &request.candidate_generation_id, &generation_fact_delta_id, &request.engine.engine_id, &request.engine.engine_version, &request.configuration_revision_id, &request.operation_id],
            )
            .map_err(sql_error)?;
        if namespace_owner_changes > usize::try_from(expected_owner_receipts).unwrap_or(usize::MAX)
        {
            return Err(CoreError(
                "candidate owner namespace changes assertion failed".into(),
            ));
        }
        let batch_owner_changes = transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_delta_batches (workspace_id, candidate_generation_id, fact_delta_id, sequence, byte_length, is_final, accepted_at) SELECT ?1, ?2, COALESCE(fact_delta_id, ?3 || ':' || owner_artifact_id || ':' || observation_lane || ':' || sequence), 0, byte_length, 1, ?4 FROM urdira_core_owner_stage WHERE operation_id = ?5 AND candidate_generation_id = ?2",
                params![&request.workspace_id, &request.candidate_generation_id, &generation_fact_delta_id, accepted_at, &request.operation_id],
            )
            .map_err(sql_error)?;
        if batch_owner_changes > usize::try_from(expected_owner_receipts).unwrap_or(usize::MAX) {
            return Err(CoreError(
                "candidate owner batch changes assertion failed".into(),
            ));
        }
        let delta_owner_changes = transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_deltas (fact_delta_id, workspace_id, candidate_generation_id, delta_digest, accepted_at) SELECT COALESCE(fact_delta_id, ?1 || ':' || owner_artifact_id || ':' || observation_lane || ':' || sequence), ?2, ?3, COALESCE(delta_digest, owner_digest), ?4 FROM urdira_core_owner_stage WHERE operation_id = ?5 AND candidate_generation_id = ?3",
                params![&generation_fact_delta_id, &request.workspace_id, &request.candidate_generation_id, accepted_at, &request.operation_id],
            )
            .map_err(sql_error)?;
        if delta_owner_changes > usize::try_from(expected_owner_receipts).unwrap_or(usize::MAX) {
            return Err(CoreError(
                "candidate owner delta changes assertion failed".into(),
            ));
        }
        let promote_started = Instant::now();
        let promotion = if request.direct_publication {
            promote_direct_publication_metadata(transaction, request)
        } else {
            promote_candidate_publication_rows(transaction, request)
        };
        promotion.map_err(|error| {
            CoreError(format!("candidate publication promotion failed: {error}"))
        })?;
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-core] promotion ms={}",
                promote_started.elapsed().as_millis()
            );
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_fact_delta_batches (workspace_id, candidate_generation_id, fact_delta_id, sequence, byte_length, is_final, accepted_at) VALUES (?1, ?2, ?3, 0, ?4, 1, ?5)",
                (&request.workspace_id, &request.candidate_generation_id, &generation_fact_delta_id, descriptor.byte_length as i64, accepted_at),
            )
            .map_err(sql_error)?;
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-core] candidate sink publish ms={}",
                promotion_started.elapsed().as_millis()
            );
        }
        Ok(())
    }
}

/// Closes stale durable records and identity predecessors for a direct
/// publication generation. Exposed as a module constant (rather than an
/// inline literal inside `promote_direct_publication_metadata`) so the
/// regression test below can run `EXPLAIN QUERY PLAN` against the exact
/// production text instead of a copy that could silently drift.
///
/// PERFORMANCE INVARIANT: the two `NOT EXISTS` subqueries against the
/// TEMP `urdira_core_owner_rows` relation (aliased `p`) MUST compare the
/// bare `p.publication_record_id` BLOB column against a value decoded from
/// the correlated durable `record_id` (`unhex(substr(<record_id>, 8))`) --
/// never the reverse. `urdira_core_owner_rows_record_id` is a covering
/// index on `(lane, publication_record_id)`; wrapping `p.publication_record_id`
/// itself in `hex()`/`||` (as an earlier revision of the TEMP-staging digest
/// diet did) makes that comparison non-sargable, so SQLite can only use the
/// index's `lane=?` prefix and must linearly rescan every staged row of the
/// generation for EACH outer `stale`/`predecessors` row -- an O(stale_rows *
/// staged_rows) blow-up that stayed invisible on a cold generation (where
/// `stale`/`predecessors` are empty because there is no prior durable state)
/// and only showed up on an incremental publish against a populated
/// workspace (see docs/evidence -- one mutation on the n8n corpus regressed
/// from ~17s to ~163s). Decoding the *outer*, once-per-row value back into a
/// BLOB instead keeps `p.publication_record_id` bare, so the subquery can
/// SEARCH the composite index directly (`lane=? AND publication_record_id=?`).
const DIRECT_PUBLICATION_CLOSURES_SQL: &str = "WITH owner_keys AS (SELECT DISTINCT identity_type, identity_key FROM urdira_core_owner_rows WHERE lane = 'records' AND identity_type IS NOT NULL AND identity_key IS NOT NULL), previous_generation AS (SELECT ia.identity_type, ia.identity_key, MAX(ia.valid_from_generation) AS valid_from_generation FROM identity_assignments AS ia INDEXED BY identity_assignments_owner_key_idx JOIN owner_keys k ON k.identity_type = ia.identity_type AND k.identity_key = ia.identity_key WHERE ia.workspace_id = ?3 AND ia.valid_from_generation <= ?4 AND (ia.valid_to_generation IS NULL OR ia.valid_to_generation > ?4) GROUP BY ia.identity_type, ia.identity_key), previous AS (SELECT ia.identity_type, ia.identity_key, ia.record_id FROM identity_assignments AS ia INDEXED BY identity_assignments_owner_key_idx JOIN previous_generation p ON p.identity_type = ia.identity_type AND p.identity_key = ia.identity_key AND p.valid_from_generation = ia.valid_from_generation WHERE ia.workspace_id = ?3), stale AS (SELECT DISTINCT r.record_id FROM urdira_core_owner_stage s JOIN record_occurrences r ON r.workspace_id = ?3 AND r.owner_artifact_id = s.owner_artifact_id WHERE s.operation_id = ?1 AND s.candidate_generation_id = ?2 AND r.valid_from_generation <= ?5 AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?5) AND NOT EXISTS (SELECT 1 FROM urdira_core_owner_rows p WHERE p.lane = 'records' AND p.publication_record_id = unhex(substr(r.record_id, 8)))), predecessors AS (SELECT DISTINCT previous.record_id FROM urdira_core_owner_rows o JOIN previous ON previous.identity_type = o.identity_type AND previous.identity_key = o.identity_key WHERE o.lane = 'records' AND previous.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM urdira_core_owner_rows p WHERE p.lane = 'records' AND p.publication_record_id = unhex(substr(previous.record_id, 8)))), closure AS (SELECT record_id FROM stale UNION SELECT record_id FROM predecessors), ordered AS (SELECT record_id, ROW_NUMBER() OVER (ORDER BY record_id) - 1 AS row_ordinal FROM closure) INSERT OR IGNORE INTO candidate_publication_record_closures (candidate_generation_id, row_ordinal, workspace_id, record_id, valid_to_generation) SELECT ?2, row_ordinal, ?3, record_id, ?5 FROM ordered";

fn promote_candidate_publication_rows(
    transaction: &Transaction<'_>,
    request: &GenerationRequest,
) -> Result<(), CoreError> {
    // Materialize the deterministic publication order once for this
    // transaction. The three projections below share the same order and
    // should not each sort/window the full owner-row relation.
    transaction
        .execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS urdira_core_publication_order (owner_rowid INTEGER PRIMARY KEY, row_ordinal_order INTEGER NOT NULL); DELETE FROM urdira_core_publication_order;",
        )
        .map_err(sql_error)?;
    transaction
        .execute(
            "INSERT INTO urdira_core_publication_order (owner_rowid, row_ordinal_order) SELECT rowid, ROW_NUMBER() OVER (ORDER BY publication_record_id, owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal) - 1 FROM urdira_core_owner_rows WHERE lane = 'records'",
            (),
        )
        .map_err(sql_error)?;
    for table in [
        "candidate_publication_record_occurrences",
        "candidate_publication_record_facets",
        "candidate_publication_identity_assignments",
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE candidate_generation_id = ?1"),
                [&request.candidate_generation_id],
            )
            .map_err(sql_error)?;
    }
    let generation = descriptor_generation(request);
    // Promote all sealed rows set-wise. The temporary relation already holds
    // canonical JSON and the producer-sealed publication envelope, so SQLite
    // can project the typed candidate tables without a per-row Rust decode or
    // execute. This removes the hot-path V8/serde/SQLite callback fan-out while
    // preserving the exact deterministic ordering used by the previous loop.
    transaction
        .execute(
            "INSERT INTO candidate_publication_record_occurrences (candidate_generation_id, row_ordinal, record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT ?1, publication_order.row_ordinal_order, 'record:' || lower(hex(ordered.publication_record_id)), ?2, ordered.record_category, ordered.record_kind, ordered.record_universal_kind, ordered.record_schema_version, 'candidate', '1', ordered.owner_artifact_id, ordered.owner_artifact_version_id, ordered.primary_source_span_artifact_version_id, ordered.primary_source_span_start_byte, ordered.primary_source_span_end_byte, ordered.primary_source_span_start_line, ordered.primary_source_span_end_line, ?3, 'sha256:' || lower(hex(ordered.record_digest)), 'sha256:' || lower(hex(ordered.body_digest)), ordered.body_byte_length, ordered.body_payload_hex, ?3, ?3, ?3 FROM urdira_core_owner_rows AS ordered JOIN urdira_core_publication_order AS publication_order ON publication_order.owner_rowid = ordered.rowid WHERE ordered.lane = 'records'",
            params![&request.candidate_generation_id, &request.workspace_id, generation],
        )
        .map_err(sql_error)?;
    transaction
        .execute(
            "INSERT INTO candidate_publication_record_facets (candidate_generation_id, row_ordinal, workspace_id, record_id, valid_from_generation, facet_ordinal, facet) SELECT ?1, publication_order.row_ordinal_order * 4096 + facets.facet_ordinal, ?2, 'record:' || lower(hex(ordered.publication_record_id)), ?3, facets.facet_ordinal, facets.facet FROM urdira_core_owner_rows AS ordered JOIN urdira_core_publication_order AS publication_order ON publication_order.owner_rowid = ordered.rowid JOIN urdira_core_owner_facets AS facets ON facets.owner_artifact_id = ordered.owner_artifact_id AND facets.owner_artifact_version_id = ordered.owner_artifact_version_id AND facets.observation_lane = ordered.observation_lane AND facets.sequence = ordered.sequence AND facets.row_ordinal = ordered.row_ordinal WHERE ordered.lane = 'records'",
            params![&request.candidate_generation_id, &request.workspace_id, generation],
        )
        .map_err(sql_error)?;
    transaction
        .execute(
            "WITH previous AS (SELECT identity_type, identity_key, record_id, ROW_NUMBER() OVER (PARTITION BY identity_type, identity_key ORDER BY valid_from_generation DESC) AS previous_order FROM identity_assignments WHERE workspace_id = ?2 AND valid_from_generation <= ?3 AND (valid_to_generation IS NULL OR valid_to_generation > ?3)) INSERT INTO candidate_publication_identity_assignments (candidate_generation_id, row_ordinal, identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, valid_from_generation) SELECT ?1, publication_order.row_ordinal_order, 'sha256:' || lower(hex(ordered.identity_assignment_id)), ?2, ordered.identity_type, ordered.identity_type || ':' || lower(hex(ordered.identity_id)), CASE WHEN previous.record_id IS NULL THEN 'created' ELSE 'continued' END, ordered.identity_key, 'sha256:' || lower(hex(ordered.identity_key_digest)), 'record:' || lower(hex(ordered.publication_record_id)), previous.record_id, ?3 FROM urdira_core_owner_rows AS ordered JOIN urdira_core_publication_order AS publication_order ON publication_order.owner_rowid = ordered.rowid LEFT JOIN previous ON previous.identity_type = ordered.identity_type AND previous.identity_key = ordered.identity_key AND previous.previous_order = 1 WHERE ordered.lane = 'records'",
            params![&request.candidate_generation_id, &request.workspace_id, generation],
        )
        .map_err(sql_error)?;
    let record_count: usize = transaction
        .query_row(
            "SELECT COUNT(*) FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1",
            [&request.candidate_generation_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?
        .try_into()
        .map_err(|_| CoreError("candidate publication record count overflow".into()))?;
    // Close stale records and identity predecessors in one relational
    // projection. The old implementation walked both sets through Rust and
    // issued one SQLite statement per row; at n8n scale that recreated the
    // owner callback fan-out that the Rust cutover is intended to remove.
    transaction
        .execute(
            "WITH stale AS (SELECT DISTINCT r.record_id FROM urdira_core_owner_stage s JOIN record_occurrences r ON r.workspace_id = ?3 AND r.owner_artifact_id = s.owner_artifact_id WHERE s.operation_id = ?1 AND s.candidate_generation_id = ?2 AND r.valid_from_generation <= ?4 AND (r.valid_to_generation IS NULL OR r.valid_to_generation > ?4) AND NOT EXISTS (SELECT 1 FROM candidate_publication_record_occurrences p WHERE p.candidate_generation_id = ?2 AND p.record_id = r.record_id)), predecessors AS (SELECT DISTINCT previous_record_id AS record_id FROM candidate_publication_identity_assignments WHERE candidate_generation_id = ?2 AND previous_record_id IS NOT NULL), closure AS (SELECT record_id FROM stale UNION SELECT record_id FROM predecessors), ordered AS (SELECT record_id, ROW_NUMBER() OVER (ORDER BY record_id) - 1 AS row_ordinal FROM closure) INSERT OR IGNORE INTO candidate_publication_record_closures (candidate_generation_id, row_ordinal, workspace_id, record_id, valid_to_generation) SELECT ?2, row_ordinal, ?3, record_id, ?5 FROM ordered",
            params![
                &request.operation_id,
                &request.candidate_generation_id,
                &request.workspace_id,
                request.base_generation,
                generation
            ],
        )
        .map_err(sql_error)?;
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-core] promotion rows={} stage={}",
            record_count, request.candidate_generation_id
        );
    }
    transaction
        .execute(
            "INSERT INTO candidate_publication_descriptors (candidate_generation_id, workspace_id, record_count, facet_count, identity_count, canonical_byte_length, first_record_id, last_record_id, record_sequence_digest, identity_sequence_digest, sealed_at) VALUES (?1, ?2, (SELECT COUNT(*) FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1), (SELECT COUNT(*) FROM candidate_publication_record_facets WHERE candidate_generation_id = ?1), (SELECT COUNT(*) FROM candidate_publication_identity_assignments WHERE candidate_generation_id = ?1), (SELECT COALESCE(SUM(body_byte_length), 0) FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1), (SELECT record_id FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1 ORDER BY row_ordinal LIMIT 1), (SELECT record_id FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1 ORDER BY row_ordinal DESC LIMIT 1), 'rust:pending', 'rust:pending', ?4) ON CONFLICT(candidate_generation_id) DO UPDATE SET workspace_id = excluded.workspace_id, record_count = excluded.record_count, facet_count = excluded.facet_count, identity_count = excluded.identity_count, canonical_byte_length = excluded.canonical_byte_length, first_record_id = excluded.first_record_id, last_record_id = excluded.last_record_id, record_sequence_digest = excluded.record_sequence_digest, identity_sequence_digest = excluded.identity_sequence_digest, sealed_at = excluded.sealed_at WHERE candidate_publication_descriptors.workspace_id = excluded.workspace_id AND candidate_publication_descriptors.record_count = excluded.record_count AND candidate_publication_descriptors.facet_count = excluded.facet_count AND candidate_publication_descriptors.identity_count = excluded.identity_count AND candidate_publication_descriptors.canonical_byte_length = excluded.canonical_byte_length AND candidate_publication_descriptors.first_record_id IS excluded.first_record_id AND candidate_publication_descriptors.last_record_id IS excluded.last_record_id AND candidate_publication_descriptors.record_sequence_digest = excluded.record_sequence_digest AND candidate_publication_descriptors.identity_sequence_digest = excluded.identity_sequence_digest",
            params![&request.candidate_generation_id, &request.workspace_id, record_count as i64, &request.operation_id],
        )
        .map_err(sql_error)?;
    transaction
        .execute(
            "INSERT INTO candidate_publication_projection_descriptors (candidate_generation_id, workspace_id, projection_count, dependency_count, value_node_count, first_projection_record_id, last_projection_record_id, projection_sequence_digest, sealed_at) VALUES (?1, ?2, 0, 0, 0, NULL, NULL, 'rust:empty', ?3) ON CONFLICT(candidate_generation_id) DO UPDATE SET workspace_id = excluded.workspace_id, projection_count = excluded.projection_count, dependency_count = excluded.dependency_count, value_node_count = excluded.value_node_count, first_projection_record_id = excluded.first_projection_record_id, last_projection_record_id = excluded.last_projection_record_id, projection_sequence_digest = excluded.projection_sequence_digest, sealed_at = excluded.sealed_at WHERE candidate_publication_projection_descriptors.workspace_id = excluded.workspace_id AND candidate_publication_projection_descriptors.projection_count = 0 AND candidate_publication_projection_descriptors.dependency_count = 0 AND candidate_publication_projection_descriptors.value_node_count = 0 AND candidate_publication_projection_descriptors.first_projection_record_id IS NULL AND candidate_publication_projection_descriptors.last_projection_record_id IS NULL AND candidate_publication_projection_descriptors.projection_sequence_digest = 'rust:empty'",
            params![&request.candidate_generation_id, &request.workspace_id, &request.operation_id],
        )
        .map_err(sql_error)?;
    Ok(())
}

/// Seal only the metadata needed by the Rust finalizer.  The canonical record
/// and facet bodies remain in the core-owned TEMP relations and are consumed
/// directly by the final publication transaction; this avoids copying every
/// structural BLOB through the durable candidate tables on the production
/// cutover path.
fn promote_direct_publication_metadata(
    transaction: &Transaction<'_>,
    request: &GenerationRequest,
) -> Result<(), CoreError> {
    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    // Direct publication does not materialise candidate bodies.  Do not build
    // the legacy publication-order TEMP relation either: the core owner-row
    // covering index already has the exact deterministic order required for
    // the descriptor endpoints, and the finalizer scans that same order once
    // when it inserts durable rows.
    let delete_started = Instant::now();
    for table in [
        "candidate_publication_record_occurrences",
        "candidate_publication_record_facets",
        "candidate_publication_identity_assignments",
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE candidate_generation_id = ?1"),
                [&request.candidate_generation_id],
            )
            .map_err(sql_error)?;
    }
    if debug_timing {
        eprintln!(
            "[urdira-indexing-core] promote_direct_publication_metadata candidate_delete_ms={}",
            delete_started.elapsed().as_millis()
        );
    }
    let generation = descriptor_generation(request);
    let closures_started = Instant::now();
    transaction
        .execute(
            DIRECT_PUBLICATION_CLOSURES_SQL,
            params![
                &request.operation_id,
                &request.candidate_generation_id,
                &request.workspace_id,
                request.base_generation,
                generation
            ],
        )
        .map_err(sql_error)?;
    if debug_timing {
        eprintln!(
            "[urdira-indexing-core] promote_direct_publication_metadata direct_publication_closures_ms={}",
            closures_started.elapsed().as_millis()
        );
    }
    let descriptor_upsert_started = Instant::now();
    transaction
        .execute(
            "INSERT INTO candidate_publication_descriptors (candidate_generation_id, workspace_id, record_count, facet_count, identity_count, canonical_byte_length, first_record_id, last_record_id, record_sequence_digest, identity_sequence_digest, sealed_at) VALUES (?1, ?2, COALESCE((SELECT record_count FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), 0), COALESCE((SELECT facet_count FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), 0), COALESCE((SELECT identity_count FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), 0), COALESCE((SELECT body_byte_length FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), 0), (SELECT first_record_id FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), (SELECT last_record_id FROM urdira_core_generation_stats WHERE operation_id = ?3 AND candidate_generation_id = ?1), 'rust:pending', 'rust:pending', ?4) ON CONFLICT(candidate_generation_id) DO UPDATE SET workspace_id = excluded.workspace_id, record_count = excluded.record_count, facet_count = excluded.facet_count, identity_count = excluded.identity_count, canonical_byte_length = excluded.canonical_byte_length, first_record_id = excluded.first_record_id, last_record_id = excluded.last_record_id, record_sequence_digest = excluded.record_sequence_digest, identity_sequence_digest = excluded.identity_sequence_digest, sealed_at = excluded.sealed_at WHERE candidate_publication_descriptors.workspace_id = excluded.workspace_id AND candidate_publication_descriptors.record_count = excluded.record_count AND candidate_publication_descriptors.facet_count = excluded.facet_count AND candidate_publication_descriptors.identity_count = excluded.identity_count AND candidate_publication_descriptors.canonical_byte_length = excluded.canonical_byte_length AND candidate_publication_descriptors.first_record_id IS excluded.first_record_id AND candidate_publication_descriptors.last_record_id IS excluded.last_record_id AND candidate_publication_descriptors.record_sequence_digest = excluded.record_sequence_digest AND candidate_publication_descriptors.identity_sequence_digest = excluded.identity_sequence_digest",
            params![
                &request.candidate_generation_id,
                &request.workspace_id,
                &request.operation_id,
                &request.operation_id
            ],
        )
        .map_err(sql_error)?;
    transaction
        .execute(
            "INSERT INTO candidate_publication_projection_descriptors (candidate_generation_id, workspace_id, projection_count, dependency_count, value_node_count, first_projection_record_id, last_projection_record_id, projection_sequence_digest, sealed_at) VALUES (?1, ?2, 0, 0, 0, NULL, NULL, 'rust:empty', ?3) ON CONFLICT(candidate_generation_id) DO UPDATE SET workspace_id = excluded.workspace_id, projection_count = 0, dependency_count = 0, value_node_count = 0, first_projection_record_id = NULL, last_projection_record_id = NULL, projection_sequence_digest = 'rust:empty', sealed_at = excluded.sealed_at WHERE candidate_publication_projection_descriptors.workspace_id = excluded.workspace_id AND candidate_publication_projection_descriptors.projection_count = 0 AND candidate_publication_projection_descriptors.dependency_count = 0 AND candidate_publication_projection_descriptors.value_node_count = 0 AND candidate_publication_projection_descriptors.first_projection_record_id IS NULL AND candidate_publication_projection_descriptors.last_projection_record_id IS NULL AND candidate_publication_projection_descriptors.projection_sequence_digest = 'rust:empty'",
            params![&request.candidate_generation_id, &request.workspace_id, &request.operation_id],
        )
        .map_err(sql_error)?;
    if debug_timing {
        eprintln!(
            "[urdira-indexing-core] promote_direct_publication_metadata descriptor_upsert_ms={}",
            descriptor_upsert_started.elapsed().as_millis()
        );
    }
    Ok(())
}

/// The secondary accelerator indexes over `record_occurrences`,
/// `identity_assignments` and `artifact_dependencies` that the incremental
/// publication path (`DIRECT_PUBLICATION_CLOSURES_SQL` and its downstream
/// promotion/dependency joins) depends on for indexed `SEARCH` plans instead
/// of full table scans. Mirrors the two index lists split across the cold
/// commit's inline recreation and the worker's detached secondary-index
/// rebuild (`urdira-indexing-worker/src/main.rs`); kept here purely for the
/// `URDIRA_DEBUG_TIMING` missing-index detector below, so it stays a single
/// source of truth even though it does not create anything itself.
const EXPECTED_INCREMENTAL_INDEXES: &[&str] = &[
    "record_occurrences_visible_idx",
    "record_occurrences_workspace_owner_idx",
    "record_occurrences_workspace_owner_version_idx",
    "record_occurrences_digest_order_idx",
    "identity_assignments_lookup_idx",
    "identity_assignments_key_idx",
    "identity_assignments_owner_key_idx",
    "identity_assignments_record_idx",
    "artifact_dependencies_reverse_idx",
    "artifact_dependencies_direct_idx",
];

/// Logs (under `URDIRA_DEBUG_TIMING`) which of `EXPECTED_INCREMENTAL_INDEXES`
/// are absent from the database at the moment an incremental (non
/// cold-direct) publish begins. A missing index here silently degrades
/// `DIRECT_PUBLICATION_CLOSURES_SQL` and the dependency-promotion joins from
/// an indexed `SEARCH` to a full `SCAN` of `record_occurrences` /
/// `identity_assignments` / `artifact_dependencies` -- the exact failure
/// mode that turned a routine edit's incremental publish into a 14s full
/// scan of 3.19M rows (docs/evidence/2026-09-01-f5-e3-cierre-tanda.md, A1).
fn debug_log_missing_incremental_indexes(connection: &Connection) {
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_none() {
        return;
    }
    let mut statement = match connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
    {
        Ok(statement) => statement,
        Err(error) => {
            eprintln!(
                "[urdira-indexing-core] missing-index detector could not read sqlite_schema: {error}"
            );
            return;
        }
    };
    let existing: HashSet<String> = match statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect)
    {
        Ok(names) => names,
        Err(error) => {
            eprintln!(
                "[urdira-indexing-core] missing-index detector could not enumerate indexes: {error}"
            );
            return;
        }
    };
    let missing: Vec<&str> = EXPECTED_INCREMENTAL_INDEXES
        .iter()
        .copied()
        .filter(|name| !existing.contains(*name))
        .collect();
    if missing.is_empty() {
        eprintln!(
            "[urdira-indexing-core] incremental publish: all expected accelerator indexes present"
        );
    } else {
        eprintln!(
            "[urdira-indexing-core] incremental publish: MISSING accelerator indexes: {}",
            missing.join(", ")
        );
    }
}

fn descriptor_generation(request: &GenerationRequest) -> i64 {
    i64::try_from(request.base_generation.saturating_add(1)).unwrap_or(i64::MAX)
}

fn hex_payload(value: &str) -> Result<Vec<u8>, CoreError> {
    if !value.len().is_multiple_of(2) {
        return Err(CoreError(
            "candidate body payload hex has odd length".into(),
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&value[offset..offset + 2], 16)
                .map_err(|_| CoreError("candidate body payload hex is invalid".into()))
        })
        .collect()
}

/// Decodes a `<prefix><64 lowercase hex chars>` sha256 digest identifier (the
/// `sha256:`/`record:`/`<identity_type>:` fixed-width string shapes the
/// native kernel always emits, see `urdira-native-core::structural_record_digest`
/// et al.) into the raw 32-byte digest. The staging TEMP relation stores
/// these columns as `BLOB` instead of the 71/72-byte text form; every SQL
/// statement that promotes a staged row back into a durable TEXT column must
/// reconstruct the exact original string with `<prefix> || lower(hex(blob))`
/// so the durable bytes stay byte-identical to the pre-diet representation.
fn digest_identifier_blob(value: &str, prefix: &str) -> Result<Vec<u8>, CoreError> {
    let hex_part = value.strip_prefix(prefix).ok_or_else(|| {
        CoreError(format!(
            "digest identifier {value:?} does not start with expected prefix {prefix:?}"
        ))
    })?;
    if hex_part.len() != 64 {
        return Err(CoreError(format!(
            "digest identifier {value:?} does not have a 32-byte hex payload"
        )));
    }
    hex_payload(hex_part)
}

/// Computes the v2 logical digest for an artifact dependency. Keeping this
/// fixed-field encoder in the core lets dependency publication remain a
/// single set-based SQLite statement instead of rebuilding row arrays in the
/// composition worker.
#[allow(clippy::too_many_arguments)]
pub fn artifact_dependency_digest(
    dependency_id: &str,
    workspace_id: &str,
    record_id: &str,
    owner_artifact_id: &str,
    owner_artifact_version_id: &str,
    dependency_artifact_id: &str,
    dependency_artifact_version_id: &str,
    dependency_role: &str,
    producer_id: &str,
    producer_version: &str,
) -> String {
    let fields = [
        ("dependency_artifact_id", dependency_artifact_id),
        (
            "dependency_artifact_version_id",
            dependency_artifact_version_id,
        ),
        ("dependency_entry_id", dependency_id),
        ("dependency_role", dependency_role),
        ("owner_artifact_id", owner_artifact_id),
        ("owner_artifact_version_id", owner_artifact_version_id),
        ("producer_id", producer_id),
        ("producer_version", producer_version),
        ("record_id", record_id),
        ("workspace_id", workspace_id),
    ];
    let mut bytes = Vec::new();
    logical_text(&mut bytes, "urdira:artifact-dependency:v2");
    bytes.push(10);
    logical_varint(fields.len(), &mut bytes);
    for (key, value) in fields {
        logical_text(&mut bytes, key);
        bytes.extend_from_slice(&[4, 1]);
        logical_text(&mut bytes, value);
    }
    let mut digest = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        let _ = write!(&mut digest, "{byte:02x}");
    }
    digest
}

fn logical_varint(mut value: usize, output: &mut Vec<u8>) {
    loop {
        let byte = (value % 128) as u8;
        value /= 128;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn logical_text(output: &mut Vec<u8>, value: &str) {
    output.push(7);
    logical_varint(value.len(), output);
    output.extend_from_slice(value.as_bytes());
}

pub struct IndexingCore {
    connection: Connection,
    workspace_path: String,
    workspace_lease: Option<WorkspaceWriteLease>,
    operation_id: String,
    candidate_generation_id: String,
    cancellation_path: Option<PathBuf>,
    workspace_id: String,
    next_group_sequence: u64,
    cancellation: CancellationToken,
    deadline_ms: Option<u64>,
    engine_id: String,
    engine_version: String,
}

/// Process-local exclusion for structural/lexical mutation of one workspace.
/// SQLite remains the cross-process safety net, but refusing a second writer
/// here keeps the composition worker deterministic and avoids lock spin.
struct WorkspaceWriteLease {
    slot: Arc<AtomicBool>,
    lock_path: Option<PathBuf>,
    lock_file: Option<File>,
}

impl Drop for WorkspaceWriteLease {
    fn drop(&mut self) {
        self.slot.store(false, Ordering::Release);
        if let Some(path) = self.lock_path.take() {
            let _ = remove_file(path);
        }
        let _ = self.lock_file.take();
    }
}

impl Drop for IndexingCore {
    fn drop(&mut self) {
        if let Some(path) = self.cancellation_path.take() {
            let _ = remove_file(path);
        }
    }
}

fn workspace_lease(path: &str) -> Result<WorkspaceWriteLease, CoreError> {
    if path == ":memory:" {
        return Ok(WorkspaceWriteLease {
            slot: Arc::new(AtomicBool::new(true)),
            lock_path: None,
            lock_file: None,
        });
    }
    static LEASES: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    let leases = LEASES.get_or_init(|| Mutex::new(HashMap::new()));
    let slot = {
        let mut entries = leases
            .lock()
            .map_err(|_| CoreError("workspace lease registry poisoned".into()))?;
        entries
            .entry(path.to_owned())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    };
    slot.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .map_err(|_| CoreError("workspace structural writer is already active".into()))?;
    let lock_path = PathBuf::from(format!("{path}.urdira-writer.lock"));
    let mut lock_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(error) => {
            slot.store(false, Ordering::Release);
            return Err(CoreError(format!(
                "workspace structural writer is already active: {error}"
            )));
        }
    };
    let _ = writeln!(lock_file, "{}", std::process::id());
    Ok(WorkspaceWriteLease {
        slot,
        lock_path: Some(lock_path),
        lock_file: Some(lock_file),
    })
}

/// Initial backoff delay for `open_with_lease_wait`'s retry loop.
const LEASE_WAIT_INITIAL_DELAY_MS: u64 = 100;
/// Backoff delay cap for `open_with_lease_wait`'s retry loop.
const LEASE_WAIT_MAX_DELAY_MS: u64 = 500;
/// Total time `open_with_lease_wait` spends retrying before giving up and
/// returning the lease-contention error to the caller. Chunked lexical
/// maintenance (`reconcile_lexical`/`yield_mutation_lease` below) now
/// releases the workspace writer lease every few seconds between chunks, so
/// this only needs to cover a couple of chunk boundaries, not a whole
/// generation's worth of maintenance.
const LEASE_WAIT_TOTAL_BUDGET: Duration = Duration::from_secs(30);

/// True when `error` is `workspace_lease` reporting that the process-local
/// slot is already held by another writer, as opposed to any other
/// `IndexingCore::open` failure (a bad request, a SQLite error, ...) that
/// retrying would never resolve.
fn is_lease_contended(error: &CoreError) -> bool {
    error
        .0
        .contains("workspace structural writer is already active")
}

impl IndexingCore {
    pub fn open(path: &str, request: &GenerationRequest) -> Result<Self, CoreError> {
        validate_identifier(&request.operation_id, "operation_id")?;
        validate_identifier(&request.workspace_id, "workspace_id")?;
        validate_identifier(&request.candidate_generation_id, "candidate_generation_id")?;
        validate_generation_request(request)?;
        let lease = workspace_lease(path)?;
        let connection = match Connection::open(path) {
            Ok(connection) => connection,
            Err(error) => {
                drop(lease);
                return Err(sql_error(error));
            }
        };
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(sql_error)?;
        connection
            .pragma_update(None, "busy_timeout", 5_000_i64)
            .map_err(sql_error)?;
        // Keep the foreground publication commit bounded.  A large WAL
        // should be checkpointed by the Rust scheduler after visibility, not
        // synchronously by SQLite's page-count trigger while the structural
        // request is waiting for its completion event.
        connection
            .pragma_update(None, "wal_autocheckpoint", 0_i64)
            .map_err(sql_error)?;
        // WAL + NORMAL keeps the single Rust writer durable while avoiding a
        // full fsync for every large publication commit. The transaction and
        // writer lease still provide atomic visibility and recovery semantics.
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_error)?;
        // The default SQLite page cache is only a few MiB. Structural
        // publication copies large candidate payloads twice (candidate and
        // visible tables); a bounded 1 GiB cache keeps the set-based
        // INSERT...SELECT scans and cold index sorters hot without growing
        // with repository size.
        connection
            .pragma_update(None, "cache_size", -1_048_576_i64)
            .map_err(sql_error)?;
        // Candidate owner rows are intentionally TEMP tables, but keeping
        // their multi-gigabyte canonical payloads in the SQLite heap defeats
        // the bounded-RSS contract. Force SQLite's temporary database onto
        // its managed temp files; the publication transaction and atomic
        // visibility semantics are unchanged.
        connection
            .pragma_update(None, "temp_store", "FILE")
            .map_err(sql_error)?;
        // TEMP staging is ephemeral: only the final main-database WAL
        // transaction is durable. Keep its journal in memory and avoid a
        // per-group fsync while retaining FILE temp storage for bounded heap.
        connection
            .execute_batch("PRAGMA temp.journal_mode=MEMORY; PRAGMA temp.synchronous=OFF;")
            .map_err(sql_error)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TEMP TABLE IF NOT EXISTS urdira_core_owner_stage (operation_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL, owner_path TEXT NOT NULL, observation_lane TEXT NOT NULL, sequence INTEGER NOT NULL, final_batch INTEGER NOT NULL, row_count INTEGER NOT NULL, byte_length INTEGER NOT NULL, owner_digest TEXT NOT NULL, fact_delta_id TEXT, delta_digest TEXT, PRIMARY KEY (operation_id, candidate_generation_id, owner_artifact_id, observation_lane, sequence)); CREATE TEMP TABLE IF NOT EXISTS urdira_core_owner_rows (owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL, observation_lane TEXT NOT NULL, sequence INTEGER NOT NULL, row_ordinal INTEGER NOT NULL, lane TEXT NOT NULL, proposal_key TEXT NOT NULL, publication_record_id BLOB, body_payload_hex BLOB, record_category TEXT, record_kind TEXT, record_universal_kind TEXT, record_schema_version INTEGER, record_digest BLOB, body_digest BLOB, body_byte_length INTEGER, primary_source_span_artifact_version_id TEXT, primary_source_span_start_byte INTEGER, primary_source_span_end_byte INTEGER, primary_source_span_start_line INTEGER, primary_source_span_end_line INTEGER, identity_type TEXT, identity_key TEXT, identity_id BLOB, identity_assignment_id BLOB, identity_key_digest BLOB, dependency_id TEXT, dependency_artifact_id TEXT, dependency_artifact_version_id TEXT, dependency_role TEXT, dependency_content_digest TEXT, PRIMARY KEY (owner_artifact_id, observation_lane, sequence, row_ordinal)); CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_publication_order ON urdira_core_owner_rows (observation_lane, publication_record_id, owner_artifact_id, owner_artifact_version_id, sequence, row_ordinal); CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_record_id ON urdira_core_owner_rows (lane, publication_record_id); CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_dependency_binding ON urdira_core_owner_rows (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, proposal_key); CREATE TEMP TABLE IF NOT EXISTS urdira_core_owner_facets (owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL, observation_lane TEXT NOT NULL, sequence INTEGER NOT NULL, row_ordinal INTEGER NOT NULL, facet_ordinal INTEGER NOT NULL, facet TEXT NOT NULL, PRIMARY KEY (owner_artifact_id, observation_lane, sequence, row_ordinal, facet_ordinal)); CREATE INDEX IF NOT EXISTS urdira_core_owner_facets_join ON urdira_core_owner_facets (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, facet_ordinal); CREATE TEMP TABLE IF NOT EXISTS urdira_core_group_receipts (operation_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, owner_count INTEGER NOT NULL, row_count INTEGER NOT NULL, byte_length INTEGER NOT NULL, group_digest TEXT NOT NULL, PRIMARY KEY (operation_id, candidate_generation_id, group_sequence)); CREATE TEMP TABLE IF NOT EXISTS urdira_core_generation_stats (operation_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, record_count INTEGER NOT NULL, facet_count INTEGER NOT NULL, identity_count INTEGER NOT NULL, body_byte_length INTEGER NOT NULL, first_record_id TEXT, last_record_id TEXT, PRIMARY KEY (operation_id, candidate_generation_id));").map_err(sql_error)?;
        // Secondary TEMP indexes are created once immediately before
        // publication. Maintaining them during every owner-row insert makes
        // the Rust ingest path pay an avoidable B-tree update per row.
        connection
                .execute_batch("DROP INDEX IF EXISTS urdira_core_owner_rows_publication_order; DROP INDEX IF EXISTS urdira_core_owner_rows_record_id; DROP INDEX IF EXISTS urdira_core_owner_rows_dependency_binding; DROP INDEX IF EXISTS urdira_core_owner_facets_join;")
            .map_err(sql_error)?;
        Ok(Self {
            connection,
            workspace_path: path.to_owned(),
            workspace_lease: Some(lease),
            operation_id: request.operation_id.clone(),
            candidate_generation_id: request.candidate_generation_id.clone(),
            cancellation_path: request.cancellation_path.clone(),
            workspace_id: request.workspace_id.clone(),
            next_group_sequence: 0,
            cancellation: CancellationToken::default(),
            deadline_ms: request.deadline_ms,
            engine_id: request.engine.engine_id.clone(),
            engine_version: request.engine.engine_version.clone(),
        })
    }

    /// Opens a generation exactly like `open`, but retries a lease-contention
    /// failure with a bounded backoff instead of failing on the very first
    /// attempt. `open` (and the process-local `workspace_lease` it calls)
    /// intentionally stays single-attempt: administrative/maintenance
    /// callers that only need to eventually run -- WAL checkpoint,
    /// secondary index rebuild, GC, fork -- call `open` directly and
    /// already implement their own longer-lived outer retry loops with
    /// different pacing, so they must keep failing fast here rather than
    /// silently absorbing a real one-writer violation underneath those
    /// loops.
    ///
    /// This wrapper exists for callers whose own outer retry loop pays
    /// disproportionately for every lease-contention failure instead of
    /// simply waiting the current holder out. Two such callers:
    ///
    /// - A foreground scan/source commit/indexing generation that loses a
    ///   brief race against a chunk of the now-chunked lexical maintenance
    ///   pass (`reconcile_lexical`, which yields the lease every few seconds
    ///   via `yield_mutation_lease` instead of holding it for the pass's
    ///   whole multi-minute duration). Before this wrapper, that race
    ///   surfaced instantly as
    ///   `core:source_index_commit_failed`/`core:index_open_failed`
    ///   ("workspace structural writer is already active") and the caller
    ///   (`packages/daemon/src/runtime.ts`) had no code to retry on, pinning
    ///   a terminal `last_scan_error`
    ///   (docs/evidence/2026-09-01-f1-resultado.md).
    /// - `schedule_lexical_reconcile` in `urdira-indexing-worker` itself:
    ///   its inner attempt to (re)open the workspace after publication
    ///   systematically lost this same race against the Node structural
    ///   commit poller under a single-attempt `open`, each loss paying that
    ///   loop's own 250-2000ms backoff before trying again (measured: 56
    ///   retries / 80.5s just to acquire the lease,
    ///   docs/evidence/2026-09-01-f5-e3-cierre-tanda.md, B1). It now opens
    ///   with this wrapper instead, and keeps its own outer 10-minute
    ///   deadline purely as a safety net for the rare case that this
    ///   wrapper's 30s budget is exhausted too (e.g. a structural generation
    ///   that legitimately runs for minutes).
    ///
    /// A short bounded wait here almost always resolves within one or two
    /// lease-holder turnovers instead. Does not change single-writer
    /// semantics: this only waits for the existing lease to become free,
    /// exactly as `open` would eventually succeed if called again a moment
    /// later.
    pub fn open_with_lease_wait(
        path: &str,
        request: &GenerationRequest,
    ) -> Result<Self, CoreError> {
        Self::open_with_lease_wait_until(path, request, Instant::now() + LEASE_WAIT_TOTAL_BUDGET)
    }

    /// The retry loop behind `open_with_lease_wait`, parameterized on the
    /// deadline so tests can exercise the "still contended when time runs
    /// out" branch in milliseconds instead of the real 30-second budget.
    fn open_with_lease_wait_until(
        path: &str,
        request: &GenerationRequest,
        deadline: Instant,
    ) -> Result<Self, CoreError> {
        let mut delay_ms = LEASE_WAIT_INITIAL_DELAY_MS;
        loop {
            match Self::open(path, request) {
                Ok(core) => return Ok(core),
                Err(error) if is_lease_contended(&error) && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    delay_ms = (delay_ms * 2).min(LEASE_WAIT_MAX_DELAY_MS);
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// Polls both the in-process token and the private transport sidecar.
    /// Keeping this behind the core prevents language engines from needing a
    /// second cancellation channel or filesystem dependency.
    pub fn cancellation_requested(&self) -> bool {
        if self
            .cancellation_path
            .as_ref()
            .is_some_and(|path| path.exists())
        {
            self.cancellation.cancel();
        }
        self.cancellation.is_cancelled()
    }

    /// Replays the durable receipt ledger after a worker restart. The staged
    /// rows live in the worker connection's TEMP schema, so recovery is
    /// intentionally fail-closed when the process did not retain that
    /// connection; callers must replay the idempotent groups from CAS.
    pub fn recovered_group_count(&self) -> Result<usize, CoreError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM urdira_core_group_receipts WHERE operation_id = ?1 AND candidate_generation_id = ?2",
                (&self.operation_id, &self.candidate_generation_id),
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as usize)
            .map_err(sql_error)
    }

    pub fn shutdown(&mut self) -> Result<(), CoreError> {
        self.cancellation.cancel();
        self.connection
            .execute(
                "DELETE FROM urdira_core_owner_stage WHERE operation_id = ?1 AND candidate_generation_id = ?2",
                (&self.operation_id, &self.candidate_generation_id),
            )
            .map_err(sql_error)?;
        self.connection
            .execute(
                "DELETE FROM urdira_core_group_receipts WHERE operation_id = ?1 AND candidate_generation_id = ?2",
                (&self.operation_id, &self.candidate_generation_id),
            )
            .map_err(sql_error)?;
        // `urdira_core_owner_rows`/`urdira_core_owner_facets` no longer carry
        // operation_id/candidate_generation_id columns: each connection's TEMP
        // schema is created fresh by `open` and lives for exactly one
        // (operation_id, candidate_generation_id) pair, so an unconditional
        // DELETE here is equivalent to the old scoped one.
        self.connection
            .execute("DELETE FROM urdira_core_owner_rows", [])
            .map_err(sql_error)?;
        self.connection
            .execute("DELETE FROM urdira_core_owner_facets", [])
            .map_err(sql_error)?;
        self.connection
            .execute(
                "DELETE FROM urdira_core_generation_stats WHERE operation_id = ?1 AND candidate_generation_id = ?2",
                (&self.operation_id, &self.candidate_generation_id),
            )
            .map_err(sql_error)?;
        self.workspace_lease.take();
        Ok(())
    }

    /// Releases the cross-process mutation lease while the application writes
    /// candidate metadata. Structural staging remains on this connection and
    /// is reacquired atomically immediately before final publication.
    pub fn release_mutation_lease(&mut self) {
        self.workspace_lease.take();
    }

    /// Returns the database path used by this core instance. The Rust worker
    /// scheduler uses it to open a separate, exclusively leased connection
    /// for post-publication lexical maintenance.
    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    /// Reads the current source frontier from the same leased SQLite
    /// connection used for structural publication.  This is intentionally
    /// language-neutral; a language engine filters paths and derives its own
    /// CAS coordinates without receiving an owner-sized manifest from the
    /// TypeScript application.
    pub fn current_source_artifacts(
        &mut self,
        workspace_id: &str,
    ) -> Result<Vec<CurrentSourceArtifact>, CoreError> {
        self.with_transaction(|transaction| {
            let mut statement = transaction
                .prepare(
                    "SELECT artifact.artifact_id, version.artifact_version_id, COALESCE(artifact.normalized_path, artifact.normalized_uri), version.content_hash, version.byte_length FROM artifact_versions AS version JOIN source_artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.artifact_id = version.artifact_id WHERE version.workspace_id = ?1 AND version.valid_to_generation IS NULL ORDER BY artifact.normalized_uri, artifact.artifact_id",
                )
                .map_err(sql_error)?;
            let rows = statement
                .query_map([workspace_id], |row| {
                    let byte_length: i64 = row.get(4)?;
                    Ok(CurrentSourceArtifact {
                        artifact_id: row.get(0)?,
                        artifact_version_id: row.get(1)?,
                        path: row.get(2)?,
                        content_hash: row.get(3)?,
                        byte_length: usize::try_from(byte_length).map_err(|_| {
                            rusqlite::Error::IntegralValueOutOfRange(4, byte_length)
                        })?,
                    })
                })
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)
        })
    }

    /// Execute a bounded generic SQLite mutation under the same workspace
    /// lease and connection used by structural publication. Source catalog
    /// ingestion uses this for equivalent scans that have no candidate to
    /// publish, so TypeScript never becomes a second workspace writer.
    pub fn with_transaction<T, F>(&mut self, action: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Transaction<'_>) -> Result<T, CoreError>,
    {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let result = action(&transaction)?;
        transaction.commit().map_err(sql_error)?;
        Ok(result)
    }

    /// Performs one bounded passive WAL checkpoint.  The scheduler invokes
    /// this only after the structural transaction is visible, so checkpoint
    /// latency cannot extend structural readiness and a pinned reader simply
    /// leaves frames for a later maintenance pass.
    pub fn checkpoint_wal(&self) -> Result<(i64, i64, i64), CoreError> {
        self.connection
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(sql_error)
    }

    fn ensure_mutation_lease(&mut self) -> Result<(), CoreError> {
        if self.workspace_lease.is_none() {
            self.workspace_lease = Some(workspace_lease(&self.workspace_path)?);
        }
        Ok(())
    }

    pub fn accept_group(&mut self, group: &PhysicalGroup) -> Result<GroupAcceptance, CoreError> {
        self.accept_group_prepared(group, None)
    }

    fn accept_group_prepared(
        &mut self,
        group: &PhysicalGroup,
        prepared_kernels: Option<&[urdira_native_core::StructuralKernelResult]>,
    ) -> Result<GroupAcceptance, CoreError> {
        self.ensure_mutation_lease()?;
        self.check_cancelled()?;
        validate_group(group)?;
        if let Some(kernels) = prepared_kernels
            && kernels.len() != group.owners.len()
        {
            return Err(CoreError(
                "prepared kernel count does not match physical group".into(),
            ));
        }
        if group.group_sequence > self.next_group_sequence {
            return Err(CoreError(
                "physical group sequence is not contiguous".into(),
            ));
        }
        let group_digest = digest_group(group)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let existing: Option<GroupReceipt> = transaction.query_row("SELECT owner_count, row_count, byte_length, group_digest FROM urdira_core_group_receipts WHERE operation_id = ?1 AND candidate_generation_id = ?2 AND group_sequence = ?3", (&self.operation_id, &self.candidate_generation_id, group.group_sequence), |row| Ok(GroupReceipt { operation_id: self.operation_id.clone(), candidate_generation_id: self.candidate_generation_id.clone(), group_sequence: group.group_sequence, owner_count: row.get::<_, i64>(0)? as usize, row_count: row.get::<_, i64>(1)? as usize, byte_length: row.get::<_, i64>(2)? as usize, group_digest: row.get(3)? })).optional().map_err(sql_error)?;
        if let Some(receipt) = existing {
            if receipt.group_digest != group_digest {
                return Err(CoreError("conflicting physical group receipt".into()));
            }
            transaction.commit().map_err(sql_error)?;
            if group.group_sequence == self.next_group_sequence {
                self.next_group_sequence += 1;
            }
            return Ok(GroupAcceptance::AlreadyAccepted(receipt));
        }
        let mut stat_record_count = 0_i64;
        let mut stat_facet_count = 0_i64;
        let mut stat_identity_count = 0_i64;
        let mut stat_body_byte_length = 0_i64;
        let mut stat_first_record_id: Option<String> = None;
        let mut stat_last_record_id: Option<String> = None;
        {
            // Prepare the three hot staging statements once per physical
            // group. Calling `Transaction::execute` for every row reparses
            // identical SQL and recreates the round-trip the Rust cutover is
            // intended to remove.
            let mut owner_stage_statement = transaction
                .prepare_cached("INSERT INTO urdira_core_owner_stage (operation_id, candidate_generation_id, group_sequence, owner_artifact_id, owner_artifact_version_id, owner_path, observation_lane, sequence, final_batch, row_count, byte_length, owner_digest, fact_delta_id, delta_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)")
                .map_err(sql_error)?;
            let mut record_statement = transaction
                .prepare_cached("INSERT INTO urdira_core_owner_rows (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, lane, proposal_key, publication_record_id, body_payload_hex, record_category, record_kind, record_universal_kind, record_schema_version, record_digest, body_digest, body_byte_length, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, identity_type, identity_key, identity_id, identity_assignment_id, identity_key_digest) VALUES (?1, ?2, ?3, ?4, ?5, 'records', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)")
                .map_err(sql_error)?;
            let mut dependency_statement = transaction
                .prepare_cached("INSERT INTO urdira_core_owner_rows (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, lane, proposal_key, dependency_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, dependency_content_digest) VALUES (?1, ?2, ?3, ?4, ?5, 'dependencies', ?6, ?7, ?8, ?9, ?10, ?11)")
                .map_err(sql_error)?;
            let mut facet_statement = transaction
                .prepare_cached("INSERT INTO urdira_core_owner_facets (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, facet_ordinal, facet) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                .map_err(sql_error)?;
            for (owner_index, owner) in group.owners.iter().enumerate() {
                let computed_kernel;
                let kernel = if let Some(kernels) = prepared_kernels {
                    &kernels[owner_index]
                } else {
                    computed_kernel = structural_kernel_batch(&owner.batch()).map_err(|error| {
                        CoreError(format!("owner {} rejected: {error}", owner.owner_path))
                    })?;
                    &computed_kernel
                };
                if owner.byte_length != kernel.canonical_byte_length {
                    return Err(CoreError(format!(
                        "owner {} byte length does not match canonical bytes",
                        owner.owner_path
                    )));
                }
                let expected_digest = digest_owner(owner, kernel)?;
                if owner.owner_digest != expected_digest {
                    return Err(CoreError(format!(
                        "owner {} digest does not match canonical contents",
                        owner.owner_path
                    )));
                }
                if let Some(fact_delta_id) = &owner.fact_delta_id {
                    validate_identifier(fact_delta_id, "fact_delta_id")?;
                }
                let changed = owner_stage_statement
                    .execute((
                        &self.operation_id,
                        &self.candidate_generation_id,
                        group.group_sequence,
                        &owner.owner_artifact_id,
                        &owner.owner_artifact_version_id,
                        &owner.owner_path,
                        &owner.lane,
                        owner.sequence,
                        i64::from(owner.final_batch),
                        owner.rows() as i64,
                        owner.byte_length as i64,
                        &owner.owner_digest,
                        &owner.fact_delta_id,
                        &owner.delta_digest,
                    ))
                    .map_err(sql_error)?;
                if changed != 1 {
                    return Err(CoreError(
                        "owner receipt insertion did not affect exactly one row".into(),
                    ));
                }
                let mut record_ids = HashMap::<&str, &str>::with_capacity(owner.records.len());
                for (row_ordinal, _canonical) in kernel.canonical_records.iter().enumerate() {
                    let record = owner.records.get(row_ordinal).ok_or_else(|| {
                        CoreError("prepared kernel record count does not match owner rows".into())
                    })?;
                    let body_payload = hex_payload(&kernel.record_body_payload_hexes[row_ordinal])?;
                    let publication = &kernel.publication_records[row_ordinal];
                    record_ids.insert(&record.proposal_record_key, &publication.record_id);
                    // The TEMP staging relation stores these digest/identity
                    // identifiers as raw 32-byte BLOBs instead of their
                    // 71/72-byte `sha256:`/`record:`/`<identity_type>:` text
                    // form. Every promotion SQL statement that reads them back
                    // out reconstructs the exact original string with
                    // `<prefix> || lower(hex(blob))` so durable bytes stay
                    // byte-identical to the pre-diet representation.
                    let publication_record_id_blob =
                        digest_identifier_blob(&publication.record_id, "record:")?;
                    let record_digest_blob =
                        digest_identifier_blob(&publication.record_digest, "sha256:")?;
                    let body_digest_blob =
                        digest_identifier_blob(&publication.body_digest, "sha256:")?;
                    let identity_id_blob = digest_identifier_blob(
                        &publication.identity_id,
                        &format!("{}:", publication.identity_type),
                    )?;
                    let identity_assignment_id_blob =
                        digest_identifier_blob(&publication.identity_assignment_id, "sha256:")?;
                    let identity_key_digest_blob =
                        digest_identifier_blob(&publication.identity_key_digest, "sha256:")?;
                    let primary_source_span = publication.primary_source_span.as_ref();
                    let span_artifact_version_id = primary_source_span
                        .and_then(|span| span.get("artifact_version_id"))
                        .and_then(Value::as_str);
                    let span_number = |key: &str| {
                        primary_source_span
                            .and_then(|span| span.get(key))
                            .and_then(Value::as_i64)
                    };
                    let body_byte_length =
                        i64::try_from(publication.body_byte_length).map_err(|_| {
                            CoreError("body byte length exceeds SQLite integer range".into())
                        })?;
                    stat_record_count += 1;
                    stat_facet_count += i64::try_from(publication.facets.len()).map_err(|_| {
                        CoreError("facet count exceeds SQLite integer range".into())
                    })?;
                    stat_identity_count +=
                        i64::from(!publication.identity_assignment_id.is_empty());
                    stat_body_byte_length = stat_body_byte_length
                        .checked_add(body_byte_length)
                        .ok_or_else(|| CoreError("publication body byte length overflow".into()))?;
                    if stat_first_record_id
                        .as_ref()
                        .is_none_or(|current| publication.record_id.as_str() < current.as_str())
                    {
                        stat_first_record_id = Some(publication.record_id.clone());
                    }
                    if stat_last_record_id
                        .as_ref()
                        .is_none_or(|current| publication.record_id.as_str() > current.as_str())
                    {
                        stat_last_record_id = Some(publication.record_id.clone());
                    }
                    record_statement
                        .execute(params![
                            &owner.owner_artifact_id,
                            &owner.owner_artifact_version_id,
                            &owner.lane,
                            owner.sequence,
                            row_ordinal as u64,
                            &record.proposal_record_key,
                            publication_record_id_blob,
                            body_payload,
                            &record.category,
                            &record.kind,
                            &record.universal_kind,
                            i64::from(record.schema_version),
                            record_digest_blob,
                            body_digest_blob,
                            body_byte_length,
                            span_artifact_version_id,
                            span_number("start_byte"),
                            span_number("end_byte"),
                            span_number("start_line"),
                            span_number("end_line"),
                            &publication.identity_type,
                            &publication.identity_key,
                            identity_id_blob,
                            identity_assignment_id_blob,
                            identity_key_digest_blob,
                        ])
                        .map_err(sql_error)?;
                    for (facet_ordinal, facet) in publication.facets.iter().enumerate() {
                        facet_statement
                            .execute(params![
                                &owner.owner_artifact_id,
                                &owner.owner_artifact_version_id,
                                &owner.lane,
                                owner.sequence,
                                row_ordinal as u64,
                                facet_ordinal as u64,
                                facet,
                            ])
                            .map_err(sql_error)?;
                    }
                }
                for (offset, _canonical) in kernel.canonical_dependencies.iter().enumerate() {
                    let dependency = owner.dependencies.get(offset).ok_or_else(|| {
                        CoreError(
                            "prepared kernel dependency count does not match owner rows".into(),
                        )
                    })?;
                    let record_id = record_ids
                        .get(dependency.proposal_record_key.as_str())
                        .copied()
                        .unwrap_or(dependency.proposal_record_key.as_str());
                    let dependency_content_digest = artifact_dependency_digest(
                        &dependency.proposed_dependency_id,
                        &self.workspace_id,
                        record_id,
                        &owner.owner_artifact_id,
                        &owner.owner_artifact_version_id,
                        &dependency.dependency_artifact_id,
                        &dependency.dependency_artifact_version_id,
                        &dependency.dependency_role,
                        &self.engine_id,
                        &self.engine_version,
                    );
                    dependency_statement
                        .execute((
                            &owner.owner_artifact_id,
                            &owner.owner_artifact_version_id,
                            &owner.lane,
                            owner.sequence,
                            (owner.records.len() + offset) as u64,
                            &dependency.proposal_record_key,
                            &dependency.proposed_dependency_id,
                            &dependency.dependency_artifact_id,
                            &dependency.dependency_artifact_version_id,
                            &dependency.dependency_role,
                            &dependency_content_digest,
                        ))
                        .map_err(sql_error)?;
                }
            }
        }
        transaction
            .execute(
                "INSERT INTO urdira_core_generation_stats (operation_id, candidate_generation_id, record_count, facet_count, identity_count, body_byte_length, first_record_id, last_record_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(operation_id, candidate_generation_id) DO UPDATE SET record_count = urdira_core_generation_stats.record_count + excluded.record_count, facet_count = urdira_core_generation_stats.facet_count + excluded.facet_count, identity_count = urdira_core_generation_stats.identity_count + excluded.identity_count, body_byte_length = urdira_core_generation_stats.body_byte_length + excluded.body_byte_length, first_record_id = CASE WHEN excluded.first_record_id IS NULL THEN urdira_core_generation_stats.first_record_id WHEN urdira_core_generation_stats.first_record_id IS NULL OR excluded.first_record_id < urdira_core_generation_stats.first_record_id THEN excluded.first_record_id ELSE urdira_core_generation_stats.first_record_id END, last_record_id = CASE WHEN excluded.last_record_id IS NULL THEN urdira_core_generation_stats.last_record_id WHEN urdira_core_generation_stats.last_record_id IS NULL OR excluded.last_record_id > urdira_core_generation_stats.last_record_id THEN excluded.last_record_id ELSE urdira_core_generation_stats.last_record_id END",
                params![
                    &self.operation_id,
                    &self.candidate_generation_id,
                    stat_record_count,
                    stat_facet_count,
                    stat_identity_count,
                    stat_body_byte_length,
                    stat_first_record_id,
                    stat_last_record_id,
                ],
            )
            .map_err(sql_error)?;
        let receipt = GroupReceipt {
            operation_id: self.operation_id.clone(),
            candidate_generation_id: self.candidate_generation_id.clone(),
            group_sequence: group.group_sequence,
            owner_count: group
                .owners
                .iter()
                .map(|owner| (&owner.owner_artifact_id, &owner.owner_artifact_version_id))
                .collect::<HashSet<_>>()
                .len(),
            row_count: group.owners.iter().map(OwnerObservation::rows).sum(),
            byte_length: group.owners.iter().map(|owner| owner.byte_length).sum(),
            group_digest,
        };
        transaction.execute("INSERT INTO urdira_core_group_receipts (operation_id, candidate_generation_id, group_sequence, owner_count, row_count, byte_length, group_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", (&receipt.operation_id, &receipt.candidate_generation_id, receipt.group_sequence, receipt.owner_count as i64, receipt.row_count as i64, receipt.byte_length as i64, &receipt.group_digest)).map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        self.next_group_sequence += 1;
        Ok(GroupAcceptance::Inserted(receipt))
    }

    /// Engine-facing variant. The private engine protocol may omit the two
    /// derived integrity fields; Rust computes them from the canonical kernel
    /// before entering the strict receipt path. Public callers should use
    /// `accept_group`, which remains fail-closed for malformed receipts.
    pub fn accept_engine_group(
        &mut self,
        group: &PhysicalGroup,
    ) -> Result<GroupAcceptance, CoreError> {
        let normalized = group.clone();
        self.accept_engine_group_owned(normalized)
    }

    /// Engine-facing owned variant used by the worker boundary. The language
    /// engine has already transferred ownership of the bounded physical group,
    /// so normalization can happen in place without cloning every row before
    /// the SQLite staging transaction.
    pub fn accept_engine_group_owned(
        &mut self,
        normalized: PhysicalGroup,
    ) -> Result<GroupAcceptance, CoreError> {
        let (normalized, kernels) = prepare_engine_group(normalized)?;
        self.accept_group_prepared(&normalized, Some(&kernels))
    }

    /// Accepts a group whose canonicalization/digest pass already ran via
    /// `prepare_engine_group`, e.g. on a worker thread that overlaps that
    /// pure CPU work with this SQLite writer. The caller remains responsible
    /// for invoking this in strict, contiguous `group_sequence` order:
    /// `accept_group_prepared` enforces contiguity but does not reorder.
    pub fn accept_prepared_group(
        &mut self,
        normalized: &PhysicalGroup,
        kernels: &[urdira_native_core::StructuralKernelResult],
    ) -> Result<GroupAcceptance, CoreError> {
        self.accept_group_prepared(normalized, Some(kernels))
    }

    /// Accepts already canonicalized UCE rows emitted by a language engine.
    /// Rust validates them through the native kernel once and reuses that
    /// prepared result for the idempotent receipt/staging path.
    pub fn accept_canonical_group(
        &mut self,
        group: &CanonicalPhysicalGroup,
    ) -> Result<GroupAcceptance, CoreError> {
        self.accept_canonical_group_owned(group.clone())
    }

    /// Accepts a canonical group by value on the production worker boundary.
    /// The canonical strings are parsed once into the typed kernel and then
    /// dropped; taking ownership avoids cloning every row and owner envelope
    /// merely to enter the generic Rust staging path. The borrowed method
    /// above remains available for compatibility and differential oracles.
    pub fn accept_canonical_group_owned(
        &mut self,
        group: CanonicalPhysicalGroup,
    ) -> Result<GroupAcceptance, CoreError> {
        let mut owners = Vec::with_capacity(group.owners.len());
        let mut kernels = Vec::with_capacity(group.owners.len());
        for owner in group.owners {
            let (result, parsed_records) = structural_kernel_canonical_batch_parts_with_records(
                &owner.canonical_records,
                &owner.canonical_dependencies,
                &[],
            )
            .map_err(|error| CoreError(format!("owner {} rejected: {error}", owner.owner_path)))?;
            let mut observation = OwnerObservation {
                owner_artifact_id: owner.owner_artifact_id,
                owner_artifact_version_id: owner.owner_artifact_version_id,
                owner_path: owner.owner_path,
                lane: owner.lane,
                sequence: owner.sequence,
                final_batch: owner.final_batch,
                records: parsed_records,
                dependencies: result.dependencies,
                byte_length: owner.byte_length,
                owner_digest: owner.owner_digest,
                fact_delta_id: owner.fact_delta_id,
                delta_digest: owner.delta_digest,
            };
            if observation.byte_length == 0 {
                observation.byte_length = result.kernel.canonical_byte_length;
            }
            if observation.owner_digest.is_empty() {
                observation.owner_digest = digest_owner(&observation, &result.kernel)?;
            }
            kernels.push(result.kernel);
            owners.push(observation);
        }
        self.accept_group_prepared(
            &PhysicalGroup {
                group_sequence: group.group_sequence,
                owners,
            },
            Some(&kernels),
        )
    }

    pub fn seal(&self, request: &GenerationRequest) -> Result<GenerationDescriptor, CoreError> {
        self.check_cancelled()?;
        let mut statement = self.connection.prepare("SELECT group_sequence, owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, owner_digest, row_count, byte_length, final_batch FROM urdira_core_owner_stage WHERE operation_id = ?1 AND candidate_generation_id = ?2 ORDER BY group_sequence, owner_artifact_id, owner_artifact_version_id, observation_lane, sequence").map_err(sql_error)?;
        let mut rows = statement
            .query((&request.operation_id, &request.candidate_generation_id))
            .map_err(sql_error)?;
        let mut hasher = Sha256::new();
        let mut groups = HashSet::new();
        let mut owners = HashMap::<(String, String, String), (u64, bool)>::new();
        let mut unique_owner_keys = HashSet::<(String, String)>::new();
        let mut row_count = 0usize;
        let mut bytes = 0usize;
        let mut expected_group = 0_u64;
        let mut last_group = None;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let group: u64 = row.get(0).map_err(sql_error)?;
            if last_group != Some(group) {
                if group != expected_group {
                    return Err(CoreError("generation groups are not contiguous".into()));
                }
                expected_group = expected_group.saturating_add(1);
                last_group = Some(group);
            }
            groups.insert(group);
            let artifact_id: String = row.get(1).map_err(sql_error)?;
            let version_id: String = row.get(2).map_err(sql_error)?;
            let observation_lane: String = row.get(3).map_err(sql_error)?;
            let sequence: u64 = row.get(4).map_err(sql_error)?;
            let final_batch: bool = row.get::<_, i64>(8).map_err(sql_error)? != 0;
            unique_owner_keys.insert((artifact_id.clone(), version_id.clone()));
            let owner_key = (
                artifact_id.clone(),
                version_id.clone(),
                observation_lane.clone(),
            );
            if let Some((previous_sequence, previous_final)) = owners.get(&owner_key) {
                if sequence != previous_sequence.saturating_add(1) || *previous_final {
                    return Err(CoreError(format!(
                        "owner observation sequences are not contiguous: owner={} version={} previous={} current={} previous_final={}",
                        artifact_id, version_id, previous_sequence, sequence, previous_final
                    )));
                }
            } else if sequence != 0 {
                return Err(CoreError(format!(
                    "owner observation sequence must start at zero: owner={} version={} current={}",
                    artifact_id, version_id, sequence
                )));
            }
            owners.insert(owner_key, (sequence, final_batch));
            let owner_rows: usize = row.get::<_, i64>(6).map_err(sql_error)? as usize;
            let owner_bytes: usize = row.get::<_, i64>(7).map_err(sql_error)? as usize;
            row_count += owner_rows;
            bytes += owner_bytes;
            hasher.update(group.to_be_bytes());
            let values = [
                artifact_id,
                version_id,
                observation_lane,
                sequence.to_string(),
                row.get::<_, String>(5).map_err(sql_error)?,
            ];
            for value in values {
                hasher.update((value.len() as u64).to_be_bytes());
                hasher.update(value.as_bytes());
            }
        }
        if owners.values().any(|(_, final_batch)| !final_batch) {
            return Err(CoreError(
                "generation contains an owner without a final batch".into(),
            ));
        }
        let mut ordered_digest = String::from("sha256:");
        for byte in hasher.finalize() {
            write!(&mut ordered_digest, "{byte:02x}").expect("String write");
        }
        Ok(GenerationDescriptor {
            operation_id: request.operation_id.clone(),
            candidate_generation_id: request.candidate_generation_id.clone(),
            group_count: groups.len(),
            owner_count: unique_owner_keys.len(),
            row_count,
            byte_length: bytes,
            ordered_digest,
        })
    }

    pub fn publish<S: PublicationSink>(
        &mut self,
        request: &GenerationRequest,
        descriptor: &GenerationDescriptor,
        sink: &mut S,
    ) -> Result<(), CoreError> {
        let publish_entry = Instant::now();
        self.ensure_mutation_lease()?;
        self.check_cancelled()?;
        // Build the read-side join indexes only after all groups have been
        // accepted. This preserves the exact set-based publication plans
        // while removing secondary-index maintenance from the hot ingest
        // loop. A genuinely cold direct publication has no durable rows to
        // probe or conflict with, and every join key is already covered by
        // the TEMP tables' primary keys; avoid building three full indexes
        // before the first publication. Replays and incremental generations
        // retain the indexed path because they join against prior state.
        let cold_direct = request.direct_publication
            && !self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM record_occurrences WHERE workspace_id = ?1 LIMIT 1)",
                    [&request.workspace_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(sql_error)?;
        if !cold_direct {
            self.connection
                .execute_batch("CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_publication_order ON urdira_core_owner_rows (lane, publication_record_id, owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal); CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_record_id ON urdira_core_owner_rows (lane, publication_record_id); CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_dependency_binding ON urdira_core_owner_rows (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, lane, proposal_key); CREATE INDEX IF NOT EXISTS urdira_core_owner_facets_join ON urdira_core_owner_facets (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, facet_ordinal);")
                .map_err(sql_error)?;
            debug_log_missing_incremental_indexes(&self.connection);
        }
        let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
        if debug_timing {
            eprintln!(
                "[urdira-indexing-core] publish prepare_ms={}",
                publish_entry.elapsed().as_millis()
            );
        }
        let transaction_started = Instant::now();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        if debug_timing {
            eprintln!(
                "[urdira-indexing-core] publish transaction_begin_ms={}",
                transaction_started.elapsed().as_millis()
            );
        }
        sink.publish(&transaction, request, descriptor)?;
        let commit_started = Instant::now();
        transaction.commit().map_err(sql_error)?;
        if debug_timing {
            eprintln!(
                "[urdira-indexing-core] publish commit_ms={}",
                commit_started.elapsed().as_millis()
            );
        }
        // A cold direct publication writes a multi-gigabyte WAL in one
        // transaction. Truncating it here, while this connection still holds
        // the exclusive structural writer lease, pays the checkpoint cost
        // once instead of leaving it for the next reader or scan to absorb
        // as lock contention (see docs/evidence/2026-09-01-fase0-baseline-instrumentado.md).
        // A busy checkpoint is not fatal: it simply leaves frames for the
        // detached maintenance pass, exactly as the existing post-publication
        // checkpoint scheduling already tolerates.
        if cold_direct {
            let checkpoint_started = Instant::now();
            match self
                .connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                }) {
                Ok((busy, frames, checkpointed)) => {
                    if debug_timing {
                        eprintln!(
                            "[urdira-indexing-core] publish cold_checkpoint_ms={} busy={} frames={} checkpointed={}",
                            checkpoint_started.elapsed().as_millis(),
                            busy,
                            frames,
                            checkpointed
                        );
                    }
                }
                Err(error) => {
                    if debug_timing {
                        eprintln!(
                            "[urdira-indexing-core] publish cold_checkpoint deferred: {error}"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    /// Returns the generation that is visible after the most recent Rust
    /// publication. The source-stage counter may be ahead of the workspace
    /// pointer after a crash, so callers must not derive this from
    /// `base_generation + 1`.
    pub fn visible_generation(&self, workspace_id: &str) -> Result<i64, CoreError> {
        self.connection
            .query_row(
                "SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(sql_error)
    }

    /// Releases the cross-process mutation lease and immediately tries to
    /// reacquire it, backing off briefly on contention. This gives a
    /// foreground writer waiting on the same lock (`packages/storage/src/storage.ts`'s
    /// `acquireWorkspaceMutationLock`) a real window to run between chunks of
    /// a long detached maintenance pass, instead of that pass holding the
    /// lease continuously across its whole multi-minute duration.
    ///
    /// Bounded by the same deadline `check_cancelled` already enforces
    /// (`self.deadline_ms`, set by the caller to a generous post-publication
    /// window -- see `post_publication_deadline_ms` in
    /// `urdira-indexing-worker`) so this never spins forever if some other
    /// writer holds the lease pathologically long; on timeout it returns the
    /// same deadline-exceeded error `check_cancelled` already produces
    /// elsewhere, which propagates out of the caller (`reconcile_lexical`)
    /// and is retried as a whole by `schedule_lexical_reconcile`'s own
    /// independent (and longer) 10-minute retry budget.
    fn yield_mutation_lease(&mut self) -> Result<(), CoreError> {
        self.release_mutation_lease();
        loop {
            match self.ensure_mutation_lease() {
                Ok(()) => return Ok(()),
                Err(_) => {
                    self.check_cancelled()?;
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    /// Reconciles the lexical projection after the structural publication has
    /// committed.  This is intentionally owned by the Rust scheduler: the
    /// application only supplies the immutable CAS root and never opens a
    /// second TypeScript writer for the same workspace.
    ///
    /// A cold, corpus-scale workspace (n8n-scale: 14k+ documents) used to
    /// reconcile every stale/missing document inside one `BEGIN IMMEDIATE`
    /// transaction, holding the cross-process writer lease
    /// (`workspace_lease`/`ensure_mutation_lease` above) for minutes. A
    /// foreground structural mutation that only needed the lease for a few
    /// seconds could wait behind that single transaction for the pass's
    /// entire duration (docs/evidence/2026-09-01-f1-resultado.md). This
    /// method instead processes `stale` and `missing` in bounded chunks,
    /// each with its own transaction; between chunks it calls
    /// `yield_mutation_lease` above to release and reacquire the lease, so a
    /// foreground writer waiting on the lock never waits longer than one
    /// chunk's commit.
    ///
    /// Resumption/idempotency: `stale` and `missing` are computed ONCE up
    /// front, from the current `lexical_documents`/`artifact_versions`
    /// state, exactly as the previous single-transaction implementation did.
    /// Every chunk only ever inserts/updates rows drawn from those two
    /// precomputed lists, so a chunk boundary within one call never repeats
    /// work already committed by an earlier chunk of the SAME call. If
    /// `yield_mutation_lease` cannot reacquire the lease before its deadline
    /// (another writer is genuinely using it), this method returns that
    /// error without committing the in-progress chunk. The caller
    /// (`schedule_lexical_reconcile` in `urdira-indexing-worker`) then
    /// retries the WHOLE call after a short delay: because `stale`/`missing`
    /// are freshly recomputed from durable state at the top of every call,
    /// that retry sees the prior chunks' commits and only continues the
    /// remaining work -- no chunk is ever repeated across separate
    /// `reconcile_lexical` invocations either. The per-document cancellation
    /// check below still aborts the in-progress chunk's transaction without
    /// committing it (dropping an uncommitted `rusqlite::Transaction` rolls
    /// it back), so a cancellation only ever loses the current chunk, not
    /// previously committed ones.
    ///
    /// `lexical_index_state.completed_generation` is written -- and the
    /// generation is considered lexically complete -- only after every
    /// chunk of both `stale` and `missing` has committed, in one final small
    /// transaction (unchanged in effect from the previous single-transaction
    /// behavior: the marker only ever advances once the full reconcile is
    /// done). Partial chunks are visible in `lexical_documents`/
    /// `lexical_fts` as soon as they commit, but `core:search_text`'s
    /// pushdown-vs-fallback decision
    /// (`packages/engine/src/canonical-query-data-port.ts`'s `search_literal`)
    /// gates on `completed_generation` equaling the query's generation, so
    /// this generation's lexical index is never used as authoritative until
    /// the final chunk lands; until then, `search_text` stays on its
    /// exact source-catalog fallback.
    pub fn reconcile_lexical(
        &mut self,
        workspace_id: &str,
        cas_root: &str,
        generation: i64,
        max_document_bytes: usize,
    ) -> Result<(usize, usize, usize), CoreError> {
        self.ensure_mutation_lease()?;
        self.check_cancelled()?;
        let stale = {
            let mut statement = self.connection.prepare(
                "SELECT lexical_documents.artifact_id, lexical_documents.artifact_version_id, artifact_versions.valid_to_generation FROM lexical_documents JOIN artifact_versions ON artifact_versions.workspace_id = lexical_documents.workspace_id AND artifact_versions.artifact_id = lexical_documents.artifact_id AND artifact_versions.artifact_version_id = lexical_documents.artifact_version_id WHERE lexical_documents.workspace_id = ?1 AND lexical_documents.valid_to_generation IS NULL AND artifact_versions.valid_to_generation IS NOT NULL",
            ).map_err(sql_error)?;
            let rows = statement
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?
        };
        let missing = {
            let mut statement = self.connection.prepare(
                "SELECT artifact_id, artifact_version_id, content_hash, byte_length, valid_from_generation FROM artifact_versions WHERE workspace_id = ?1 AND encoding <> 'binary' AND valid_from_generation <= ?2 AND (valid_to_generation IS NULL OR valid_to_generation > ?2) AND NOT EXISTS (SELECT 1 FROM lexical_documents WHERE lexical_documents.workspace_id = artifact_versions.workspace_id AND lexical_documents.artifact_id = artifact_versions.artifact_id AND lexical_documents.artifact_version_id = artifact_versions.artifact_version_id) ORDER BY artifact_id, artifact_version_id",
            ).map_err(sql_error)?;
            let rows = statement
                .query_map(params![workspace_id, generation], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(sql_error)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(sql_error)?
        };
        let cancellation = self.cancellation.clone();

        // Chunk sizing bounds one transaction's writer-lease hold time, not
        // memory (`stale`/`missing` are already fully materialized above).
        // 512 documents keeps a content chunk's wall time to roughly a
        // couple of seconds against n8n-scale source files; the byte cap
        // guards against a chunk of unusually large text files blowing past
        // that time budget while staying under the document-count cap (a
        // single document over the byte cap is still processed alone rather
        // than stalled). Closing stale documents is a single UPDATE per row
        // with no CAS read, so it tolerates a much coarser chunk size.
        const CONTENT_CHUNK_MAX_DOCUMENTS: usize = 512;
        const CONTENT_CHUNK_MAX_BYTES: u64 = 8 * 1024 * 1024;
        const STALE_CHUNK_MAX_ROWS: usize = 4_096;

        let mut closed = 0usize;
        let mut stale_index = 0usize;
        while stale_index < stale.len() {
            if cancellation.is_cancelled() {
                return Err(CoreError("indexing operation cancelled".into()));
            }
            let chunk_end = (stale_index + STALE_CHUNK_MAX_ROWS).min(stale.len());
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(sql_error)?;
            for (artifact_id, version_id, closing_generation) in &stale[stale_index..chunk_end] {
                transaction.execute("UPDATE lexical_documents SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND artifact_id = ?3 AND artifact_version_id = ?4", params![closing_generation, workspace_id, artifact_id, version_id]).map_err(sql_error)?;
                closed += 1;
            }
            transaction.commit().map_err(sql_error)?;
            let _ = self.checkpoint_wal();
            stale_index = chunk_end;
            if stale_index < stale.len() || !missing.is_empty() {
                self.yield_mutation_lease()?;
            }
        }

        let mut inserted = 0usize;
        let mut oversized = 0usize;
        let mut missing_index = 0usize;
        while missing_index < missing.len() {
            if cancellation.is_cancelled() {
                return Err(CoreError("indexing operation cancelled".into()));
            }
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(sql_error)?;
            let mut chunk_bytes = 0u64;
            let mut chunk_count = 0usize;
            while missing_index < missing.len()
                && chunk_count < CONTENT_CHUNK_MAX_DOCUMENTS
                && (chunk_count == 0 || chunk_bytes < CONTENT_CHUNK_MAX_BYTES)
            {
                if cancellation.is_cancelled() {
                    return Err(CoreError("indexing operation cancelled".into()));
                }
                let (artifact_id, version_id, content_hash, byte_length, valid_from) =
                    &missing[missing_index];
                missing_index += 1;
                chunk_count += 1;
                if *byte_length < 0
                    || usize::try_from(*byte_length).unwrap_or(usize::MAX) > max_document_bytes
                {
                    oversized += 1;
                    continue;
                }
                chunk_bytes = chunk_bytes.saturating_add(u64::try_from(*byte_length).unwrap_or(0));
                let relative = content_hash
                    .strip_prefix("sha256:")
                    .ok_or_else(|| CoreError("lexical CAS hash is invalid".into()))?;
                if relative.len() < 2 || relative.bytes().any(|byte| !byte.is_ascii_hexdigit()) {
                    return Err(CoreError("lexical CAS hash is invalid".into()));
                }
                let path = PathBuf::from(cas_root)
                    .join("sha256")
                    .join(&relative[..2])
                    .join(&relative[2..]);
                let bytes = fs::read(path)
                    .map_err(|error| CoreError(format!("lexical CAS read failed: {error}")))?;
                let mut actual_hash = String::from("sha256:");
                for byte in Sha256::digest(&bytes) {
                    write!(&mut actual_hash, "{byte:02x}").expect("String write");
                }
                if bytes.len() != *byte_length as usize || &actual_hash != content_hash {
                    return Err(CoreError(
                        "lexical CAS bytes do not match artifact metadata".into(),
                    ));
                }
                if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                    continue;
                }
                let text = std::str::from_utf8(&bytes).expect("validated UTF-8");
                let normalized: String = text.nfkc().flat_map(char::to_lowercase).collect();
                transaction.execute("INSERT INTO lexical_documents (artifact_id, workspace_id, artifact_version_id, content_hash, byte_length, storage_reference, valid_from_generation, valid_to_generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)", params![artifact_id, workspace_id, version_id, content_hash, byte_length, format!("cas:{content_hash}"), valid_from]).map_err(sql_error)?;
                transaction.execute("INSERT INTO lexical_fts (workspace_id, artifact_id, artifact_version_id, content) VALUES (?1, ?2, ?3, ?4)", params![workspace_id, artifact_id, version_id, normalized]).map_err(sql_error)?;
                inserted += 1;
            }
            transaction.commit().map_err(sql_error)?;
            let _ = self.checkpoint_wal();
            if missing_index < missing.len() {
                self.yield_mutation_lease()?;
            }
        }

        // Seal completion in its own small, final transaction only after
        // every stale/missing chunk above has committed. This preserves the
        // previous single-transaction contract that the completion marker
        // never advances until the whole reconcile is done, while keeping
        // this last write itself bounded and cheap regardless of how many
        // content chunks preceded it. The mutation lease is already held at
        // this point: the initial `ensure_mutation_lease` call at the top of
        // this method acquired it, and every subsequent release is always
        // immediately followed either by `yield_mutation_lease` reacquiring
        // it or by this method returning an error -- the loops above never
        // fall through to here without the lease.
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        transaction.execute("INSERT INTO lexical_index_state (workspace_id, completed_generation) VALUES (?1, ?2) ON CONFLICT(workspace_id) DO UPDATE SET completed_generation = excluded.completed_generation", params![workspace_id, generation]).map_err(sql_error)?;
        transaction.commit().map_err(sql_error)?;
        Ok((closed, inserted, oversized))
    }

    fn check_cancelled(&self) -> Result<(), CoreError> {
        if self.cancellation_requested() {
            self.cancellation.cancel();
            Err(CoreError("indexing operation cancelled".into()))
        } else if self.deadline_ms.is_some_and(|deadline| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(u64::MAX, |value| {
                    value.as_millis().min(u128::from(u64::MAX)) as u64
                });
            now >= deadline
        }) {
            self.cancellation.cancel();
            Err(CoreError("indexing operation deadline exceeded".into()))
        } else {
            Ok(())
        }
    }
}

fn validate_generation_request(request: &GenerationRequest) -> Result<(), CoreError> {
    if request.cas_root.is_empty()
        || request.cas_root.len() > 4_096
        || !std::path::Path::new(&request.cas_root).is_absolute()
        || request
            .cas_root
            .bytes()
            .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
    {
        return Err(CoreError(
            "generation CAS root must be an absolute path".into(),
        ));
    }
    if let Some(path) = request.cancellation_path.as_ref() {
        let value = path.as_os_str().to_string_lossy();
        if value.is_empty()
            || value.len() > 1_024
            || !path.is_absolute()
            || value
                .bytes()
                .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
        {
            return Err(CoreError("cancellation_path is invalid".into()));
        }
    }
    if let Some(digest) = request.workspace_schema_digest.as_deref()
        && digest != WORKSPACE_V3_SCHEMA_DIGEST
    {
        return Err(CoreError("workspace-v3 schema digest mismatch".into()));
    }
    for (label, value) in [
        ("source_snapshot_id", request.source_snapshot_id.as_str()),
        ("source_state_digest", request.source_state_digest.as_str()),
        (
            "registry_snapshot_id",
            request.registry_snapshot_id.as_str(),
        ),
        (
            "configuration_revision_id",
            request.configuration_revision_id.as_str(),
        ),
        ("resolution_lock_id", request.resolution_lock_id.as_str()),
        ("engine.engine_id", request.engine.engine_id.as_str()),
        (
            "engine.engine_version",
            request.engine.engine_version.as_str(),
        ),
        (
            "engine.implementation_digest",
            request.engine.implementation_digest.as_str(),
        ),
    ] {
        validate_identifier(value, label)?;
    }
    if request.deadline_ms.is_some_and(|deadline| deadline == 0) {
        return Err(CoreError("deadline_ms must be positive".into()));
    }
    if let AuthoritativeChangeSet::Exact {
        changed_artifact_ids,
    } = &request.change_set
    {
        let mut seen = HashSet::new();
        for artifact_id in changed_artifact_ids {
            validate_identifier(artifact_id, "changed_artifact_id")?;
            if !seen.insert(artifact_id) {
                return Err(CoreError("change set contains a duplicate artifact".into()));
            }
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > 240
        || value
            .bytes()
            .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
    {
        return Err(CoreError(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_group(group: &PhysicalGroup) -> Result<(), CoreError> {
    if group.owners.is_empty() {
        return Err(CoreError("physical group owner bound exceeded".into()));
    }
    {
        // A physical group may contain multiple cursor pages for one logical
        // owner. The bound is on distinct owner identities, not page count;
        // giant owners therefore remain streamable across several pages.
        let distinct_owner_count = group
            .owners
            .iter()
            .map(|owner| (&owner.owner_artifact_id, &owner.owner_artifact_version_id))
            .collect::<HashSet<_>>()
            .len();
        if distinct_owner_count == 0 || distinct_owner_count > MAX_GROUP_OWNERS {
            return Err(CoreError("physical group owner bound exceeded".into()));
        }
    }
    let rows: usize = group.owners.iter().map(OwnerObservation::rows).sum();
    let bytes: usize = group.owners.iter().map(|owner| owner.byte_length).sum();
    if rows > MAX_GROUP_ROWS {
        return Err(CoreError("physical group row bound exceeded".into()));
    }
    if bytes > MAX_GROUP_BYTES {
        return Err(CoreError("physical group byte bound exceeded".into()));
    }
    let mut owners = HashSet::new();
    for owner in &group.owners {
        validate_identifier(&owner.owner_artifact_id, "owner_artifact_id")?;
        validate_identifier(
            &owner.owner_artifact_version_id,
            "owner_artifact_version_id",
        )?;
        validate_identifier(&owner.owner_path, "owner_path")?;
        validate_identifier(&owner.lane, "observation_lane")?;
        if !owners.insert((
            &owner.owner_artifact_id,
            &owner.owner_artifact_version_id,
            &owner.lane,
            owner.sequence,
        )) {
            return Err(CoreError(
                "physical group contains duplicate owner sequence".into(),
            ));
        }
    }
    Ok(())
}

/// Pure per-group canonicalization and digest pass, deliberately factored
/// out of `accept_engine_group_owned` so it can run off the single SQLite
/// writer thread (e.g. on a worker-pool thread) while that writer keeps
/// accepting earlier groups in order. It touches no `IndexingCore` state and
/// depends only on the group's own rows, so calling it for independent
/// groups from independent threads is safe; only the resulting
/// `accept_prepared_group` call must stay serialized and in strict
/// `group_sequence` order.
pub fn prepare_engine_group(
    mut normalized: PhysicalGroup,
) -> Result<
    (
        PhysicalGroup,
        Vec<urdira_native_core::StructuralKernelResult>,
    ),
    CoreError,
> {
    let mut kernels = Vec::with_capacity(normalized.owners.len());
    for owner in &mut normalized.owners {
        let kernel = structural_kernel_batch_parts(&owner.records, &owner.dependencies)
            .map_err(|error| CoreError(format!("owner {} rejected: {error}", owner.owner_path)))?;
        if owner.byte_length == 0 {
            owner.byte_length = kernel.canonical_byte_length;
        }
        if owner.owner_digest.is_empty() {
            owner.owner_digest = digest_owner(owner, &kernel)?;
        }
        kernels.push(kernel);
    }
    Ok((normalized, kernels))
}

fn digest_owner(
    owner: &OwnerObservation,
    kernel: &urdira_native_core::StructuralKernelResult,
) -> Result<String, CoreError> {
    let mut hasher = Sha256::new();
    for value in [
        owner.owner_artifact_id.as_str(),
        owner.owner_artifact_version_id.as_str(),
        owner.owner_path.as_str(),
        &owner.sequence.to_string(),
        if owner.final_batch {
            "final"
        } else {
            "partial"
        },
        kernel.records_digest.as_str(),
        kernel.dependencies_digest.as_str(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    let mut digest = String::from("sha256:");
    for byte in hasher.finalize() {
        write!(&mut digest, "{byte:02x}")
            .map_err(|_| CoreError("digest formatting failed".into()))?;
    }
    Ok(digest)
}

fn digest_group(group: &PhysicalGroup) -> Result<String, CoreError> {
    let mut hasher = Sha256::new();
    hasher.update(group.group_sequence.to_be_bytes());
    for owner in &group.owners {
        for value in [
            &owner.owner_artifact_id,
            &owner.owner_artifact_version_id,
            &owner.owner_path,
            &owner.lane,
            &owner.sequence.to_string(),
            &owner.owner_digest,
        ] {
            hasher.update((value.len() as u64).to_be_bytes());
            hasher.update(value.as_bytes());
        }
    }
    let mut digest = String::from("sha256:");
    for byte in hasher.finalize() {
        write!(&mut digest, "{byte:02x}")
            .map_err(|_| CoreError("digest formatting failed".into()))?;
    }
    Ok(digest)
}

fn sql_error(error: rusqlite::Error) -> CoreError {
    CoreError(format!("SQLite indexing-core error: {error}"))
}

trait OptionalRow<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}
impl<T> OptionalRow<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> GenerationRequest {
        GenerationRequest {
            operation_id: "operation:test".into(),
            workspace_id: "workspace:test".into(),
            candidate_generation_id: "candidate:test".into(),
            cancellation_path: None,
            direct_publication: false,
            source_snapshot_id: "snapshot:test".into(),
            cas_root: "/tmp/urdira-cas".into(),
            source_state_digest: "sha256:source".into(),
            base_generation: 0,
            registry_snapshot_id: "registry:test".into(),
            configuration_revision_id: "configuration:test".into(),
            resolution_lock_id: "lock:test".into(),
            workspace_schema_digest: None,
            change_set: AuthoritativeChangeSet::Exact {
                changed_artifact_ids: vec![],
            },
            candidate: None,
            frozen_base: None,
            work_manifest: None,
            engine: EngineDescriptor {
                engine_id: "engine:test".into(),
                engine_version: "1".into(),
                implementation_digest: "sha256:engine".into(),
            },
            deadline_ms: None,
        }
    }

    fn owner(path: &str, sequence: u64) -> OwnerObservation {
        let mut owner = OwnerObservation {
            owner_artifact_id: format!("artifact:{path}"),
            owner_artifact_version_id: format!("version:{path}"),
            owner_path: path.into(),
            lane: "structural".into(),
            sequence,
            final_batch: true,
            records: vec![StructuralKernelRecord {
                proposal_record_key: format!("proposal:{path}"),
                category: "entity".into(),
                kind: "jsts:entity_variable".into(),
                universal_kind: "core:variable".into(),
                facets: "[]".into(),
                schema_version: 1,
                source_span: "{}".into(),
                identity_key: format!("identity:{path}"),
                body: json!({"name": path}),
                evidence_references: "[]".into(),
            }],
            dependencies: vec![],
            byte_length: 0,
            owner_digest: String::new(),
            fact_delta_id: None,
            delta_digest: None,
        };
        let kernel = structural_kernel_batch(&owner.batch()).expect("kernel");
        owner.byte_length = kernel.canonical_byte_length;
        owner.owner_digest = digest_owner(&owner, &kernel).expect("digest");
        owner
    }

    struct Sink;
    impl PublicationSink for Sink {
        fn publish(
            &mut self,
            transaction: &Transaction<'_>,
            _request: &GenerationRequest,
            descriptor: &GenerationDescriptor,
        ) -> Result<(), CoreError> {
            transaction
                .execute(
                    "CREATE TABLE IF NOT EXISTS test_published (digest TEXT NOT NULL)",
                    [],
                )
                .map_err(sql_error)?;
            transaction
                .execute(
                    "INSERT INTO test_published (digest) VALUES (?)",
                    [&descriptor.ordered_digest],
                )
                .map_err(sql_error)?;
            Ok(())
        }
    }

    #[test]
    fn accepts_bounded_groups_and_publishes_atomically() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let group = PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("a.ts", 0), owner("b.ts", 0)],
        };
        assert!(matches!(
            core.accept_group(&group),
            Ok(GroupAcceptance::Inserted(_))
        ));
        let stats: (i64, i64, i64, i64, String, String) = core
            .connection
            .query_row(
                "SELECT record_count, facet_count, identity_count, body_byte_length, first_record_id, last_record_id FROM urdira_core_generation_stats WHERE operation_id = 'operation:test' AND candidate_generation_id = 'candidate:test'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .expect("generation stats");
        assert_eq!(stats.0, 2);
        assert_eq!(stats.1, 0);
        assert_eq!(stats.2, 2);
        assert!(stats.3 > 0);
        assert!(stats.4 <= stats.5);
        let descriptor = core.seal(&request).expect("seal");
        let mut sink = Sink;
        core.publish(&request, &descriptor, &mut sink)
            .expect("publish");
        let count: i64 = core
            .connection
            .query_row("SELECT count(*) FROM test_published", [], |row| row.get(0))
            .expect("published row");
        assert_eq!(count, 1);
    }

    #[test]
    fn engine_groups_derive_canonical_length_and_digest_from_transport_rows() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let mut transport_owner = owner("transport.ts", 0);
        // The private engine protocol may omit derived integrity fields. In
        // particular, FactDelta's transport byte length is not UCE length.
        transport_owner.byte_length = 0;
        transport_owner.owner_digest.clear();
        let receipt = core
            .accept_engine_group(&PhysicalGroup {
                group_sequence: 0,
                owners: vec![transport_owner],
            })
            .expect("engine group");
        assert!(matches!(receipt, GroupAcceptance::Inserted(_)));
        let staged_length: i64 = core
            .connection
            .query_row(
                "SELECT byte_length FROM urdira_core_owner_stage WHERE owner_path = 'transport.ts'",
                [],
                |row| row.get(0),
            )
            .expect("derived length");
        assert!(staged_length > 0);
    }

    #[test]
    fn allows_cursor_pages_for_one_giant_owner_without_counting_each_page_as_an_owner() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let mut pages = Vec::new();
        for sequence in 0..65 {
            let mut page = owner("giant.ts", sequence);
            page.final_batch = sequence == 64;
            let kernel = structural_kernel_batch(&page.batch()).expect("kernel");
            page.owner_digest = digest_owner(&page, &kernel).expect("digest");
            pages.push(page);
        }
        let acceptance = core
            .accept_group(&PhysicalGroup {
                group_sequence: 0,
                owners: pages,
            })
            .expect("giant owner pages should be accepted");
        let owner_count = match acceptance {
            GroupAcceptance::Inserted(receipt) | GroupAcceptance::AlreadyAccepted(receipt) => {
                receipt.owner_count
            }
        };
        assert_eq!(owner_count, 1);
    }

    #[test]
    fn combined_generation_keeps_syntax_and_semantic_receipts_separate() {
        let generation = request();
        let syntax = owner("combined.ts", 0);
        let mut semantic = syntax.clone();
        semantic.lane = "semantic".into();
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        core.accept_engine_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![syntax],
        })
        .expect("syntax group");
        core.accept_engine_group(&PhysicalGroup {
            group_sequence: 1,
            owners: vec![semantic],
        })
        .expect("semantic group");
        let descriptor = core.seal(&generation).expect("seal");
        assert_eq!(descriptor.owner_count, 1);
        assert_eq!(descriptor.group_count, 2);
    }

    #[test]
    fn canonical_group_preserves_producer_fact_delta_identity() {
        let generation = request();
        let source = owner("canonical.ts", 0);
        let kernel = structural_kernel_batch(&source.batch()).expect("kernel");
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        core.accept_canonical_group_owned(CanonicalPhysicalGroup {
            group_sequence: 0,
            owners: vec![CanonicalOwnerObservation {
                owner_artifact_id: source.owner_artifact_id,
                owner_artifact_version_id: source.owner_artifact_version_id,
                owner_path: source.owner_path,
                lane: "structural".into(),
                sequence: 0,
                final_batch: true,
                canonical_records: kernel.canonical_records,
                canonical_dependencies: kernel.canonical_dependencies,
                byte_length: 0,
                owner_digest: String::new(),
                fact_delta_id: Some("jsts:delta:candidate:test:work:artifact:canonical.ts".into()),
                delta_digest: Some("sha256:delta-canonical".into()),
                diagnostic_codes: Vec::new(),
            }],
        })
        .expect("canonical group");
        let stored: Option<String> = core
            .connection
            .query_row(
                "SELECT fact_delta_id FROM urdira_core_owner_stage WHERE owner_path = 'canonical.ts'",
                [],
                |row| row.get(0),
            )
            .expect("owner receipt");
        assert_eq!(
            stored.as_deref(),
            Some("jsts:delta:candidate:test:work:artifact:canonical.ts")
        );
    }

    #[test]
    fn replays_identical_group_receipt_without_duplicate_rows() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let group = PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("a.ts", 0)],
        };
        assert!(matches!(
            core.accept_group(&group),
            Ok(GroupAcceptance::Inserted(_))
        ));
        assert!(matches!(
            core.accept_group(&group),
            Ok(GroupAcceptance::AlreadyAccepted(_))
        ));
        let count: i64 = core
            .connection
            .query_row("SELECT count(*) FROM urdira_core_owner_stage", [], |row| {
                row.get(0)
            })
            .expect("staged row count");
        assert_eq!(count, 1);
    }

    #[test]
    fn stages_body_payload_and_typed_digest_blobs_for_set_based_promotion() {
        // The staging relation no longer carries the legacy `publication_json`
        // envelope or a `canonical_text` echo (both were dead columns with no
        // SQL consumer); it stores the sha256/record/identity identifiers as
        // raw 32-byte BLOBs instead of their 71/72-byte text form. This test
        // exercises what actually matters on that path: the body payload and
        // the typed columns a promotion statement reads, plus the exact
        // `<prefix> || lower(hex(blob))` reconstruction every promotion SQL
        // statement relies on to keep durable bytes unchanged.
        let generation = request();
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        core.accept_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("metadata.ts", 0)],
        })
        .expect("group");
        let (payload, record_id_blob, category, record_digest_blob, reconstructed_record_id, reconstructed_record_digest): (
            Vec<u8>,
            Vec<u8>,
            String,
            Vec<u8>,
            String,
            String,
        ) = core
            .connection
            .query_row(
                "SELECT body_payload_hex, publication_record_id, record_category, record_digest, 'record:' || lower(hex(publication_record_id)), 'sha256:' || lower(hex(record_digest)) FROM urdira_core_owner_rows WHERE lane = 'records'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .expect("publication metadata");
        assert!(!payload.is_empty());
        assert_eq!(record_id_blob.len(), 32);
        assert_eq!(record_digest_blob.len(), 32);
        assert_eq!(category, "entity");
        assert!(reconstructed_record_id.starts_with("record:"));
        assert_eq!(reconstructed_record_id.len(), 71);
        assert!(reconstructed_record_digest.starts_with("sha256:"));
        assert_eq!(reconstructed_record_digest.len(), 71);
    }

    #[test]
    fn direct_publication_stages_the_same_typed_digest_blob_columns() {
        // Direct publication and the compatibility/oracle path now share the
        // exact same staging representation (the old JSON-encoding branch
        // that only ran for non-direct groups is gone along with the dead
        // `publication_json` column); assert the digest/identity BLOB columns
        // this path relies on are populated and well-formed for a direct
        // group too.
        let mut generation = request();
        generation.direct_publication = true;
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        core.accept_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("direct.ts", 0)],
        })
        .expect("group");
        let (identity_id_blob, identity_assignment_id_blob, identity_key_digest_blob, identity_type): (
            Vec<u8>,
            Vec<u8>,
            Vec<u8>,
            String,
        ) = core
            .connection
            .query_row(
                "SELECT identity_id, identity_assignment_id, identity_key_digest, identity_type FROM urdira_core_owner_rows WHERE lane = 'records'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("publication row");
        assert_eq!(identity_id_blob.len(), 32);
        assert_eq!(identity_assignment_id_blob.len(), 32);
        assert_eq!(identity_key_digest_blob.len(), 32);
        assert!(!identity_type.is_empty());
    }

    /// Regression guard for the incremental-publish blowup fixed alongside
    /// the TEMP-staging digest diet: `DIRECT_PUBLICATION_CLOSURES_SQL`'s two
    /// `NOT EXISTS` subqueries against `urdira_core_owner_rows` (aliased `p`)
    /// must compare the BARE `p.publication_record_id` BLOB column, not a
    /// `hex()`/`||`-wrapped one, so SQLite can seek the covering
    /// `(lane, publication_record_id)` index instead of linearly rescanning
    /// every staged row per outer `stale`/`predecessors` row. This was
    /// invisible on a cold generation (no prior durable rows means the
    /// correlated subquery never runs) and only regressed a populated
    /// workspace's incremental publish (measured on the n8n corpus: one
    /// mutation went from ~17s to ~163s). Build minimal durable
    /// `record_occurrences`/`identity_assignments` tables with their real
    /// production indexes plus a couple of TEMP-staged rows, then assert via
    /// `EXPLAIN QUERY PLAN` that every access -- durable and staging alike --
    /// is a `SEARCH`, and specifically that both correlated subqueries reach
    /// the composite index (`publication_record_id=?`), not just its `lane=?`
    /// prefix.
    #[test]
    fn direct_publication_closures_search_every_index_and_never_scan() {
        let request = request();
        let core = IndexingCore::open(":memory:", &request).expect("core");
        core.connection
            .execute_batch(
                "CREATE TABLE candidate_publication_record_closures (candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL, workspace_id TEXT NOT NULL, record_id TEXT NOT NULL, valid_to_generation INTEGER NOT NULL, PRIMARY KEY (candidate_generation_id, row_ordinal)); \
                 CREATE TABLE record_occurrences (record_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_artifact_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER); \
                 CREATE INDEX record_occurrences_workspace_owner_idx ON record_occurrences(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation); \
                 CREATE TABLE identity_assignments (identity_assignment_id TEXT NOT NULL, workspace_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_key TEXT NOT NULL, record_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER, PRIMARY KEY (workspace_id, identity_assignment_id, valid_from_generation)); \
                 CREATE INDEX identity_assignments_owner_key_idx ON identity_assignments(workspace_id, identity_type, identity_key, valid_from_generation, valid_to_generation, record_id); \
                 INSERT INTO urdira_core_owner_stage (operation_id, candidate_generation_id, group_sequence, owner_artifact_id, owner_artifact_version_id, owner_path, observation_lane, sequence, final_batch, row_count, byte_length, owner_digest, fact_delta_id, delta_digest) VALUES ('operation:test', 'candidate:test', 0, 'artifact:mutated', 'version:mutated', 'mutated.ts', 'structural', 0, 1, 50, 1600, 'sha256:owner', NULL, NULL); \
                 -- Populate the durable tables with a realistic shape: many
                 -- rows scattered across hundreds of OTHER owners (so the
                 -- owner-scoped index is actually selective -- with a single
                 -- owner in the table SQLite reasonably prefers a plain scan,
                 -- which would make this test's SEARCH assertion meaningless)
                 -- plus 50 rows that actually belong to the mutated owner.
                 WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM seq WHERE x < 4999) \
                 INSERT INTO record_occurrences SELECT 'record:noise' || x, 'workspace:test', 'artifact:other' || (x % 500), 1, NULL FROM seq; \
                 WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM seq WHERE x < 49) \
                 INSERT INTO record_occurrences SELECT 'record:old' || x, 'workspace:test', 'artifact:mutated', 1, NULL FROM seq; \
                 WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM seq WHERE x < 49) \
                 INSERT INTO identity_assignments SELECT 'sha256:assign' || x, 'workspace:test', 'entity', 'identity:mutated:old:' || x, 'record:old' || x, 1, NULL FROM seq; \
                 WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM seq WHERE x < 49) \
                 INSERT INTO urdira_core_owner_rows (owner_artifact_id, owner_artifact_version_id, observation_lane, sequence, row_ordinal, lane, proposal_key, publication_record_id, body_payload_hex, record_category, record_kind, record_universal_kind, record_schema_version, record_digest, body_digest, body_byte_length, identity_type, identity_key, identity_id, identity_assignment_id, identity_key_digest) SELECT 'artifact:mutated', 'version:mutated', 'structural', 0, x, 'records', 'proposal:mutated:' || x, randomblob(32), randomblob(16), 'entity', 'jsts:entity_variable', 'core:variable', 1, randomblob(32), randomblob(32), 10, 'entity', 'identity:mutated:new:' || x, randomblob(32), randomblob(32), randomblob(32) FROM seq; \
                 CREATE INDEX IF NOT EXISTS urdira_core_owner_rows_record_id ON urdira_core_owner_rows (lane, publication_record_id); \
                 ANALYZE;",
            )
            .expect("scratch schema and rows");
        let mut statement = core
            .connection
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {DIRECT_PUBLICATION_CLOSURES_SQL}"
            ))
            .expect("prepare plan");
        let plan_lines: Vec<String> = statement
            .query_map(
                params![
                    &request.operation_id,
                    &request.candidate_generation_id,
                    &request.workspace_id,
                    request.base_generation,
                    descriptor_generation(&request)
                ],
                |row| row.get::<_, String>(3),
            )
            .expect("query plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("plan rows");
        let plan = plan_lines.join("\n");
        assert!(
            !plan.contains("SCAN r "),
            "record_occurrences must be reached by SEARCH, not a full SCAN:\n{plan}"
        );
        assert!(
            !plan.contains("SCAN ia "),
            "identity_assignments must be reached by SEARCH, not a full SCAN:\n{plan}"
        );
        assert!(
            plan.contains("SEARCH r USING INDEX record_occurrences_workspace_owner_idx"),
            "expected an indexed SEARCH of record_occurrences:\n{plan}"
        );
        assert_eq!(
            plan.matches("publication_record_id=?").count(),
            2,
            "both NOT EXISTS subqueries over urdira_core_owner_rows must seek the \
             covering (lane, publication_record_id) index -- a bare `lane=?` seek \
             here means the comparison lost sargability and degraded back into an \
             O(stale_rows * staged_rows) rescan:\n{plan}"
        );
    }

    #[test]
    fn rust_scheduler_reconciles_lexical_projection_after_publish() {
        let request = request();
        let root = std::env::temp_dir().join(format!("urdira-lexical-{}", std::process::id()));
        let db_path = root.join("workspace.sqlite");
        let cas_root = root.join("cas");
        let hash = "sha256:dc5d63134fb696626c4bf28e1232434ab040acc10a66cfee55dacdd70dae82a3";
        let cas_path = cas_root.join("sha256").join(&hash[7..9]).join(&hash[9..]);
        std::fs::create_dir_all(cas_path.parent().expect("cas parent")).expect("cas dir");
        std::fs::write(&cas_path, b"Hello Rust").expect("cas bytes");
        let mut core =
            IndexingCore::open(db_path.to_str().expect("db path"), &request).expect("core");
        core.connection.execute_batch("CREATE TABLE artifact_versions (artifact_id TEXT NOT NULL, workspace_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, encoding TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER, PRIMARY KEY(workspace_id, artifact_id, artifact_version_id)); CREATE TABLE lexical_documents (artifact_id TEXT NOT NULL, workspace_id TEXT NOT NULL, artifact_version_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, storage_reference TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER, PRIMARY KEY(workspace_id, artifact_id, artifact_version_id)); CREATE VIRTUAL TABLE lexical_fts USING fts5(workspace_id UNINDEXED, artifact_id UNINDEXED, artifact_version_id UNINDEXED, content, tokenize='trigram'); CREATE TABLE lexical_index_state (workspace_id TEXT PRIMARY KEY, completed_generation INTEGER NOT NULL); CREATE TABLE workspace_current_state (workspace_id TEXT PRIMARY KEY, current_generation INTEGER NOT NULL); INSERT INTO workspace_current_state (workspace_id, current_generation) VALUES ('workspace:test', 7);").expect("schema");
        core.connection.execute("INSERT INTO artifact_versions (artifact_id, workspace_id, artifact_version_id, content_hash, byte_length, encoding, valid_from_generation) VALUES ('artifact:a.ts', 'workspace:test', 'version:a.ts', ?1, 10, 'utf8', 1)", [hash]).expect("artifact");
        let result = core
            .reconcile_lexical(
                "workspace:test",
                cas_root.to_str().expect("cas root"),
                1,
                2_000_000,
            )
            .expect("lexical");
        assert_eq!(result, (0, 1, 0));
        let indexed: String = core
            .connection
            .query_row(
                "SELECT content FROM lexical_fts WHERE artifact_id = 'artifact:a.ts'",
                [],
                |row| row.get(0),
            )
            .expect("fts row");
        assert_eq!(indexed, "hello rust");
        assert_eq!(
            core.visible_generation("workspace:test")
                .expect("visible generation"),
            7
        );
        drop(core);
        let _ = std::fs::remove_dir_all(root);
    }

    struct FailingSink;
    impl PublicationSink for FailingSink {
        fn publish(
            &mut self,
            transaction: &Transaction<'_>,
            _request: &GenerationRequest,
            _descriptor: &GenerationDescriptor,
        ) -> Result<(), CoreError> {
            transaction
                .execute(
                    "CREATE TABLE IF NOT EXISTS test_rollback (value INTEGER NOT NULL)",
                    [],
                )
                .map_err(sql_error)?;
            transaction
                .execute("INSERT INTO test_rollback (value) VALUES (1)", [])
                .map_err(sql_error)?;
            Err(CoreError("injected publication checkpoint failure".into()))
        }
    }

    #[test]
    fn failed_publication_rolls_back_every_write() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        core.accept_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("a.ts", 0)],
        })
        .expect("group");
        let descriptor = core.seal(&request).expect("seal");
        assert!(
            core.publish(&request, &descriptor, &mut FailingSink)
                .is_err()
        );
        let exists: i64 = core.connection.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'test_rollback'", [], |row| row.get(0)).expect("table lookup");
        assert_eq!(exists, 0);
    }

    #[test]
    fn rejects_conflicting_group_receipt_and_cancellation() {
        let request = request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let group = PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("a.ts", 0)],
        };
        assert!(matches!(
            core.accept_group(&group),
            Ok(GroupAcceptance::Inserted(_))
        ));
        let mut conflict = group.clone();
        conflict.owners[0].owner_digest = "sha256:other".into();
        assert!(core.accept_group(&conflict).is_err());
        core.cancellation().cancel();
        assert!(core.seal(&request).is_err());
    }

    #[test]
    fn rejects_expired_generation_before_mutation() {
        let mut generation = request();
        generation.deadline_ms = Some(1);
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        let error = core
            .accept_group(&PhysicalGroup {
                group_sequence: 0,
                owners: vec![owner("owner.ts", 0)],
            })
            .expect_err("deadline");
        assert!(error.0.contains("deadline exceeded"));
    }

    #[test]
    fn rejects_generation_without_an_absolute_cas_root() {
        let mut generation = request();
        generation.cas_root = "relative/cas".into();
        let result = IndexingCore::open(":memory:", &generation);
        assert!(result.is_err());
        assert!(
            result
                .err()
                .is_some_and(|error| error.0.contains("CAS root"))
        );
    }

    #[test]
    fn observes_private_cancellation_sidecar_before_staging() {
        let mut generation = request();
        let suffix = format!("{}-sidecar", std::process::id());
        let database_path =
            std::env::temp_dir().join(format!("urdira-indexing-core-{suffix}.sqlite"));
        let cancellation_path =
            std::env::temp_dir().join(format!("urdira-indexing-core-{suffix}.cancel"));
        let _ = remove_file(&database_path);
        let _ = remove_file(&cancellation_path);
        generation.cancellation_path = Some(cancellation_path.clone());
        let mut core =
            IndexingCore::open(database_path.to_str().expect("database path"), &generation)
                .expect("core");
        File::create(&cancellation_path).expect("cancellation marker");
        let error = core
            .accept_group(&PhysicalGroup {
                group_sequence: 0,
                owners: vec![owner("owner.ts", 0)],
            })
            .expect_err("cancellation marker");
        assert!(error.0.contains("cancelled"));
        drop(core);
        let _ = remove_file(&database_path);
    }

    #[test]
    fn shutdown_clears_recoverable_receipts() {
        let generation = request();
        let mut core = IndexingCore::open(":memory:", &generation).expect("core");
        core.accept_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![owner("owner.ts", 0)],
        })
        .expect("group");
        assert_eq!(core.recovered_group_count().expect("count"), 1);
        core.shutdown().expect("shutdown");
        assert_eq!(core.recovered_group_count().expect("count"), 0);
    }

    #[test]
    fn workspace_writer_lease_excludes_competing_connections() {
        let request = request();
        let path = std::env::temp_dir().join(format!(
            "urdira-indexing-core-lease-{}.sqlite",
            std::process::id()
        ));
        let first = IndexingCore::open(path.to_str().expect("path"), &request).expect("first");
        let second = IndexingCore::open(path.to_str().expect("path"), &request);
        match second {
            Ok(_) => panic!("competing writer must be rejected"),
            Err(error) => assert!(error.0.contains("writer is already active")),
        }
        drop(first);
        let reopened = IndexingCore::open(path.to_str().expect("path"), &request).expect("reopen");
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.urdira-writer.lock", path.display()));
    }

    /// Mirrors `workspace_writer_lease_excludes_competing_connections`, but
    /// for the scan/source-commit path's bounded-wait open: while another
    /// holder owns the lease, `open_with_lease_wait` must wait instead of
    /// failing on the first attempt (unlike plain `open`, exercised above),
    /// and must succeed as soon as that holder releases the lease -- the
    /// chunked-lexical-maintenance race this wrapper exists for
    /// (docs/evidence/2026-09-01-f1-resultado.md).
    #[test]
    fn open_with_lease_wait_retries_until_released() {
        let request = request();
        let path = std::env::temp_dir().join(format!(
            "urdira-indexing-core-lease-wait-released-{}.sqlite",
            std::process::id()
        ));
        let holder = IndexingCore::open(path.to_str().expect("path"), &request).expect("holder");
        let path_for_release = path.clone();
        let request_for_release = request.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(holder);
            // Keep the path alive for the releasing thread's own scope; the
            // waiter below reopens the same path once the lease is free.
            let _ = (path_for_release, request_for_release);
        });
        let waited = IndexingCore::open_with_lease_wait(path.to_str().expect("path"), &request)
            .expect("open_with_lease_wait must succeed once the holder releases the lease");
        drop(waited);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.urdira-writer.lock", path.display()));
    }

    /// If the lease is still contended when `open_with_lease_wait`'s budget
    /// runs out, the error propagated to the caller must be the same
    /// lease-contention error `open` produces instantly today -- callers
    /// (the Rust worker's `IndexGeneration`/`SourceIndexCommit` handlers)
    /// rely on that exact message to attach the TypeScript-side
    /// `storage:workspace_writer_busy` retryable code.
    #[test]
    fn open_with_lease_wait_reports_contention_after_deadline() {
        let request = request();
        let path = std::env::temp_dir().join(format!(
            "urdira-indexing-core-lease-wait-timeout-{}.sqlite",
            std::process::id()
        ));
        let holder = IndexingCore::open(path.to_str().expect("path"), &request).expect("holder");
        match IndexingCore::open_with_lease_wait_until(
            path.to_str().expect("path"),
            &request,
            Instant::now() + Duration::from_millis(50),
        ) {
            Ok(_) => panic!("contention must still be reported once the deadline elapses"),
            Err(error) => assert!(error.0.contains("writer is already active")),
        }
        drop(holder);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.urdira-writer.lock", path.display()));
    }
}
