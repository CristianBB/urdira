//! `Catalog::apply`: one SQLite transaction that turns a [`crate::delta::Delta`]
//! into the exact row shapes `crates/urdira-indexing-worker/src/main.rs`'s
//! `apply_source_index_commits` (grep for it, `main.rs:4917`) applies for a
//! TS-produced commit — `source_observation_batches`, `source_observations`,
//! `content_blobs`, `source_artifacts`, `artifact_versions` (close old / open
//! new), `artifact_tombstones` (open / close), and `source_index_state`
//! (`state_revision + 1`, v4 `source_state_digest`) — so v3 readers
//! (`packages/engine/src/canonical-query-data-port.ts`, `get_source`) keep
//! working unchanged. See the evidence doc for the full row-by-row mapping.
//!
//! Deliberate scope narrowing versus `GenericSourceIndexer.apply` (both
//! documented in the evidence doc's "Deviations" section):
//! - No `source_observations` row is written for an *equivalent* observation
//!   (content and metadata digest both unchanged). `GenericSourceIndexer`
//!   writes one on every scan for every file, which is exactly the O(corpus)
//!   cost this crate exists to remove — see plan §4.1/§6.5 ("ya no existe
//!   ... TEMP `urdira_core_owner_rows`, closures SQL" etc., same spirit).
//! - `artifact_tombstones.absence_kind` is always `"deleted"`: this crate has
//!   no notion of an `"excluded"` absence (a file that fails inclusion rules
//!   is simply never observed, not tracked as a tombstone), so the
//!   TS `"reincluded"` vs `"recreated"` distinction on re-adding a
//!   previously-tombstoned uri collapses to always `"recreated"` here.

use crate::cas::storage_reference;
use crate::delta::Delta;
use crate::frontier::{Frontier, FrontierEntry, TombstoneEntry};
use crate::ids;
use crate::walker::Observation;
use rusqlite::{Connection, OptionalExtension, params};
use std::time::Instant;
use urdira_indexing_core::CoreError;

/// Fields this crate cannot derive on its own (who's applying, when).
/// Mirrors the subset of `SourceObservationBatchRecord` this crate actually
/// varies; the rest (`ordering_domain`, `observation_mode`, ...) are fixed
/// constants below.
#[derive(Debug, Clone)]
pub struct BatchMeta {
    pub source_provider_binding_id: String,
    pub source_provider: String,
    pub source_provider_version: String,
    pub started_at: String,
    pub completed_at: String,
    /// True for a complete, authoritative enumeration (a cold scan or a
    /// full rescan) — mirrors `coverage_completeness`/`deletion_authority`
    /// in `#enumerationRecord` (`directory-provider.ts:1321-1337`). False
    /// for an incremental batch scoped to specific paths.
    pub full_scan: bool,
}

/// Summary of one `Catalog::apply` call.
#[derive(Debug, Clone)]
pub struct AppliedCatalog {
    pub observation_batch_id: String,
    pub state_revision: i64,
    pub source_state_digest: String,
    pub added: usize,
    pub changed: usize,
    pub deleted: usize,
    pub equivalent: u64,
}

pub struct Catalog;

