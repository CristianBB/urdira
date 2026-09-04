//! replay-a: single SQLite file, cold pragmas, PK-ordered inserts, indexes
//! built after load, then the WAL/NORMAL durability switch plus one fsync.

use crate::AnyResult;
use crate::ddl::*;
use crate::deps::DepRow;
use crate::order::pk_order;
use crate::row::Store;
use crate::util::{Timings, dir_size, fsync_path, remove_if_exists};
use rusqlite::Connection;
use std::path::Path;
use std::time::Instant;

pub fn run(store: &Store, deps: &[DepRow], out_path: &Path) -> AnyResult<Timings> {
    remove_if_exists(out_path);

    let t0 = Instant::now();
    let conn = Connection::open(out_path)?;
    apply_cold_pragmas(&conn)?;

    conn.execute_batch(RECORD_OCCURRENCES_TABLE)?;
    conn.execute_batch(DICTIONARY_TABLES)?;
    conn.execute_batch(ARTIFACT_DEPENDENCIES_TABLE)?;

    let order = pk_order(&store.rows);

    conn.execute_batch("BEGIN")?;
    insert_records_pk_order(&conn, order.iter().map(|&i| &store.rows[i as usize]))?;
    insert_dictionaries(&conn, &store.dict)?;
    insert_artifact_dependencies(&conn, deps)?;
    conn.execute_batch("COMMIT")?;

    for idx_sql in RECORD_OCCURRENCES_INDEXES {
        conn.execute_batch(idx_sql)?;
    }

    let to_page_cache = t0.elapsed();

    go_durable(&conn)?;
    let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    drop(conn);
    fsync_path(out_path)?;
    let durable = t0.elapsed();

    let bytes_written = dir_size(out_path)?;
    eprintln!("[replay-a] journal_mode after switch: {mode}");

    Ok(Timings {
        to_page_cache,
        durable,
        bytes_written,
    })
}
