//! v4 catalog (plan §4.1): opens/ensures the v4 workspace SQLite schema,
//! walks the workspace with `urdira-source-frontier`'s `Walker` (CAS puts
//! inline), and applies the resulting `Delta` to the catalog + in-memory
//! `Frontier`. Cold scope only for this task (`Full`): every observation is
//! `added`, matching plan §4.1's "cold: todo es `added`".

use super::ScanError;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::time::{Duration, Instant};
use urdira_indexing_core::workspace_v4_sql::WORKSPACE_V4_SCHEMA;
use urdira_source_frontier::inclusion::{GitIgnoreRules, default_workspace_inclusion};
use urdira_source_frontier::{
    BatchMeta, CasPut, CasStore, CasWriteQueue, Catalog, Delta, Frontier, Observation, Walker,
};

/// Opens (creating if needed) the v4 catalog SQLite file at `database_path`
/// and ensures its schema. Cold pragmas per plan §2.7's spirit (this is the
/// catalog file, not the structural store, but the same "no journal
/// overhead during a from-scratch cold write" reasoning applies): a brand
/// new file has no readers yet, and `MANIFEST.next`-style atomicity is
/// unnecessary since the whole scan either commits or the file is simply
/// discarded/retried by the caller.
///
/// P2-2d: relaxes `synchronous` from `NORMAL` to `OFF` (no `fsync` at all)
/// for the cold-scan connection's lifetime, but -- unlike an earlier
/// version of this fix, reverted after it was caught live by
/// `tests/v4-daemon-e2e.test.ts` -- keeps `journal_mode=WAL`. `WAL`, not
/// `synchronous`, is what lets a concurrent reader (the daemon's own
/// separate connection to this same file, e.g. polling
/// `core:index_status` while a scan is in flight) read a consistent
/// snapshot without blocking on the writer; switching to
/// `journal_mode=OFF`/`MEMORY`/`DELETE` during the cold catalog
/// transaction reintroduces the traditional rollback-journal locking
/// model, under which a concurrent reader gets `SQLITE_BUSY` ("database
/// is locked") instead -- reproduced live (the real daemon e2e test
/// failed with exactly that error) and is why journal mode is untouched
/// here. `synchronous=OFF` has no such concurrent-reader downside (it
/// only affects what survives an OS crash, not who can read while whom
/// writes), so it is the one knob this task's "no journal overhead
/// during a from-scratch cold write" reasoning safely applies to: an
/// OS-crash-lost cold scan is exactly as recoverable as any other
/// cold-scan failure (there is no partial-catalog resume path today) --
/// discard the data directory, run `WorkspaceScan{scope: Full}` again.
/// `scan::run` restores `synchronous=NORMAL` on this same connection
/// immediately after `catalog::run_full_scan` returns (before
/// `publish::publish_cold`'s own snapshot transaction runs), so the file
/// is back to its normal durability well before `ScanCompleted`.
pub fn open_and_ensure_schema(database_path: &Path) -> Result<Connection, ScanError> {
    if let Some(parent) = database_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(database_path).map_err(|error| {
        ScanError(format!(
            "failed to open v4 catalog {database_path:?}: {error}"
        ))
    })?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(WORKSPACE_V4_SCHEMA)?;
    Ok(conn)
}

