//! replay-b: the same v4 shape sharded across three files written by three
//! threads -- records.sqlite (full row + PK + ro_owner), lookup.sqlite
//! (narrow key columns + ro_name/ro_kind/ro_ident), adjacency.sqlite
//! (subject columns + ro_out/ro_in). Wall time is the max of the three
//! threads' page-cache time, plus one fsync pass over all three files.

use crate::AnyResult;
use crate::ddl::*;
use crate::order::pk_order;
use crate::row::{Row, Store};
use crate::util::{Timings, dir_size, fsync_path, remove_if_exists};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn shard_thread(
    path: PathBuf,
    rows_ptr: *const Vec<Row>,
    order_ptr: *const Vec<u32>,
    kind: u8, // 0 = records, 1 = lookup, 2 = adjacency
    t0: Instant,
) -> AnyResult<Duration> {
    // SAFETY: rows/order outlive all three threads (joined before the
    // enclosing function returns) and are only read, never mutated.
    let rows: &Vec<Row> = unsafe { &*rows_ptr };
    let order: &Vec<u32> = unsafe { &*order_ptr };

    let conn = Connection::open(&path)?;
    apply_cold_pragmas(&conn)?;

    match kind {
        0 => {
            conn.execute_batch(RECORD_OCCURRENCES_TABLE)?;
            conn.execute_batch("BEGIN")?;
            insert_records_pk_order(&conn, order.iter().map(|&i| &rows[i as usize]))?;
            conn.execute_batch("COMMIT")?;
            conn.execute_batch(RECORD_OCCURRENCES_INDEXES[0])?; // ro_owner only
        }
        1 => {
            conn.execute_batch(LOOKUP_TABLE)?;
            conn.execute_batch("BEGIN")?;
            insert_lookup_pk_order(&conn, order.iter().map(|&i| &rows[i as usize]))?;
            conn.execute_batch("COMMIT")?;
            for idx in LOOKUP_INDEXES {
                conn.execute_batch(idx)?;
            }
        }
        _ => {
            conn.execute_batch(ADJACENCY_TABLE)?;
            conn.execute_batch("BEGIN")?;
            insert_adjacency_pk_order(&conn, order.iter().map(|&i| &rows[i as usize]))?;
            conn.execute_batch("COMMIT")?;
            for idx in ADJACENCY_INDEXES {
                conn.execute_batch(idx)?;
            }
        }
    }

    go_durable(&conn)?;
    let elapsed = t0.elapsed();
    drop(conn);
    Ok(elapsed)
}

pub fn run(store: &Store, out_dir: &Path) -> AnyResult<Timings> {
    remove_if_exists(out_dir);
    std::fs::create_dir_all(out_dir)?;

    let t0 = Instant::now();
    let order = pk_order(&store.rows);

    let rows_ptr: *const Vec<Row> = &store.rows;
    let order_ptr: *const Vec<u32> = &order;
    // Send the raw pointers across thread boundaries explicitly; see the
    // SAFETY note in shard_thread.
    struct SendPtr<T>(*const T);
    unsafe impl<T> Send for SendPtr<T> {}
    impl<T> SendPtr<T> {
        fn get(&self) -> *const T {
            self.0
        }
    }
    let rows_send = SendPtr(rows_ptr);
    let order_send = SendPtr(order_ptr);

    let paths = [
        out_dir.join("records.sqlite"),
        out_dir.join("lookup.sqlite"),
        out_dir.join("adjacency.sqlite"),
    ];

    let mut handles = Vec::new();
    for (kind, path) in paths.iter().cloned().enumerate() {
        let rows_send = SendPtr(rows_send.0);
        let order_send = SendPtr(order_send.0);
        handles.push(std::thread::spawn(move || {
            shard_thread(path, rows_send.get(), order_send.get(), kind as u8, t0)
        }));
    }

    let mut max_page_cache = Duration::ZERO;
    for h in handles {
        let d = h.join().expect("shard thread panicked")?;
        if d > max_page_cache {
            max_page_cache = d;
        }
    }

    let fsync_start = Instant::now();
    for path in &paths {
        fsync_path(path)?;
    }
    let fsync_elapsed = fsync_start.elapsed();

    let durable = max_page_cache + fsync_elapsed;
    let bytes_written = dir_size(out_dir)?;

    Ok(Timings {
        to_page_cache: max_page_cache,
        durable,
        bytes_written,
    })
}