// P2-2h item 3 diagnostic (temporary, `URDIRA_DEBUG_TIMING`-gated):
// splits `insert_loop`'s time between id computation (`ids::*`, JSON-value
// build + SHA-256 + hex format per call) and actual SQLite dispatch
// (`execute`/`prepare_cached`), so a batching attempt targets whichever
// side actually dominates instead of guessing -- see this task's evidence
// doc for the measured split. Single-threaded call site (`Catalog::apply`'s
// loop, never parallel), so a plain `Cell` is enough.
thread_local! {
    static ID_COMPUTE_NANOS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static SQL_EXEC_NANOS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn add_id_compute_time(duration: std::time::Duration) {
    ID_COMPUTE_NANOS.with(|cell| cell.set(cell.get() + duration.as_nanos() as u64));
}

fn add_sql_exec_time(duration: std::time::Duration) {
    SQL_EXEC_NANOS.with(|cell| cell.set(cell.get() + duration.as_nanos() as u64));
}

/// Drains and returns `(id_compute_seconds, sql_exec_seconds)` accumulated
/// since the last call on this thread -- `Catalog::apply` reads this once,
/// right before its own debug report, then the counters start fresh for
/// the next call.
pub(crate) fn take_insert_loop_split() -> (f64, f64) {
    let id = ID_COMPUTE_NANOS.with(|cell| cell.replace(0));
    let sql = SQL_EXEC_NANOS.with(|cell| cell.replace(0));
    (id as f64 / 1e9, sql as f64 / 1e9)
}

fn sql_error(error: rusqlite::Error) -> CoreError {
    CoreError(format!("source catalog SQL error: {error}"))
}

impl Catalog {
    /// Applies `delta` to both SQLite (one transaction) and `frontier` (kept
    /// in sync in memory so the caller never has to re-run
    /// [`Frontier::load`]). On any error the transaction is rolled back and
    /// `frontier` is left untouched (mutations only happen after every
    /// fallible SQL statement for a given uri has already succeeded).
    pub fn apply(
        conn: &mut Connection,
        workspace_id: &str,
        frontier: &mut Frontier,
        delta: &Delta,
        generation: i64,
        batch_meta: &BatchMeta,
    ) -> Result<AppliedCatalog, CoreError> {
        let batch_id = ids::observation_batch_id(workspace_id, generation);
        let observation_count = (delta.added.len() + delta.changed.len()) as i64;
        let coverage_completeness = if batch_meta.full_scan {
            "complete"
        } else {
            "partial"
        };
        let deletion_authority = if batch_meta.full_scan {
            "authoritative"
        } else {
            "none"
        };
        let batch_digest = crate::digest::stable_id(
            "observation-batch-digest",
            &serde_json::json!({
                "batch_id": batch_id,
                "observation_count": observation_count,
                "deleted": delta.deleted.len(),
            }),
        );

        let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
        let transaction = conn.transaction().map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?3, 'scan', '[]', ?6, ?7, NULL, NULL, ?8, ?9, ?10, 0, ?11)",
                params![
                    batch_id,
                    workspace_id,
                    batch_meta.source_provider_binding_id,
                    batch_meta.source_provider,
                    batch_meta.source_provider_version,
                    coverage_completeness,
                    deletion_authority,
                    batch_meta.started_at,
                    batch_meta.completed_at,
                    observation_count,
                    batch_digest,
                ],
            )
            .map_err(sql_error)?;

        let insert_started = std::time::Instant::now();
        // P2-2h item 3: batched multi-row `INSERT`s for the cold/bulk
        // `added` path (see `insert_added_batch`'s doc comment) --
        // `changed`/`deleted` stay single-row (`apply_changed`/
        // `apply_deleted`, below, unchanged): an incremental scan's own
        // row counts are small enough that batching them would add
        // complexity for no measurable win, and this task's ≤0.6s target
        // is specifically the cold-scan gate, where `added` is the only
        // non-empty bucket (`ScanScope::Full` => "cold: todo es added",
        // per this module's own doc comment).
        for batch in delta.added.chunks(ADDED_BATCH_ROWS) {
            insert_added_batch(
                &transaction,
                workspace_id,
                &batch_id,
                generation,
                batch_meta,
                batch,
                frontier,
            )?;
        }
        for observation in &delta.changed {
            apply_changed(
                &transaction,
                workspace_id,
                &batch_id,
                generation,
                batch_meta,
                observation,
                frontier,
            )?;
        }
        for uri in &delta.deleted {
            apply_deleted(
                &transaction,
                workspace_id,
                &batch_id,
                generation,
                uri,
                frontier,
            )?;
        }
        let insert_elapsed = insert_started.elapsed();

        let digest_started = std::time::Instant::now();
        let source_state_digest = frontier.source_state_digest();
        let state_revision = upsert_source_index_state(
            &transaction,
            workspace_id,
            generation,
            &source_state_digest,
            &batch_meta.completed_at,
        )?;
        let digest_elapsed = digest_started.elapsed();

        let commit_started = std::time::Instant::now();
        transaction.commit().map_err(sql_error)?;
        let commit_elapsed = commit_started.elapsed();
        if debug_timing {
            let (id_compute_s, sql_exec_s) = take_insert_loop_split();
            eprintln!(
                "[urdira-source-frontier] catalog apply: insert_loop={:.3}s (id_compute={:.3}s sql_exec={:.3}s unaccounted={:.3}s) digest+upsert={:.3}s commit={:.3}s rows={}",
                insert_elapsed.as_secs_f64(),
                id_compute_s,
                sql_exec_s,
                (insert_elapsed.as_secs_f64() - id_compute_s - sql_exec_s).max(0.0),
                digest_elapsed.as_secs_f64(),
                commit_elapsed.as_secs_f64(),
                delta.added.len() + delta.changed.len() + delta.deleted.len(),
            );
        }

        Ok(AppliedCatalog {
            observation_batch_id: batch_id,
            state_revision,
            source_state_digest,
            added: delta.added.len(),
            changed: delta.changed.len(),
            deleted: delta.deleted.len(),
            equivalent: delta.equivalent_count,
        })
    }
}