/// P3-1 deliverable 2: `workspace_current_state.current_generation` for
/// `workspace_id`, or `0` if the workspace has never published a generation
/// (a brand-new workspace, or a `MANIFEST`-less data dir). The caller's next
/// generation is always this value plus one -- cold is generation 1 only
/// because a from-scratch workspace reads back `0` here, not because
/// anything hardcodes `1`. Fixes the P2-2b gap this task's brief calls out
/// by name ("`scan.rs` HARDCODES `generation = 1`"): a second `Full` scan of
/// an already-published workspace (e.g. a forced full rescan) used to
/// collide on `source_observation_batches`' primary key and every other
/// generation-keyed table; it now correctly continues from the workspace's
/// real current generation.
pub fn read_current_generation(conn: &Connection, workspace_id: &str) -> Result<i64, ScanError> {
    conn.query_row(
        "SELECT current_generation FROM workspace_current_state WHERE workspace_id = ?1",
        [workspace_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.unwrap_or(0))
    .map_err(|error| {
        ScanError(format!(
            "v4 catalog: reading current_generation failed: {error}"
        ))
    })
}

/// Restores `synchronous=NORMAL` after the cold catalog transaction
/// (`run_full_scan`, above) has committed -- see `open_and_ensure_schema`'s
/// doc comment for why `synchronous=OFF` was safe for that transaction
/// specifically, and why this restore must happen before
/// `publish::publish_cold`'s own snapshot transaction runs on this same
/// connection (the write that actually makes the workspace
/// `ScanCompleted`, which should be durable).
pub fn restore_steady_state_pragmas(conn: &Connection) -> Result<(), ScanError> {
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;
    Ok(())
}

/// `added`/`changed`/`deleted`/`observation_batch_id`/`walk_elapsed`/
/// `apply_elapsed` are not read by this task's cold-only pipeline (only
/// `frontier` and `source_state_digest` feed `analyze.rs`/`publish.rs`
/// today) -- kept public and populated regardless so a future evidence
/// dump, log line, or the P3 incremental caller has them on hand without
/// re-deriving them.
#[allow(dead_code)]
pub struct CatalogScanOutcome {
    pub frontier: Frontier,
    pub added: usize,
    pub changed: usize,
    pub deleted: usize,
    pub observation_batch_id: String,
    pub source_state_digest: String,
    pub walk_elapsed: Duration,
    pub apply_elapsed: Duration,
    /// P2-2h item 2: the CAS write queue this scan's walk fed. Not yet
    /// joined when `run_full_scan` returns -- CAS blobs are only needed by
    /// `get_source`/FTS, never by the structural index, so nothing on the
    /// `catalog -> analyze -> materialize -> publish -> Queryable` path
    /// needs to wait on them. The caller (`scan::run_full`) joins this
    /// AFTER `publish::publish_cold` returns (durable, before the scan's
    /// terminal `ScanCompleted` event) so every write is confirmed on disk
    /// without ever blocking `Queryable`.
    pub cas_write_queue: Option<CasWriteQueue>,
}

/// Runs a full (cold) catalog scan: walk `workspace_root`, queue every
/// observed file's bytes for a background CAS write under `cas_root`
/// (joined later by the caller, see [`CatalogScanOutcome::cas_write_queue`]),
/// diff against the (empty, for a brand new workspace) frontier, and apply
/// the resulting delta in one SQLite transaction. Returns the updated
/// in-memory `Frontier` -- callers read `frontier.present` for the final
/// `(uri -> artifact_id/version_id/content_hash/byte_length)` map used to
/// build syntax-worker inputs (`analyze.rs`).
pub fn run_full_scan(
    conn: &mut Connection,
    workspace_id: &str,
    workspace_root: &Path,
    cas_root: &Path,
    generation: i64,
) -> Result<CatalogScanOutcome, ScanError> {
    let cas_store = CasStore::open(cas_root)
        .map_err(|error| ScanError(format!("failed to open CAS root {cas_root:?}: {error}")))?;
    // P2-2h item 2 / P2-2j item 5 fix: a dedicated pool (NOT rayon's shared
    // global pool -- see `CasWriteQueue::spawn`'s doc comment). Originally
    // sized at HALF the available parallelism with a 512-item capacity;
    // measured live on n8n's 20,149-file corpus
    // (`v4::tests_e2e::n8n_catalog_walk_diagnosis`) that this UNDERSIZED
    // the queue badly enough to make the walk itself pay for it: a bare
    // `Walker::enumerate` with no CAS at all takes 0.6-1.0s (matching the
    // P2-2a bench this task's brief cites), but with the ORIGINAL 5-worker/
    // 512-capacity queue the SAME walk took 2.5-3.6s -- almost the entire
    // gap the task brief asked to explain was `submit`'s own backpressure
    // wait (`CasWriteQueue::submit`'s doc comment: "Blocks only while the
    // queue is at capacity"), not the walk/hash work itself. `put_if_
    // absent` does no `fsync` (open+write+rename only, confirmed by reading
    // it directly), so more CAS worker threads than physical cores is safe
    // (each spends most of its time blocked on a write/rename syscall, not
    // competing for CPU with the walker's own lstat/read/sha256 work) --
    // using the FULL available parallelism (not half) plus a much larger
    // capacity lets the walk return almost as fast as the no-CAS case
    // (measured: 0.9-1.0s), moving the actual disk-write work into
    // `CasWriteQueue::join` -- which `scan.rs`'s orchestrator already runs
    // fully overlapped with `analyze`/`materialize`/`publish` (several
    // seconds of CPU-bound work), not on the walk's own critical path.
    // Capacity 8,192 is still bounded (item 4's RSS gate): at n8n's typical
    // per-file size this is tens of MiB of buffered bytes at most, nowhere
    // near the 3 GiB budget, while comfortably covering corpora larger than
    // n8n's own 20k files without falling back into the old backpressure
    // regime.
    let cas_worker_count = std::thread::available_parallelism()
        .map(std::num::NonZero::get)
        .unwrap_or(4);
    let cas_write_queue = CasWriteQueue::spawn(cas_store, cas_worker_count, 8192);
    let rules = default_workspace_inclusion();
    let gitignore = GitIgnoreRules {
        enabled: false,
        patterns: Vec::new(),
    };
    let walk_started = Instant::now();
    let cas_sink: &dyn CasPut = &cas_write_queue;
    let observations: Vec<Observation> =
        Walker::enumerate(workspace_root, &rules, &gitignore, Some(cas_sink))?;
    let walk_elapsed = walk_started.elapsed();

    let apply_started = Instant::now();
    let mut frontier = Frontier::load(conn, workspace_id)?;
    let delta = Delta::compute(&frontier, &observations);
    let now = super::now_iso8601();
    let batch_meta = BatchMeta {
        source_provider_binding_id: format!("urdira:v4-directory-walker:{workspace_id}"),
        source_provider: "urdira:v4-directory-walker".to_string(),
        source_provider_version: "1".to_string(),
        started_at: now.clone(),
        completed_at: now,
        full_scan: true,
    };
    let applied = Catalog::apply(
        conn,
        workspace_id,
        &mut frontier,
        &delta,
        generation,
        &batch_meta,
    )?;
    let apply_elapsed = apply_started.elapsed();

    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] v4 catalog: walk={:.3}s apply={:.3}s observations={} added={} changed={} deleted={}",
            walk_elapsed.as_secs_f64(),
            apply_elapsed.as_secs_f64(),
            observations.len(),
            applied.added,
            applied.changed,
            applied.deleted,
        );
    }

    Ok(CatalogScanOutcome {
        frontier,
        added: applied.added,
        changed: applied.changed,
        deleted: applied.deleted,
        observation_batch_id: applied.observation_batch_id,
        source_state_digest: applied.source_state_digest,
        walk_elapsed,
        apply_elapsed,
        cas_write_queue: Some(cas_write_queue),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the pragma choice `open_and_ensure_schema`'s
    /// doc comment documents (task P2-2d): confirms `journal_mode` reads
    /// back as `wal` (not the default `delete`, and not `off`/`memory`, an
    /// earlier version of this fix tried and reverted after this exact
    /// scenario reproduced live via `tests/v4-daemon-e2e.test.ts`'s
    /// "database is locked" failure). `synchronous` starts at `off` (`0`)
    /// and is restored to `normal` (`1`) after `restore_steady_state_
    /// pragmas`.
    #[test]
    fn open_and_ensure_schema_keeps_wal_and_restore_normalizes_synchronous() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("v4-catalog-pragma-test")
            .join(format!(
                "pragma-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let database_path = dir.join("workspace.sqlite");
        let conn = open_and_ensure_schema(&database_path).expect("schema opens");

        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        let synchronous: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            synchronous, 0,
            "synchronous must start OFF during the cold catalog transaction"
        );

        restore_steady_state_pragmas(&conn).expect("restore succeeds");
        let synchronous_after: i64 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            synchronous_after, 1,
            "synchronous must be restored to NORMAL"
        );
        let journal_mode_after: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            journal_mode_after.to_ascii_lowercase(),
            "wal",
            "journal_mode must stay WAL throughout -- restore only touches synchronous"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The actual invariant `journal_mode=WAL` exists to protect (task
    /// P2-2d): a SECOND connection to the same file can read a consistent
    /// snapshot while the first connection holds an open write
    /// transaction, instead of getting `SQLITE_BUSY` ("database is
    /// locked") -- exactly the failure `tests/v4-daemon-e2e.test.ts`
    /// reproduced live when an earlier version of this fix used
    /// `journal_mode=OFF`. Regression-tests the concurrent-reader
    /// scenario directly, without needing the full daemon.
    #[test]
    fn wal_mode_lets_a_second_connection_read_during_an_open_write_transaction() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("v4-catalog-pragma-test")
            .join(format!(
                "wal-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let database_path = dir.join("workspace.sqlite");
        let writer = open_and_ensure_schema(&database_path).expect("schema opens");

        // Open a write transaction and leave it uncommitted while a second,
        // independent connection tries to read.
        writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
        writer
            .execute(
                "INSERT INTO source_index_state (workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at) VALUES ('w', 1, 1, 'c', '{}', 'sha256:0', 'now')",
                [],
            )
            .unwrap();

        let reader = Connection::open(&database_path).expect("second connection opens");
        let count: i64 = reader
            .query_row("SELECT COUNT(*) FROM workspace_meta", [], |row| row.get(0))
            .expect("reader must not get SQLITE_BUSY while the writer's transaction is open");
        assert_eq!(count, 0);

        writer.execute_batch("COMMIT;").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P3-1 deliverable 2 regression test: a brand-new workspace (no
    /// `workspace_current_state` row at all) reads back generation `0`, and
    /// after a cold scan publishes generation 1, the next call reads back 1
    /// -- confirming the caller's `next_generation = current + 1` recipe
    /// never reuses generation 1 for a second scan.
    #[test]
    fn current_generation_defaults_to_zero_and_tracks_published_state() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("v4-catalog-pragma-test")
            .join(format!(
                "gen-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let database_path = dir.join("workspace.sqlite");
        let conn = open_and_ensure_schema(&database_path).expect("schema opens");
        assert_eq!(
            read_current_generation(&conn, "workspace:test").unwrap(),
            0,
            "a brand new workspace has no workspace_current_state row yet"
        );
        // `workspace_current_state` has FK columns into `snapshots`/
        // `registry_snapshots`/etc that a real scan populates first (see
        // `publish.rs`'s snapshot transactions) -- this test only cares
        // about `current_generation`, so foreign-key enforcement is
        // dropped for this one throwaway insert rather than fabricating
        // every referenced row.
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute(
            "INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES ('workspace:test', 'snapshot:1', 1, 'registry:1', 'lock:1', 'config:1', 'freshness:1', 1, 'now')",
            [],
        )
        .unwrap();
        assert_eq!(read_current_generation(&conn, "workspace:test").unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
