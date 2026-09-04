//! v4 publish (plan §4.6/§2.4/§2.6): sort rows, `SegmentWriter::write_base`,
//! graph/metric Merkle roots, `MANIFEST`, `Queryable` event, then one
//! SQLite transaction (`snapshots`/`workspace_current_state`/
//! `control_plane_state`/`merkle_roots`/`generation_manifests`) and the
//! `ScanCompleted` event.
//!
//! `SegmentWriter::write_base` (`urdira-structural-store`, untouched by
//! this task) already does the page-cache-then-fsync split internally and
//! publishes `MANIFEST` atomically -- this module cannot observe a real
//! gap between "queryable" and "durable" the way plan §2.4 step 3
//! describes (mmap available before fsync/SQLite commit), since that
//! function performs both in one call. `Queryable` is therefore emitted
//! right after `write_base` returns, using its own `to_page_cache`/
//! `durable` timing breakdown for the two events' `timings` fields rather
//! than two genuinely separate publish steps. Documented deviation, not a
//! correctness issue: by the time `Queryable` is observed by any reader,
//! the durable phase has, in practice, already completed too (both
//! happened inside one prior synchronous call).

use super::ScanError;
use super::catalog::CatalogScanOutcome;
use super::materialize::{MaterializedGeneration, MaterializedPartitionedGeneration};
use super::scan::ScanRequest;
use super::timings::ScanClock;
use rayon::prelude::*;
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use urdira_structural_store::row::CATEGORY_RELATION;
use urdira_structural_store::writer::SegmentWriter;
use urdira_structural_store::{BucketedMerkleSet, SetKind, to_prefixed_hex};
use urdira_worker_protocol::{IndexingEvent, ScanRoots};