fn insert_content_blob_if_absent(
    transaction: &rusqlite::Transaction<'_>,
    content_blob_id: &str,
    content_hash: &str,
    byte_length: u64,
) -> Result<(), CoreError> {
    transaction
        .prepare_cached(
            "INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(sql_error)?
        .execute(params![
            content_blob_id,
            content_hash,
            byte_length as i64,
            storage_reference(content_hash)
        ])
        .map_err(sql_error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_source_observation(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    batch_id: &str,
    batch_meta: &BatchMeta,
    artifact_id: &str,
    source_observation_id: &str,
    observation: &Observation,
) -> Result<(), CoreError> {
    transaction
        .prepare_cached(
            "INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5, 'scan', 'present', ?8, ?9, ?10, NULL, ?11, ?11)",
        )
        .map_err(sql_error)?
        .execute(params![
            source_observation_id,
            batch_id,
            workspace_id,
            artifact_id,
            batch_meta.source_provider_binding_id,
            batch_meta.source_provider,
            batch_meta.source_provider_version,
            observation.content_hash,
            observation.metadata_digest,
            observation.version_token,
            batch_meta.completed_at,
        ])
        .map_err(sql_error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_artifact_version(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    artifact_id: &str,
    artifact_version_id: &str,
    content_blob_id: &str,
    source_observation_id: &str,
    generation: i64,
    observation: &Observation,
) -> Result<(), CoreError> {
    transaction
        .prepare_cached(
            "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        )
        .map_err(sql_error)?
        .execute(params![
            artifact_version_id,
            workspace_id,
            artifact_id,
            content_blob_id,
            observation.content_hash,
            observation.byte_length as i64,
            observation.encoding,
            observation.language_hint,
            observation.metadata_digest,
            source_observation_id,
            generation,
        ])
        .map_err(sql_error)?;
    Ok(())
}

fn close_artifact_version(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    artifact_version_id: &str,
    generation: i64,
) -> Result<(), CoreError> {
    transaction
        .execute(
            "UPDATE artifact_versions SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND artifact_version_id = ?3 AND valid_to_generation IS NULL",
            params![generation, workspace_id, artifact_version_id],
        )
        .map_err(sql_error)?;
    Ok(())
}

/// P2-2h item 3: batch size for [`insert_added_batch`]'s multi-row
/// `INSERT`s, within the task's specified 200-500 row range. Chosen at the
/// low end of that range: SQLite's own bound-parameter limit
/// (`SQLITE_MAX_VARIABLE_NUMBER`, default 32766 in the bundled build this
/// crate links) divided by the widest single row this batches (16 params
/// for `source_observations`) leaves ample headroom either way, so this is
/// tuned for statement-text/param-buffer size rather than hitting any
/// limit.
const ADDED_BATCH_ROWS: usize = 300;

/// Per-row ids precomputed once per [`insert_added_batch`] call (P2-2h item
/// 3): `ids::*` is cheap (measured ~0.13s total across the whole n8n
/// corpus, see this task's evidence doc's id_compute/sql_exec split) and
/// stays a plain sequential loop; batching only ever targets the SQL side
/// below, which measured as the actual dominant cost.
struct AddedRowIds {
    artifact_id: String,
    source_observation_id: String,
    content_blob_id: String,
    artifact_version_id: String,
    storage_reference: String,
}

/// P2-2h item 3: applies one batch (`observations.len() <= ADDED_BATCH_ROWS`)
/// of brand-new observations as four multi-row `INSERT`s (one per table)
/// instead of `4 * observations.len()` single-row `execute` calls --
/// `Catalog::apply`'s caller loop below chunks `delta.added` into batches
/// of this size. Every bound parameter borrows straight from `observations`
/// (already owned by the caller for the whole `Delta`), `batch_meta`
/// (owned once by `Catalog::apply`'s caller, referenced -- not cloned --
/// for every row in every batch), or `row_ids` (owned by THIS call, freshly
/// computed, never cloned a second time for binding): the earlier batching
/// attempt (P2-2g) measured as a regression because it built an
/// intermediate buffer of OWNED copies before binding; this one binds
/// `&dyn rusqlite::ToSql` references directly into the data that already
/// owns them.
fn insert_added_batch(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    batch_id: &str,
    generation: i64,
    batch_meta: &BatchMeta,
    observations: &[Observation],
    frontier: &mut Frontier,
) -> Result<(), CoreError> {
    if observations.is_empty() {
        return Ok(());
    }
    let n = observations.len();

    let id_started = Instant::now();
    let mut row_ids: Vec<AddedRowIds> = Vec::with_capacity(n);
    for observation in observations {
        let artifact_id = ids::artifact_id(workspace_id, &observation.normalized_uri);
        let source_observation_id = ids::source_observation_id(
            batch_id,
            &artifact_id,
            Some(&observation.content_hash),
            generation,
        );
        let content_blob_id =
            ids::content_blob_id(&observation.content_hash, observation.byte_length);
        let artifact_version_id = ids::artifact_version_id(
            &artifact_id,
            &source_observation_id,
            &observation.content_hash,
        );
        let storage_reference_value = storage_reference(&observation.content_hash);
        row_ids.push(AddedRowIds {
            artifact_id,
            source_observation_id,
            content_blob_id,
            artifact_version_id,
            storage_reference: storage_reference_value,
        });
    }
    add_id_compute_time(id_started.elapsed());

    let sql_started = Instant::now();

    // 1. source_artifacts (OR IGNORE): (artifact_id, workspace_id,
    // normalized_uri, normalized_path, display_path, artifact_kind) --
    // `normalized_path`/`display_path` both equal `normalized_uri`
    // (matching `insert_source_artifact_if_absent`'s single-row `?3` reuse
    // three times); `artifact_kind` stays an inline SQL literal.
    {
        let row_sql = "(?,?,?,?,?,'physical_file')";
        let sql = format!(
            "INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES {}",
            vec![row_sql; n].join(",")
        );
        let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(n * 5);
        for (observation, ids_row) in observations.iter().zip(&row_ids) {
            bound.push(&ids_row.artifact_id);
            bound.push(&workspace_id);
            bound.push(&observation.normalized_uri);
            bound.push(&observation.normalized_uri);
            bound.push(&observation.normalized_uri);
        }
        transaction
            .prepare_cached(&sql)
            .map_err(sql_error)?
            .execute(rusqlite::params_from_iter(bound))
            .map_err(sql_error)?;
    }

    // 2. source_observations: 16 columns, 3 inline literals
    // (`observation_mode='scan'`, `observed_state='present'`,
    // `provider_sequence=NULL`) and two positions reused within a single
    // row (`ordering_domain` = `source_provider_binding_id`,
    // `received_at` = `observed_at`) -- matching `insert_source_
    // observation`'s single-row `?5`/`?11` reuse, flattened into 13 bound
    // values per row here (repeated values are pushed twice, not
    // reused-by-placeholder-number, since a multi-row `VALUES` list only
    // ever uses sequential positional `?`s).
    {
        let row_sql = "(?,?,?,?,?,?,?,?,'scan','present',?,?,?,NULL,?,?)";
        let sql = format!(
            "INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at) VALUES {}",
            vec![row_sql; n].join(",")
        );
        let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(n * 13);
        for (observation, ids_row) in observations.iter().zip(&row_ids) {
            bound.push(&ids_row.source_observation_id);
            bound.push(&batch_id);
            bound.push(&workspace_id);
            bound.push(&ids_row.artifact_id);
            bound.push(&batch_meta.source_provider_binding_id);
            bound.push(&batch_meta.source_provider);
            bound.push(&batch_meta.source_provider_version);
            bound.push(&batch_meta.source_provider_binding_id);
            bound.push(&observation.content_hash);
            bound.push(&observation.metadata_digest);
            bound.push(&observation.version_token);
            bound.push(&batch_meta.completed_at);
            bound.push(&batch_meta.completed_at);
        }
        transaction
            .prepare_cached(&sql)
            .map_err(sql_error)?
            .execute(rusqlite::params_from_iter(bound))
            .map_err(sql_error)?;
    }

    // 3. content_blobs (OR IGNORE): (content_blob_id, content_hash,
    // byte_length, storage_reference).
    {
        let row_sql = "(?,?,?,?)";
        let sql = format!(
            "INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES {}",
            vec![row_sql; n].join(",")
        );
        let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(n * 4);
        for (observation, ids_row) in observations.iter().zip(&row_ids) {
            bound.push(&ids_row.content_blob_id);
            bound.push(&observation.content_hash);
            bound.push(&observation.byte_length);
            bound.push(&ids_row.storage_reference);
        }
        transaction
            .prepare_cached(&sql)
            .map_err(sql_error)?
            .execute(rusqlite::params_from_iter(bound))
            .map_err(sql_error)?;
    }

    // 4. artifact_versions: 12 columns, last one an inline
    // `valid_to_generation=NULL` literal (matching `insert_artifact_
    // version`'s single-row shape).
    {
        let row_sql = "(?,?,?,?,?,?,?,?,?,?,?,NULL)";
        let sql = format!(
            "INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES {}",
            vec![row_sql; n].join(",")
        );
        let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(n * 11);
        for (observation, ids_row) in observations.iter().zip(&row_ids) {
            bound.push(&ids_row.artifact_version_id);
            bound.push(&workspace_id);
            bound.push(&ids_row.artifact_id);
            bound.push(&ids_row.content_blob_id);
            bound.push(&observation.content_hash);
            bound.push(&observation.byte_length);
            bound.push(&observation.encoding);
            bound.push(&observation.language_hint);
            bound.push(&observation.metadata_digest);
            bound.push(&ids_row.source_observation_id);
            bound.push(&generation);
        }
        transaction
            .prepare_cached(&sql)
            .map_err(sql_error)?
            .execute(rusqlite::params_from_iter(bound))
            .map_err(sql_error)?;
    }

    add_sql_exec_time(sql_started.elapsed());

    // Frontier bookkeeping (Rust-side only, no SQL): unchanged shape from
    // the single-row path, just moved to run after the whole batch's SQL
    // has landed. `row_ids` is consumed by value here (not cloned) --
    // nothing above needed it past its own borrow scope.
    for (observation, ids_row) in observations.iter().zip(row_ids) {
        let ordinal = frontier.next_ordinal();
        frontier.set_present(
            &observation.normalized_uri,
            FrontierEntry {
                artifact_id: ids_row.artifact_id,
                artifact_version_id: ids_row.artifact_version_id,
                content_hash: observation.content_hash.clone(),
                byte_length: observation.byte_length,
                metadata_digest: observation.metadata_digest.clone(),
                artifact_ordinal: ordinal,
            },
        )?;
    }
    Ok(())
}

fn apply_changed(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    batch_id: &str,
    generation: i64,
    batch_meta: &BatchMeta,
    observation: &Observation,
    frontier: &mut Frontier,
) -> Result<(), CoreError> {
    let uri = observation.normalized_uri.as_str();
    let (artifact_id, prior_present, prior_tombstone) = match (
        frontier.present.get(uri),
        frontier.absent.get(uri),
    ) {
        (Some(present), _) => (present.artifact_id.clone(), Some(present.clone()), None),
        (None, Some(tombstone)) => (tombstone.artifact_id.clone(), None, Some(tombstone.clone())),
        (None, None) => {
            return Err(CoreError(format!(
                "source catalog: '{uri}' is in Delta::changed but the frontier has no prior present or tombstoned entry for it"
            )));
        }
    };

    if let Some(present) = &prior_present {
        close_artifact_version(
            transaction,
            workspace_id,
            &present.artifact_version_id,
            generation,
        )?;
    }

    let source_observation_id = ids::source_observation_id(
        batch_id,
        &artifact_id,
        Some(&observation.content_hash),
        generation,
    );
    insert_source_observation(
        transaction,
        workspace_id,
        batch_id,
        batch_meta,
        &artifact_id,
        &source_observation_id,
        observation,
    )?;
    let content_blob_id = ids::content_blob_id(&observation.content_hash, observation.byte_length);
    insert_content_blob_if_absent(
        transaction,
        &content_blob_id,
        &observation.content_hash,
        observation.byte_length,
    )?;
    let artifact_version_id = ids::artifact_version_id(
        &artifact_id,
        &source_observation_id,
        &observation.content_hash,
    );
    insert_artifact_version(
        transaction,
        workspace_id,
        &artifact_id,
        &artifact_version_id,
        &content_blob_id,
        &source_observation_id,
        generation,
        observation,
    )?;

    if let Some(tombstone) = &prior_tombstone {
        // See the module doc: this crate never produces an "excluded"
        // tombstone, so re-adding a previously-tombstoned uri is always a
        // "recreated" transition, never "reincluded".
        let closing_change_id = ids::artifact_change_id("recreated", batch_id, &artifact_id);
        transaction
            .execute(
                "UPDATE artifact_tombstones SET valid_to_generation = ?1, closing_artifact_change_id = ?2, replacement_artifact_version_id = ?3 WHERE workspace_id = ?4 AND artifact_tombstone_id = ?5 AND valid_to_generation IS NULL",
                params![generation, closing_change_id, artifact_version_id, workspace_id, tombstone.artifact_tombstone_id],
            )
            .map_err(sql_error)?;
    }

    let ordinal = frontier.next_ordinal();
    frontier.set_present(
        uri,
        FrontierEntry {
            artifact_id,
            artifact_version_id,
            content_hash: observation.content_hash.clone(),
            byte_length: observation.byte_length,
            metadata_digest: observation.metadata_digest.clone(),
            artifact_ordinal: ordinal,
        },
    )
}

fn apply_deleted(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    batch_id: &str,
    generation: i64,
    uri: &str,
    frontier: &mut Frontier,
) -> Result<(), CoreError> {
    let prior = frontier
        .present
        .get(uri)
        .cloned()
        .ok_or_else(|| CoreError(format!("source catalog: '{uri}' is in Delta::deleted but the frontier has no present entry for it")))?;
    close_artifact_version(
        transaction,
        workspace_id,
        &prior.artifact_version_id,
        generation,
    )?;

    let artifact_tombstone_id = ids::artifact_tombstone_id(&prior.artifact_id, batch_id, "deleted");
    let opening_change_id = ids::artifact_change_id("deleted", batch_id, &prior.artifact_id);
    let cause_references = serde_json::to_string(&serde_json::json!([{
        "cause_type": "artifact_version",
        "cause_id": prior.artifact_version_id,
    }]))
    .expect("serializing a small literal JSON value cannot fail");
    transaction
        .execute(
            "INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code, last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id, replacement_artifact_version_id, cause_references, lineage_evidence_record_ids) VALUES (?1, ?2, ?3, 'deleted', 'core:source_deleted', ?4, ?5, NULL, ?6, NULL, NULL, ?7, '[]')",
            params![artifact_tombstone_id, workspace_id, prior.artifact_id, prior.artifact_version_id, generation, opening_change_id, cause_references],
        )
        .map_err(sql_error)?;

    frontier.set_absent(
        uri,
        TombstoneEntry {
            artifact_id: prior.artifact_id,
            artifact_tombstone_id,
        },
    )
}

/// Upserts `source_index_state`, respecting its `CHECK (state_revision > 0)`
/// constraint (so a first-ever apply for a workspace starts at 1, matching
/// `apply_source_index_commits`' `expected_revision == 0` insert branch).
fn upsert_source_index_state(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    generation: i64,
    source_state_digest: &str,
    updated_at: &str,
) -> Result<i64, CoreError> {
    let previous_revision: Option<i64> = transaction
        .query_row(
            "SELECT state_revision FROM source_index_state WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let next_revision = previous_revision.unwrap_or(0) + 1;
    let checkpoint_id = crate::digest::stable_id(
        "freshness-checkpoint",
        &serde_json::json!({ "workspace_id": workspace_id, "generation": generation }),
    );
    if previous_revision.is_some() {
        transaction
            .execute(
                "UPDATE source_index_state SET current_generation = ?1, state_revision = ?2, checkpoint_id = ?3, provider_watermarks = '{}', source_state_digest = ?4, updated_at = ?5 WHERE workspace_id = ?6",
                params![generation, next_revision, checkpoint_id, source_state_digest, updated_at, workspace_id],
            )
            .map_err(sql_error)?;
    } else {
        transaction
            .execute(
                "INSERT INTO source_index_state (workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at) VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6)",
                params![workspace_id, generation, next_revision, checkpoint_id, source_state_digest, updated_at],
            )
            .map_err(sql_error)?;
    }
    Ok(next_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delta::Delta;
    use crate::walker::StatMetadata;

    fn schema_sql() -> &'static str {
        include_str!("../../../packages/storage/sql/workspace-v3.sql")
    }

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema_sql()).unwrap();
        conn
    }

    fn observation(uri: &str, content: &[u8]) -> Observation {
        use sha2::{Digest, Sha256};
        let mut hex = String::from("sha256:");
        for byte in Sha256::digest(content) {
            use std::fmt::Write as _;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        let metadata = StatMetadata {
            byte_length: content.len() as u64,
            ctime_ms: 1.0,
            device: 1,
            inode: 1,
            mode: 0o644,
            mtime_ms: 1.0,
        };
        let metadata_digest = metadata.digest();
        let version_token = crate::walker::content_version_token(&metadata_digest, &hex);
        Observation {
            normalized_uri: uri.to_string(),
            content_hash: hex,
            byte_length: content.len() as u64,
            metadata,
            metadata_digest,
            version_token,
            encoding: "utf-8",
            language_hint: Some("text"),
        }
    }

    fn batch_meta(full_scan: bool) -> BatchMeta {
        BatchMeta {
            source_provider_binding_id: "binding:test".to_string(),
            source_provider: "core:rust_source_frontier".to_string(),
            source_provider_version: "1".to_string(),
            started_at: "2026-09-02T00:00:00.000Z".to_string(),
            completed_at: "2026-09-02T00:00:01.000Z".to_string(),
            full_scan,
        }
    }

    #[test]
    fn cold_apply_then_frontier_reload_agree() {
        let mut conn = open_test_db();
        let workspace_id = "workspace:one";
        let mut frontier = Frontier::empty();
        let observations = vec![
            observation("a.ts", b"export const a = 1;"),
            observation("sub/b.ts", b"export const b = 2;"),
        ];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.added.len(), 2);
        let applied = Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta,
            1,
            &batch_meta(true),
        )
        .unwrap();
        assert_eq!(applied.added, 2);
        assert_eq!(applied.state_revision, 1);
        assert_eq!(applied.source_state_digest, frontier.source_state_digest());
        assert_eq!(
            frontier.source_state_digest(),
            frontier.from_scratch_digest().unwrap()
        );

        let reloaded = Frontier::load(&conn, workspace_id).unwrap();
        assert_eq!(reloaded.present.len(), 2);
        for (uri, entry) in &frontier.present {
            let reloaded_entry = reloaded
                .present
                .get(uri)
                .unwrap_or_else(|| panic!("reloaded frontier missing {uri}"));
            assert_eq!(reloaded_entry.artifact_id, entry.artifact_id);
            assert_eq!(
                reloaded_entry.artifact_version_id,
                entry.artifact_version_id
            );
            assert_eq!(reloaded_entry.content_hash, entry.content_hash);
            assert_eq!(reloaded_entry.metadata_digest, entry.metadata_digest);
        }
        assert_eq!(
            reloaded.source_state_digest(),
            frontier.source_state_digest()
        );

        let state_revision: i64 = conn
            .query_row(
                "SELECT state_revision FROM source_index_state WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state_revision, 1);
        let observation_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_observations WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(observation_count, 2);
    }

    #[test]
    fn edit_create_delete_rename_sequence_keeps_frontier_and_digest_consistent() {
        let mut conn = open_test_db();
        let workspace_id = "workspace:one";
        let mut frontier = Frontier::empty();

        // Generation 1 (cold): a.ts, b.ts.
        let gen1 = vec![
            observation("a.ts", b"export const a = 1;"),
            observation("b.ts", b"export const b = 2;"),
        ];
        let delta1 = Delta::compute(&frontier, &gen1);
        Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta1,
            1,
            &batch_meta(true),
        )
        .unwrap();
        let a_version_gen1 = frontier
            .present
            .get("a.ts")
            .unwrap()
            .artifact_version_id
            .clone();

        // Generation 2: edit a.ts (content changes), create c.ts, delete b.ts.
        let gen2 = vec![
            observation("a.ts", b"export const a = 2;"),
            observation("c.ts", b"export const c = 3;"),
        ];
        let delta2 = Delta::compute(&frontier, &gen2);
        assert_eq!(delta2.changed.len(), 1);
        assert_eq!(delta2.added.len(), 1);
        assert_eq!(delta2.deleted, vec!["b.ts".to_string()]);
        let applied2 = Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta2,
            2,
            &batch_meta(true),
        )
        .unwrap();
        assert_eq!(applied2.state_revision, 2);
        assert!(!frontier.present.contains_key("b.ts"));
        assert!(frontier.absent.contains_key("b.ts"));
        let a_version_gen2 = frontier
            .present
            .get("a.ts")
            .unwrap()
            .artifact_version_id
            .clone();
        assert_ne!(
            a_version_gen1, a_version_gen2,
            "editing content must open a new artifact_version_id"
        );
        assert_eq!(
            frontier.source_state_digest(),
            frontier.from_scratch_digest().unwrap()
        );

        let old_version_closed: Option<i64> = conn
            .query_row(
                "SELECT valid_to_generation FROM artifact_versions WHERE artifact_version_id = ?1",
                params![a_version_gen1],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_version_closed, Some(2));

        // Generation 3: "rename" b.ts -> renamed.ts is delete+create with
        // the SAME content (per the plan's §6.4 rename handling) — recreate
        // b.ts's bytes under a new uri while b.ts stays deleted. This is the
        // INCREMENTAL path (`compute_partial`): only `renamed.ts` was
        // observed, so a.ts/c.ts (never touched by this batch) must not be
        // treated as deleted the way a `Delta::compute` full scan would.
        let gen3 = vec![crate::walker::PathObservation::Present(observation(
            "renamed.ts",
            b"export const b = 2;",
        ))];
        let delta3 = Delta::compute_partial(&frontier, &gen3);
        assert_eq!(delta3.added.len(), 1);
        assert_eq!(
            delta3.deleted.len(),
            0,
            "b.ts was already tombstoned in generation 2, not re-deleted here"
        );
        Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta3,
            3,
            &batch_meta(false),
        )
        .unwrap();
        assert!(frontier.present.contains_key("renamed.ts"));
        assert!(frontier.absent.contains_key("b.ts"));
        assert_eq!(
            frontier.source_state_digest(),
            frontier.from_scratch_digest().unwrap()
        );

        // Generation 4: recreate b.ts (tombstone reincluded/recreated path).
        // Full scan: every currently-present uri (a.ts, c.ts, renamed.ts)
        // must be listed or `Delta::compute` would treat it as deleted.
        let gen4 = vec![
            observation("a.ts", b"export const a = 2;"),
            observation("c.ts", b"export const c = 3;"),
            observation("renamed.ts", b"export const b = 2;"),
            observation("b.ts", b"export const b = 4;"),
        ];
        let delta4 = Delta::compute(&frontier, &gen4);
        assert_eq!(
            delta4.changed.len(),
            1,
            "only b.ts (recreated from a tombstone) counts as changed"
        );
        assert_eq!(
            delta4.equivalent_count, 3,
            "a.ts, c.ts and renamed.ts are unchanged from generation 3"
        );
        let applied4 = Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta4,
            4,
            &batch_meta(true),
        )
        .unwrap();
        assert_eq!(applied4.state_revision, 4);
        assert!(frontier.present.contains_key("b.ts"));
        assert!(!frontier.absent.contains_key("b.ts"));
        assert_eq!(
            frontier.source_state_digest(),
            frontier.from_scratch_digest().unwrap()
        );

        let reloaded = Frontier::load(&conn, workspace_id).unwrap();
        assert_eq!(reloaded.present.len(), frontier.present.len());
        assert_eq!(reloaded.absent.len(), frontier.absent.len());
        assert_eq!(
            reloaded.source_state_digest(),
            frontier.source_state_digest()
        );
    }

    #[test]
    fn incremental_single_file_edit_touches_only_that_uri() {
        let mut conn = open_test_db();
        let workspace_id = "workspace:one";
        let mut frontier = Frontier::empty();
        let gen1 = vec![observation("a.ts", b"one"), observation("b.ts", b"two")];
        let delta1 = Delta::compute(&frontier, &gen1);
        Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta1,
            1,
            &batch_meta(true),
        )
        .unwrap();
        let b_version_before = frontier
            .present
            .get("b.ts")
            .unwrap()
            .artifact_version_id
            .clone();

        // Incremental: only a.ts was reported changed by the watcher.
        let partial = vec![crate::walker::PathObservation::Present(observation(
            "a.ts",
            b"one-edited",
        ))];
        let delta2 = Delta::compute_partial(&frontier, &partial);
        assert_eq!(delta2.changed.len(), 1);
        assert_eq!(delta2.deleted.len(), 0);
        Catalog::apply(
            &mut conn,
            workspace_id,
            &mut frontier,
            &delta2,
            2,
            &batch_meta(false),
        )
        .unwrap();
        assert_eq!(
            frontier.present.get("b.ts").unwrap().artifact_version_id,
            b_version_before,
            "b.ts must be untouched by an incremental batch that never observed it"
        );
        assert_eq!(
            frontier.source_state_digest(),
            frontier.from_scratch_digest().unwrap()
        );
    }
}
