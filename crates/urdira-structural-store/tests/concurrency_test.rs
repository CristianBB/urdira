//! Concurrency: 8 reader threads querying during a delta write + manifest
//! publish. Readers must see either the old or the new generation, never
//! a torn state (e.g. new segment files referenced by a manifest that
//! isn't durable yet, or a manifest generation whose files are missing).

mod common;

use common::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use urdira_structural_store::{Dictionaries, SegmentWriter, StoreReader};

#[test]
fn readers_never_observe_a_torn_state_across_a_delta_publish() {
    let dir = tmp_dir("concurrency");
    let n_owners = 8u32;
    let dicts = build_dictionaries(n_owners, 30);
    let base_rows = {
        let mut r = gen_rows(4_000, 50, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &base_rows, &[], &dicts, 1)
        .unwrap();

    let reference_g1 = RefModel {
        rows: base_rows.clone(),
        deps: vec![],
    };

    // Precompute exactly what generation 2 will look like, so a reader
    // thread that observes generation 2 has ground truth to check
    // against without racing the writer for it.
    let closures: Vec<([u8; 32], u32)> = base_rows
        .iter()
        .filter(|r| r.owner_artifact == 0)
        .map(|r| (r.record_id, 2))
        .collect();
    let new_rows = gen_rows(500, 999, &dicts, 2);
    let mut reference_g2 = reference_g1.clone();
    for (k, vt) in &closures {
        reference_g2.close(k, *vt);
    }
    reference_g2.rows.extend(new_rows.clone());

    let stop = Arc::new(AtomicBool::new(false));
    let failures = Arc::new(AtomicUsize::new(0));
    let open_failures = Arc::new(AtomicUsize::new(0));
    let query_failures = Arc::new(AtomicUsize::new(0));
    let verify_failures = Arc::new(AtomicUsize::new(0));
    let saw_gen1 = Arc::new(AtomicUsize::new(0));
    let saw_gen2 = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for _ in 0..8 {
        let dir = dir.clone();
        let stop = Arc::clone(&stop);
        let failures = Arc::clone(&failures);
        let open_failures = Arc::clone(&open_failures);
        let query_failures = Arc::clone(&query_failures);
        let verify_failures = Arc::clone(&verify_failures);
        let saw_gen1 = Arc::clone(&saw_gen1);
        let saw_gen2 = Arc::clone(&saw_gen2);
        let reference_g1 = reference_g1.clone();
        let reference_g2 = reference_g2.clone();
        handles.push(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let reader = match StoreReader::open(&dir) {
                    Ok(r) => r,
                    Err(_) => {
                        // A reader can legitimately race a writer that is
                        // mid-way through creating a brand new directory
                        // tree the very first time (before MANIFEST
                        // exists at all); that case doesn't apply here
                        // since MANIFEST already exists from write_base,
                        // so any open() failure here is a real bug.
                        failures.fetch_add(1, Ordering::Relaxed);
                        open_failures.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                let g = reader.generation();
                let reference = if g == 1 {
                    saw_gen1.fetch_add(1, Ordering::Relaxed);
                    &reference_g1
                } else if g == 2 {
                    saw_gen2.fetch_add(1, Ordering::Relaxed);
                    &reference_g2
                } else {
                    failures.fetch_add(1, Ordering::Relaxed);
                    query_failures.fetch_add(1, Ordering::Relaxed);
                    continue;
                };

                let mut got: Vec<[u8; 32]> = reader
                    .by_owner(0, g)
                    .iter()
                    .map(|v| v.record_id())
                    .collect();
                got.sort();
                if got != reference.visible_ids_by_owner(0, g) {
                    failures.fetch_add(1, Ordering::Relaxed);
                    query_failures.fetch_add(1, Ordering::Relaxed);
                }
                if reader.visible_count(g) != reference.visible_count(g) {
                    failures.fetch_add(1, Ordering::Relaxed);
                    query_failures.fetch_add(1, Ordering::Relaxed);
                }
                if reader.verify_all().is_err() {
                    failures.fetch_add(1, Ordering::Relaxed);
                    verify_failures.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    // Give readers a head start, then publish generation 2.
    std::thread::sleep(std::time::Duration::from_millis(30));
    SegmentWriter::new()
        .write_delta(
            &dir,
            &new_rows,
            &closures,
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(60));

    stop.store(true, Ordering::Relaxed);
    for h in handles {
        h.join().unwrap();
    }

    assert_eq!(
        failures.load(Ordering::Relaxed),
        0,
        "no reader thread may observe an inconsistent/torn state (open={}, query={}, verify={})",
        open_failures.load(Ordering::Relaxed),
        query_failures.load(Ordering::Relaxed),
        verify_failures.load(Ordering::Relaxed)
    );
    assert!(
        saw_gen1.load(Ordering::Relaxed) > 0,
        "test must exercise the pre-publish window"
    );
    assert!(
        saw_gen2.load(Ordering::Relaxed) > 0,
        "test must exercise the post-publish window"
    );
}