fn hex_of(bytes: impl AsRef<[u8]>) -> String {
    let mut output = String::new();
    for byte in bytes.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

// -- UCE / json_digest / digest_envelope, ported byte-for-byte from
// `crates/urdira-indexing-worker/src/main.rs`'s private `uce`/`uce_varint`/
// `json_digest`/`digest_envelope` (main.rs:4557-4612, 5135-5138). Kept as
// an independent copy per this task's isolation rule (main.rs cannot be
// touched beyond `mod v4;` + the dispatch arm). This is the SAME tagged
// encoding `urdira-native-core`'s private `update_uce_value` uses
// internally (verified line-for-line against both), so this is a
// documented re-derivation, not a guess.
fn uce_varint(mut value: usize, output: &mut Vec<u8>) {
    loop {
        let next = (value % 128) as u8;
        value /= 128;
        output.push(next | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn uce(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Null => output.push(0),
        Value::Bool(false) => output.push(1),
        Value::Bool(true) => output.push(2),
        Value::String(text) => {
            output.push(3);
            uce_varint(text.len(), output);
            output.extend_from_slice(text.as_bytes());
        }
        Value::Number(number) => {
            output.push(7);
            let parsed = number.as_f64().unwrap_or(0.0);
            output.extend_from_slice(&(if parsed == 0.0 { 0.0 } else { parsed }).to_be_bytes());
        }
        Value::Array(values) => {
            output.push(5);
            uce_varint(values.len(), output);
            for value in values {
                uce(value, output);
            }
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            output.push(6);
            uce_varint(entries.len(), output);
            for (key, value) in entries {
                uce(&Value::String(key.clone()), output);
                uce(value, output);
            }
        }
    }
}

fn json_digest(value: &Value) -> String {
    let mut encoded = Vec::new();
    uce(value, &mut encoded);
    format!("sha256:{}", hex_of(Sha256::digest(encoded)))
}

fn digest_envelope(domain: &str, recipe: &str, schema: &str, payload: &Value) -> String {
    json_digest(&serde_json::json!([
        "urdira", 1, domain, recipe, 1, schema, 1, "sha256", payload
    ]))
}

/// Plan §8.2: `canonical_record_set_digest = sha256("urdira:record-set:v4\0"
/// || u64le(count) || root32)`.
fn record_set_digest(count: u64, root: [u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:record-set:v4\0");
    hasher.update(count.to_le_bytes());
    hasher.update(root);
    format!("sha256:{}", hex_of(hasher.finalize()))
}

/// Plan §8.2: `projection_set_digest = sha256("urdira:projection-set:v4\0"
/// || kind || 0 || u64le(count) || root32)`.
fn projection_set_digest(kind: &str, count: u64, root: [u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:projection-set:v4\0");
    hasher.update(kind.as_bytes());
    hasher.update([0u8]);
    hasher.update(count.to_le_bytes());
    hasher.update(root);
    format!("sha256:{}", hex_of(hasher.finalize()))
}

fn to_prefixed_hex_bytes(value: &[u8; 32]) -> String {
    to_prefixed_hex(value)
}

/// P2-2j item 2: the REAL cold-scan pipeline (`scan.rs::run_full`) now
/// calls [`publish_cold_partitioned`] instead -- this flat/globally-sorted
/// version is kept, unchanged, ONLY as `tests_e2e.rs`'s pre-existing
/// oracle/comparison path, hence `#[cfg_attr(not(test), allow(dead_code))]`.
#[cfg_attr(not(test), allow(dead_code))]
#[allow(clippy::too_many_arguments)]
pub fn publish_cold(
    conn: &mut Connection,
    request: &ScanRequest,
    structural_root: &Path,
    generation: i64,
    outcome: &CatalogScanOutcome,
    materialized: MaterializedGeneration,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<IndexingEvent, ScanError> {
    let MaterializedGeneration {
        mut records,
        mut dependencies,
        dicts,
        owner_ordinals: _,
    } = materialized;

    let generation_u64 = u64::try_from(generation)
        .map_err(|_| ScanError("generation must be non-negative".into()))?;

    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
    // Deterministic key order (plan §2.4 step 1/§2.2): sort by the primary
    // key each table is keyed on. `write_base` does its own internal
    // ordering too (`compute_order`), but sorting here keeps this
    // pipeline's own intermediate state (and any future debug dump of it)
    // in the same order the store publishes.
    let sort_elapsed = {
        let started = std::time::Instant::now();
        records.sort_by_key(|record| record.record_id);
        dependencies.sort_by_key(|dependency| dependency.dependency_id);
        started.elapsed()
    };

    let write_started = std::time::Instant::now();
    let writer = SegmentWriter::new();
    let summary = writer
        .write_base(
            structural_root,
            &records,
            &dependencies,
            &dicts,
            generation_u64,
        )
        .map_err(|error| ScanError(format!("v4 publish: segment write failed: {error}")))?;
    let write_base_elapsed = write_started.elapsed();

    // Graph root (relation-category records only) and metric root (empty
    // set for now -- no metric projection generator exists yet, plan §12
    // "fuera de alcance" doesn't name metrics explicitly but no producer
    // in this task emits any `metric_projections`-equivalent row either).
    // Neither is computed by `urdira-structural-store` itself (it only
    // tracks `records`/`dependency`, per its own evidence doc), so this
    // module computes and persists them directly against the same
    // `merkle_bucket` primitives that crate re-exports.
    let graph_started = std::time::Instant::now();
    let graph_entries: Vec<([u8; 32], [u8; 32])> = records
        .iter()
        .filter(|record| record.category == CATEGORY_RELATION)
        .map(|record| (record.record_id, record.record_digest))
        .collect();
    let graph_set = BucketedMerkleSet::from_sorted(&graph_entries)
        .map_err(|error| ScanError(format!("v4 publish: graph merkle build failed: {error}")))?;
    let metric_set = BucketedMerkleSet::from_sorted(&[])
        .map_err(|error| ScanError(format!("v4 publish: metric merkle build failed: {error}")))?;
    let merkle_dir = structural_root.join("merkle");
    graph_set
        .write_to(
            &merkle_dir.join("graph.tree"),
            SetKind::Graph,
            generation_u64,
        )
        .map_err(|error| ScanError(format!("v4 publish: graph merkle persist failed: {error}")))?;
    metric_set
        .write_to(
            &merkle_dir.join("metric.tree"),
            SetKind::Metric,
            generation_u64,
        )
        .map_err(|error| ScanError(format!("v4 publish: metric merkle persist failed: {error}")))?;
    let graph_elapsed = graph_started.elapsed();
    // P2-2g item 4: `write_ms` now covers sort + `write_base`'s
    // page-cache-ready phase + the graph/metric Merkle build, not just
    // `write_base`'s own `to_page_cache` slice -- `sort_elapsed`/
    // `graph_elapsed` previously fell through every `ScanTimings` bucket
    // (this function never recorded them anywhere), one of two gaps this
    // task closed to make the reported phase table sum to `total_ms` (the
    // other is `analyze.rs`'s facts-extraction time, folded into
    // `parse_ms`). `fsync_ms` is unchanged: still exactly `write_base`'s
    // own durable-minus-page-cache slice.
    clock.record_write(sort_elapsed + summary.to_page_cache + graph_elapsed);
    clock.record_fsync(summary.durable.saturating_sub(summary.to_page_cache));
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 publish: sort={:.3}s write_base={:.3}s (to_page_cache={:.3}s durable={:.3}s) graph_metric_merkle={:.3}s graph_entries={}",
            sort_elapsed.as_secs_f64(),
            write_base_elapsed.as_secs_f64(),
            summary.to_page_cache.as_secs_f64(),
            summary.durable.as_secs_f64(),
            graph_elapsed.as_secs_f64(),
            graph_entries.len(),
        );
    }

    let manifest_path = structural_root.join("MANIFEST");
    let queryable_timings = clock.queryable_timings();
    on_queryable(IndexingEvent::Queryable {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation: generation_u64,
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        timings: queryable_timings,
    })
    .map_err(ScanError)?;

    let snapshot_started = std::time::Instant::now();
    let roots = ScanRoots {
        records: to_prefixed_hex_bytes(&summary.records_root),
        dependency: to_prefixed_hex_bytes(&summary.dependency_root),
        graph: to_prefixed_hex_bytes(&graph_set.root()),
        metric: to_prefixed_hex_bytes(&metric_set.root()),
    };
    let relation_count = records
        .iter()
        .filter(|record| record.category == CATEGORY_RELATION)
        .count();
    let snapshot_id = write_snapshot_transaction(
        conn,
        request,
        generation,
        outcome,
        records.len(),
        relation_count,
        dependencies.len(),
        &roots,
    )?;
    clock.record_snapshot(snapshot_started.elapsed());

    Ok(IndexingEvent::ScanCompleted {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation: generation_u64,
        snapshot_id,
        roots,
        timings: clock.completed_timings(),
    })
}

/// P2-2j item 2: partition-native counterpart of [`publish_cold`] -- takes
/// `MaterializedPartitionedGeneration` (`materialize::
/// materialize_cold_partitioned`'s output: `N_NIBBLES` already-sorted
/// partitions instead of one flat `Vec<RecordRow>`) and calls
/// `SegmentWriter::write_base_partitioned` instead of `write_base`, so this
/// pipeline never pays for a global `records.sort_by_key` OR `write_base`'s
/// own internal `compute_order` -- both are redundant once records already
/// exist as pre-sorted, nibble-aligned partitions (see
/// `write_base_partitioned`'s own doc comment for why concatenating them
/// in order is byte-for-byte the same global order either sort would
/// produce). Every other step (graph/metric merkle, `Queryable`, the
/// SQLite snapshot transaction) is IDENTICAL to `publish_cold`'s -- kept as
/// a full sibling function rather than a shared helper parameterized over
/// "flat vs partitioned" because the two only diverge in how `records`/
/// `graph_entries`/`relation_count` are computed, and forcing that through
/// one shared function reads worse than two short, direct ones. NOTE:
/// `write_ms` no longer includes a `sort_elapsed` component here (sorting
/// already happened per-partition inside `materialize_cold_partitioned`,
/// timed there as `materialize_ms`'s own `partition_sort` sub-phase) --
/// this is a deliberate bucket move, not a dropped cost; see this task's
/// evidence doc phase table.
#[allow(clippy::too_many_arguments)]
pub fn publish_cold_partitioned(
    conn: &mut Connection,
    request: &ScanRequest,
    structural_root: &Path,
    generation: i64,
    outcome: &CatalogScanOutcome,
    materialized: MaterializedPartitionedGeneration,
    clock: &mut ScanClock,
    on_queryable: &mut dyn FnMut(IndexingEvent) -> Result<(), String>,
) -> Result<IndexingEvent, ScanError> {
    let MaterializedPartitionedGeneration {
        partitions,
        dependencies,
        dicts,
    } = materialized;

    let generation_u64 = u64::try_from(generation)
        .map_err(|_| ScanError("generation must be non-negative".into()))?;

    let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();

    let write_started = std::time::Instant::now();
    let writer = SegmentWriter::new();
    let summary = writer
        .write_base_partitioned(
            structural_root,
            &partitions,
            &dependencies,
            &dicts,
            generation_u64,
        )
        .map_err(|error| {
            ScanError(format!(
                "v4 publish: partitioned segment write failed: {error}"
            ))
        })?;
    let write_base_elapsed = write_started.elapsed();

    // Graph root (relation-category records only) and metric root: same
    // rationale as `publish_cold`'s own (unchanged) comment -- neither is
    // computed by `urdira-structural-store` itself. Built here as flat
    // `(record_id, record_digest)` pairs via a parallel `flat_map` over the
    // partitions, never a concatenated `Vec<RecordRow>`.
    let graph_started = std::time::Instant::now();
    let graph_entries: Vec<([u8; 32], [u8; 32])> = partitions
        .par_iter()
        .flat_map_iter(|partition| {
            partition
                .iter()
                .filter(|record| record.category == CATEGORY_RELATION)
                .map(|record| (record.record_id, record.record_digest))
        })
        .collect();
    let graph_set = BucketedMerkleSet::from_sorted(&graph_entries)
        .map_err(|error| ScanError(format!("v4 publish: graph merkle build failed: {error}")))?;
    let metric_set = BucketedMerkleSet::from_sorted(&[])
        .map_err(|error| ScanError(format!("v4 publish: metric merkle build failed: {error}")))?;
    let merkle_dir = structural_root.join("merkle");
    graph_set
        .write_to(
            &merkle_dir.join("graph.tree"),
            SetKind::Graph,
            generation_u64,
        )
        .map_err(|error| ScanError(format!("v4 publish: graph merkle persist failed: {error}")))?;
    metric_set
        .write_to(
            &merkle_dir.join("metric.tree"),
            SetKind::Metric,
            generation_u64,
        )
        .map_err(|error| ScanError(format!("v4 publish: metric merkle persist failed: {error}")))?;
    let graph_elapsed = graph_started.elapsed();

    clock.record_write(summary.to_page_cache + graph_elapsed);
    clock.record_fsync(summary.durable.saturating_sub(summary.to_page_cache));
    if debug_timing {
        eprintln!(
            "[urdira-indexing-worker] v4 publish (partitioned): write_base={:.3}s (to_page_cache={:.3}s durable={:.3}s) graph_metric_merkle={:.3}s graph_entries={}",
            write_base_elapsed.as_secs_f64(),
            summary.to_page_cache.as_secs_f64(),
            summary.durable.as_secs_f64(),
            graph_elapsed.as_secs_f64(),
            graph_entries.len(),
        );
    }

    let manifest_path = structural_root.join("MANIFEST");
    let queryable_timings = clock.queryable_timings();
    on_queryable(IndexingEvent::Queryable {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation: generation_u64,
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        timings: queryable_timings,
    })
    .map_err(ScanError)?;

    let snapshot_started = std::time::Instant::now();
    let roots = ScanRoots {
        records: to_prefixed_hex_bytes(&summary.records_root),
        dependency: to_prefixed_hex_bytes(&summary.dependency_root),
        graph: to_prefixed_hex_bytes(&graph_set.root()),
        metric: to_prefixed_hex_bytes(&metric_set.root()),
    };
    let records_len: usize = partitions.iter().map(Vec::len).sum();
    let relation_count = graph_entries.len();
    let snapshot_id = write_snapshot_transaction(
        conn,
        request,
        generation,
        outcome,
        records_len,
        relation_count,
        dependencies.len(),
        &roots,
    )?;
    clock.record_snapshot(snapshot_started.elapsed());

    Ok(IndexingEvent::ScanCompleted {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation: generation_u64,
        snapshot_id,
        roots,
        timings: clock.completed_timings(),
    })
}

/// P3-1: the SQLite snapshot transaction for an INCREMENTAL (`Changed`)
/// generation -- `delta.rs`'s counterpart to `publish_cold` above.
/// `on_queryable`/`ScanCompleted` are the caller's responsibility (`delta::
/// run` already emits `Queryable` itself, right after `write_delta`
/// returns, mirroring `publish_cold`'s own split); this function only does
/// the durable SQLite half plus the terminal event.
#[allow(clippy::too_many_arguments)]
pub fn publish_delta(
    conn: &mut Connection,
    request: &ScanRequest,
    generation: i64,
    source_state_digest: &str,
    summary: &urdira_structural_store::writer::SegmentSummary,
    graph_root: [u8; 32],
    metric_root: [u8; 32],
    opened_records_count: usize,
    opened_deps_count: usize,
    graph_opened_count: usize,
    graph_closed_count: usize,
    clock: &mut ScanClock,
) -> Result<IndexingEvent, ScanError> {
    publish_delta_with_kind(
        conn,
        request,
        generation,
        source_state_digest,
        summary,
        graph_root,
        metric_root,
        opened_records_count,
        opened_deps_count,
        graph_opened_count,
        graph_closed_count,
        clock,
        "incremental",
    )
}

/// P1-D-c: [`publish_delta`]'s own body, generalized to accept
/// `publication_kind` -- `delta::run`'s ordinary edit path always passes
/// `"incremental"` (via `publish_delta` above, unchanged call sites), while
/// `v4::residual`'s background upgrade path passes `"semantic_upgrade"` so
/// `generation_manifests.publication_kind` records which pipeline produced
/// a given generation (decision 28: the residual pass publishes through
/// this SAME delta machinery, not a separate write path).
#[allow(clippy::too_many_arguments)]
pub fn publish_delta_with_kind(
    conn: &mut Connection,
    request: &ScanRequest,
    generation: i64,
    source_state_digest: &str,
    summary: &urdira_structural_store::writer::SegmentSummary,
    graph_root: [u8; 32],
    metric_root: [u8; 32],
    opened_records_count: usize,
    opened_deps_count: usize,
    graph_opened_count: usize,
    graph_closed_count: usize,
    clock: &mut ScanClock,
    publication_kind: &str,
) -> Result<IndexingEvent, ScanError> {
    let generation_u64 = u64::try_from(generation)
        .map_err(|_| ScanError("generation must be non-negative".into()))?;
    let prev_generation = generation - 1;

    let prev_snapshot_id: String = conn
        .query_row(
            "SELECT current_snapshot_id FROM workspace_current_state WHERE workspace_id = ?1",
            rusqlite::params![&request.workspace_id],
            |row| row.get(0),
        )
        .map_err(|error| {
            ScanError(format!(
                "v4 delta publish: reading prior snapshot_id failed: {error}"
            ))
        })?;

    // Plan §6.3's diff never double-counts (see `delta.rs`'s own doc
    // comment deriving this): `new_total = prev_total + opened - closures`
    // holds for records, dependencies, and the relation-only `graph`
    // subset alike, avoiding an O(corpus) rescan just to report a count.
    let prev_records_count = read_member_count(conn, "records", prev_generation)?;
    let prev_deps_count = read_member_count(conn, "dependency", prev_generation)?;
    let prev_graph_count = read_member_count(conn, "graph", prev_generation)?;

    let roots = ScanRoots {
        records: to_prefixed_hex_bytes(&summary.records_root),
        dependency: to_prefixed_hex_bytes(&summary.dependency_root),
        graph: to_prefixed_hex_bytes(&graph_root),
        metric: to_prefixed_hex_bytes(&metric_root),
    };

    let published_at = super::now_iso8601();
    let snapshot_id = format!("snapshot:{}:{generation}", request.workspace_id);
    let generation_manifest_id = format!("manifest:{}:{generation}", request.workspace_id);

    let records_total = prev_records_count + opened_records_count as i64;
    let deps_total = prev_deps_count + opened_deps_count as i64;
    let graph_total = prev_graph_count + graph_opened_count as i64 - graph_closed_count as i64;

    let canonical_record_set_digest =
        record_set_digest(records_total.max(0) as u64, decode_root(&roots.records)?);
    let projection_entries = [
        (
            "dependency",
            "core:v4-dependency-generator",
            decode_root(&roots.dependency)?,
            deps_total.max(0) as u64,
        ),
        (
            "graph",
            "core:v4-graph-generator",
            decode_root(&roots.graph)?,
            graph_total.max(0) as u64,
        ),
        (
            "metric",
            "core:v4-metric-generator",
            decode_root(&roots.metric)?,
            0,
        ),
    ];
    let projection_set_digests_json = serde_json::json!(
        projection_entries
            .iter()
            .map(|(kind, generator, root, count)| serde_json::json!({
                "projection_kind": kind,
                "generator": generator,
                "generator_version": "1",
                "generator_configuration_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                "projection_set_digest": projection_set_digest(kind, *count, *root),
            }))
            .collect::<Vec<_>>()
    );
    let projection_set_digests_text =
        serde_json::to_string(&projection_set_digests_json).map_err(|error| {
            ScanError(format!(
                "v4 delta publish: projection_set_digests serialization failed: {error}"
            ))
        })?;
    let capability_state_digest = digest_envelope(
        "core:capability_state",
        "core:capability_state_digest",
        "core:CapabilityStatePayload",
        &serde_json::json!([]),
    );
    let source_observation_watermarks = "[]".to_string();

    let mut snapshot_payload = serde_json::Map::new();
    snapshot_payload.insert("snapshot_id".into(), Value::String(snapshot_id.clone()));
    snapshot_payload.insert(
        "workspace_id".into(),
        Value::String(request.workspace_id.clone()),
    );
    snapshot_payload.insert("generation".into(), serde_json::json!(generation));
    snapshot_payload.insert(
        "generation_manifest_id".into(),
        Value::String(generation_manifest_id.clone()),
    );
    snapshot_payload.insert(
        "registry_snapshot_id".into(),
        Value::String(request.registry_snapshot_id.clone()),
    );
    snapshot_payload.insert(
        "resolution_lock_id".into(),
        Value::String(request.resolution_lock_id.clone()),
    );
    snapshot_payload.insert(
        "configuration_revision_id".into(),
        Value::String(request.configuration_revision_id.clone()),
    );
    snapshot_payload.insert(
        "source_state_digest".into(),
        Value::String(source_state_digest.to_string()),
    );
    snapshot_payload.insert(
        "source_observation_watermarks".into(),
        Value::String(source_observation_watermarks.clone()),
    );
    snapshot_payload.insert(
        "canonical_record_set_digest".into(),
        Value::String(canonical_record_set_digest.clone()),
    );
    snapshot_payload.insert(
        "projection_set_digests".into(),
        Value::String(projection_set_digests_text.clone()),
    );
    snapshot_payload.insert(
        "capability_state_digest".into(),
        Value::String(capability_state_digest.clone()),
    );
    snapshot_payload.insert("published_at".into(), Value::String(published_at.clone()));
    let snapshot_digest = digest_envelope(
        "core:snapshot",
        "core:snapshot_digest",
        "core:SnapshotDigestPayload",
        &Value::Object(snapshot_payload),
    );

    let transaction = conn.transaction().map_err(|error| {
        ScanError(format!(
            "v4 delta publish: opening SQLite transaction failed: {error}"
        ))
    })?;
    transaction
        .execute(
            "INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, NULL, NULL, ?10, ?11, ?12, ?13, ?14, ?15) ON CONFLICT DO NOTHING",
            params![
                &snapshot_id,
                &request.workspace_id,
                generation,
                &prev_snapshot_id,
                &generation_manifest_id,
                &request.registry_snapshot_id,
                &request.resolution_lock_id,
                &request.configuration_revision_id,
                source_state_digest,
                &source_observation_watermarks,
                &canonical_record_set_digest,
                &projection_set_digests_text,
                &capability_state_digest,
                &published_at,
                &snapshot_digest,
            ],
        )
        .map_err(|error| ScanError(format!("v4 delta publish: snapshots insert failed: {error}")))?;
    transaction
        .execute(
            "INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8) ON CONFLICT(workspace_id) DO UPDATE SET current_snapshot_id = excluded.current_snapshot_id, current_generation = excluded.current_generation, current_registry_snapshot_id = excluded.current_registry_snapshot_id, current_resolution_lock_id = excluded.current_resolution_lock_id, current_configuration_revision_id = excluded.current_configuration_revision_id, current_freshness_checkpoint_id = excluded.current_freshness_checkpoint_id, state_revision = workspace_current_state.state_revision + 1, updated_at = excluded.updated_at",
            params![
                &request.workspace_id,
                &snapshot_id,
                generation,
                &request.registry_snapshot_id,
                &request.resolution_lock_id,
                &request.configuration_revision_id,
                format!("freshness:{}:{generation}", request.workspace_id),
                &published_at,
            ],
        )
        .map_err(|error| ScanError(format!("v4 delta publish: workspace_current_state upsert failed: {error}")))?;
    for (set_kind, root_hex, member_count) in [
        ("records", &roots.records, records_total.max(0)),
        ("dependency", &roots.dependency, deps_total.max(0)),
        ("graph", &roots.graph, graph_total.max(0)),
        ("metric", &roots.metric, 0),
    ] {
        let root_bytes = decode_root(root_hex)?;
        transaction
            .execute(
                "INSERT INTO merkle_roots (set_kind, generation, root, member_count) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
                params![set_kind, generation, root_bytes.as_slice(), member_count],
            )
            .map_err(|error| ScanError(format!("v4 delta publish: merkle_roots insert failed: {error}")))?;
    }
    let candidate_generation_id = format!("candidate:v4:{}:{generation}", request.workspace_id);
    transaction
        .execute(
            "INSERT INTO candidate_state (candidate_generation_id, workspace_id, target_registry_snapshot_id, target_configuration_revision_id, trigger_kind, state, source_observation_batch_ids, issue_ids, created_at, published_snapshot_id, published_generation, generation_manifest_id) VALUES (?1, ?2, ?3, ?4, 'v4_incremental_scan', 'published', '[]', '[]', ?5, ?6, ?7, ?8) ON CONFLICT(candidate_generation_id) DO NOTHING",
            params![
                &candidate_generation_id,
                &request.workspace_id,
                &request.registry_snapshot_id,
                &request.configuration_revision_id,
                &published_at,
                &snapshot_id,
                generation,
                &generation_manifest_id,
            ],
        )
        .map_err(|error| ScanError(format!("v4 delta publish: candidate_state insert failed: {error}")))?;
    transaction
        .execute(
            "INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, '[]', '[]', '[]', '[]', '[]', ?9) ON CONFLICT DO NOTHING",
            params![
                &generation_manifest_id,
                &request.workspace_id,
                &candidate_generation_id,
                generation,
                &snapshot_id,
                &request.registry_snapshot_id,
                publication_kind,
                &published_at,
                format!("sha256:{}", hex_of(Sha256::digest(generation_manifest_id.as_bytes()))),
            ],
        )
        .map_err(|error| ScanError(format!("v4 delta publish: generation_manifests insert failed: {error}")))?;
    transaction
        .commit()
        .map_err(|error| ScanError(format!("v4 delta publish: SQLite commit failed: {error}")))?;

    Ok(IndexingEvent::ScanCompleted {
        request_id: request.request_id.clone(),
        operation_id: request.request_id.clone(),
        generation: generation_u64,
        snapshot_id,
        roots,
        timings: clock.completed_timings(),
    })
}

/// Reads the `member_count` this pipeline itself wrote (cold or delta,
/// `write_snapshot_transaction`/`publish_delta` both insert exactly one row
/// per `set_kind` per generation) for `set_kind` at `generation`. O(1) --
/// avoids an O(corpus) rescan just to report an incremental generation's
/// running totals (see `delta.rs`'s doc comment on why `new_total =
/// prev_total + opened - closures` is exact, not an approximation).
fn read_member_count(conn: &Connection, set_kind: &str, generation: i64) -> Result<i64, ScanError> {
    conn.query_row(
        "SELECT member_count FROM merkle_roots WHERE set_kind = ?1 AND generation = ?2",
        params![set_kind, generation],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|error| {
        ScanError(format!(
            "v4 delta publish: reading member_count for {set_kind}@{generation} failed: {error}"
        ))
    })
}

/// P2-2j item 2: takes `records_len`/`relation_count` directly rather than
/// `&[RecordRow]` -- the partitioned cold path (`publish_cold_partitioned`,
/// below) never assembles one flat `Vec<RecordRow>` at all, so the only
/// two facts this function actually needs out of it are cheap to compute
/// (in parallel) straight from the `N_NIBBLES` partitions instead. The
/// (unchanged) flat-`records` cold path pre-computes both the same way
/// `publish_cold` always did, just moved to its own call site.
#[allow(clippy::too_many_arguments)]
fn write_snapshot_transaction(
    conn: &mut Connection,
    request: &ScanRequest,
    generation: i64,
    outcome: &CatalogScanOutcome,
    records_len: usize,
    relation_count: usize,
    dependencies_count: usize,
    roots: &ScanRoots,
) -> Result<String, ScanError> {
    let published_at = super::now_iso8601();
    let snapshot_id = format!("snapshot:{}:{generation}", request.workspace_id);
    let generation_manifest_id = format!("manifest:{}:{generation}", request.workspace_id);

    let canonical_record_set_digest =
        record_set_digest(records_len as u64, decode_root(&roots.records)?);
    let projection_entries = [
        (
            "dependency",
            "core:v4-dependency-generator",
            decode_root(&roots.dependency)?,
            dependencies_count as u64,
        ),
        (
            "graph",
            "core:v4-graph-generator",
            decode_root(&roots.graph)?,
            relation_count as u64,
        ),
        (
            "metric",
            "core:v4-metric-generator",
            decode_root(&roots.metric)?,
            0,
        ),
    ];
    let projection_set_digests_json = serde_json::json!(
        projection_entries
            .iter()
            .map(|(kind, generator, root, count)| serde_json::json!({
                "projection_kind": kind,
                "generator": generator,
                "generator_version": "1",
                "generator_configuration_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                "projection_set_digest": projection_set_digest(kind, *count, *root),
            }))
            .collect::<Vec<_>>()
    );
    let projection_set_digests_text =
        serde_json::to_string(&projection_set_digests_json).map_err(|error| {
            ScanError(format!(
                "v4 publish: projection_set_digests serialization failed: {error}"
            ))
        })?;

    // v4 has no capability-state input yet (that JSON envelope is built by
    // TS candidate orchestration in v3, which does not exist for a
    // Rust-only cold scan) -- an empty capability set is a documented
    // placeholder, not a v3 mirror.
    let capability_state_digest = digest_envelope(
        "core:capability_state",
        "core:capability_state_digest",
        "core:CapabilityStatePayload",
        &serde_json::json!([]),
    );
    let source_observation_watermarks = "[]".to_string();

    let mut snapshot_payload = serde_json::Map::new();
    snapshot_payload.insert("snapshot_id".into(), Value::String(snapshot_id.clone()));
    snapshot_payload.insert(
        "workspace_id".into(),
        Value::String(request.workspace_id.clone()),
    );
    snapshot_payload.insert("generation".into(), serde_json::json!(generation));
    snapshot_payload.insert(
        "generation_manifest_id".into(),
        Value::String(generation_manifest_id.clone()),
    );
    snapshot_payload.insert(
        "registry_snapshot_id".into(),
        Value::String(request.registry_snapshot_id.clone()),
    );
    snapshot_payload.insert(
        "resolution_lock_id".into(),
        Value::String(request.resolution_lock_id.clone()),
    );
    snapshot_payload.insert(
        "configuration_revision_id".into(),
        Value::String(request.configuration_revision_id.clone()),
    );
    snapshot_payload.insert(
        "source_state_digest".into(),
        Value::String(outcome.source_state_digest.clone()),
    );
    snapshot_payload.insert(
        "source_observation_watermarks".into(),
        Value::String(source_observation_watermarks.clone()),
    );
    snapshot_payload.insert(
        "canonical_record_set_digest".into(),
        Value::String(canonical_record_set_digest.clone()),
    );
    snapshot_payload.insert(
        "projection_set_digests".into(),
        Value::String(projection_set_digests_text.clone()),
    );
    snapshot_payload.insert(
        "capability_state_digest".into(),
        Value::String(capability_state_digest.clone()),
    );
    snapshot_payload.insert("published_at".into(), Value::String(published_at.clone()));
    let snapshot_digest = digest_envelope(
        "core:snapshot",
        "core:snapshot_digest",
        "core:SnapshotDigestPayload",
        &Value::Object(snapshot_payload),
    );

    let transaction = conn.transaction().map_err(|error| {
        ScanError(format!(
            "v4 publish: opening SQLite transaction failed: {error}"
        ))
    })?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &request.registry_snapshot_id,
                &request.workspace_id,
                "1",
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                &request.resolution_lock_id,
                format!("sha256:{}", hex_of(Sha256::digest(request.registry_snapshot_id.as_bytes()))),
            ],
        )
        .map_err(|error| ScanError(format!("v4 publish: registry_snapshots insert failed: {error}")))?;
    transaction
        .execute(
            "INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, NULL, ?9, ?10, ?11, ?12, ?13, ?14) ON CONFLICT DO NOTHING",
            params![
                &snapshot_id,
                &request.workspace_id,
                generation,
                &generation_manifest_id,
                &request.registry_snapshot_id,
                &request.resolution_lock_id,
                &request.configuration_revision_id,
                &outcome.source_state_digest,
                &source_observation_watermarks,
                &canonical_record_set_digest,
                &projection_set_digests_text,
                &capability_state_digest,
                &published_at,
                &snapshot_digest,
            ],
        )
        .map_err(|error| ScanError(format!("v4 publish: snapshots insert failed: {error}")))?;
    transaction
        .execute(
            "INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8) ON CONFLICT(workspace_id) DO UPDATE SET current_snapshot_id = excluded.current_snapshot_id, current_generation = excluded.current_generation, current_registry_snapshot_id = excluded.current_registry_snapshot_id, current_resolution_lock_id = excluded.current_resolution_lock_id, current_configuration_revision_id = excluded.current_configuration_revision_id, current_freshness_checkpoint_id = excluded.current_freshness_checkpoint_id, state_revision = workspace_current_state.state_revision + 1, updated_at = excluded.updated_at",
            params![
                &request.workspace_id,
                &snapshot_id,
                generation,
                &request.registry_snapshot_id,
                &request.resolution_lock_id,
                &request.configuration_revision_id,
                format!("freshness:{}:{generation}", request.workspace_id),
                &published_at,
            ],
        )
        .map_err(|error| ScanError(format!("v4 publish: workspace_current_state upsert failed: {error}")))?;
    for (set_kind, root_hex, member_count) in [
        ("records", &roots.records, records_len),
        ("dependency", &roots.dependency, dependencies_count),
        ("graph", &roots.graph, relation_count),
        ("metric", &roots.metric, 0),
    ] {
        let root_bytes = decode_root(root_hex)?;
        transaction
            .execute(
                "INSERT INTO merkle_roots (set_kind, generation, root, member_count) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
                params![set_kind, generation, root_bytes.as_slice(), member_count as i64],
            )
            .map_err(|error| ScanError(format!("v4 publish: merkle_roots insert failed: {error}")))?;
    }
    // `generation_manifests.candidate_generation_id` has a `FOREIGN KEY`
    // into `candidate_state` (v3 candidate-lifecycle table). A v4 cold scan
    // has no real candidate: this is the minimal placeholder row the FK
    // requires, not a v3 mirror -- `state`/`trigger_kind` are informational
    // only, nothing reads this row back on the v4 route.
    let candidate_generation_id = format!("candidate:v4:{}:{generation}", request.workspace_id);
    transaction
        .execute(
            "INSERT INTO candidate_state (candidate_generation_id, workspace_id, target_registry_snapshot_id, target_configuration_revision_id, trigger_kind, state, source_observation_batch_ids, issue_ids, created_at, published_snapshot_id, published_generation, generation_manifest_id) VALUES (?1, ?2, ?3, ?4, 'v4_cold_scan', 'published', '[]', '[]', ?5, ?6, ?7, ?8) ON CONFLICT(candidate_generation_id) DO NOTHING",
            params![
                &candidate_generation_id,
                &request.workspace_id,
                &request.registry_snapshot_id,
                &request.configuration_revision_id,
                &published_at,
                &snapshot_id,
                generation,
                &generation_manifest_id,
            ],
        )
        .map_err(|error| ScanError(format!("v4 publish: candidate_state insert failed: {error}")))?;
    transaction
        .execute(
            "INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'cold', ?7, '[]', '[]', '[]', '[]', '[]', ?8) ON CONFLICT DO NOTHING",
            params![
                &generation_manifest_id,
                &request.workspace_id,
                &candidate_generation_id,
                generation,
                &snapshot_id,
                &request.registry_snapshot_id,
                &published_at,
                format!("sha256:{}", hex_of(Sha256::digest(generation_manifest_id.as_bytes()))),
            ],
        )
        .map_err(|error| ScanError(format!("v4 publish: generation_manifests insert failed: {error}")))?;
    transaction
        .commit()
        .map_err(|error| ScanError(format!("v4 publish: SQLite commit failed: {error}")))?;
    Ok(snapshot_id)
}

fn decode_root(hex: &str) -> Result<[u8; 32], ScanError> {
    let hex = hex.strip_prefix("sha256:").unwrap_or(hex);
    if hex.len() != 64 {
        return Err(ScanError(format!("root digest {hex} is not 32 bytes")));
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        let hi = hex.as_bytes()[index * 2] as char;
        let lo = hex.as_bytes()[index * 2 + 1] as char;
        *byte = ((hi
            .to_digit(16)
            .ok_or_else(|| ScanError("invalid hex digit".into()))?
            << 4)
            | lo.to_digit(16)
                .ok_or_else(|| ScanError("invalid hex digit".into()))?) as u8;
    }
    Ok(out)
}
