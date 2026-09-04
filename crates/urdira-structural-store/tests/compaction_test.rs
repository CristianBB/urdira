//! Compaction: after deltas, compact -> identical query results and
//! identical Merkle roots; readers holding the old manifest still work
//! until dropped; refcount prevents deletion.

mod common;

use common::*;
use urdira_structural_store::{Dictionaries, SegmentWriter, StoreReader};

#[test]
fn compact_matches_pre_compaction_state_and_respects_refcount() {
    let dir = tmp_dir("compaction");
    let n_owners = 16u32;
    let dicts = build_dictionaries(n_owners, 50);
    let base_rows = {
        let mut r = gen_rows(3_000, 20, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_deps = gen_deps(150, 21, n_owners);
    SegmentWriter::new()
        .write_base(&dir, &base_rows, &base_deps, &dicts, 1)
        .unwrap();

    let mut reference = RefModel {
        rows: base_rows,
        deps: base_deps,
    };

    // P3-6 item 4: 40 deltas (was 3) -- each one now a `delta-<g>.seg`
    // container (item 1) rather than a `delta-<g>/` directory -- close
    // some rows, open some rows, every generation.
    for generation in 2u32..=41u32 {
        let prev = u64::from(generation - 1);
        let open_idx: Vec<usize> = reference
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| RefModel::visible(r.valid_from, r.valid_to, prev))
            .map(|(i, _)| i)
            .take(40)
            .collect();
        let closures: Vec<([u8; 32], u32)> = open_idx
            .iter()
            .map(|&i| (reference.rows[i].record_id, generation))
            .collect();
        let new_rows = gen_rows(100, u64::from(generation) * 111, &dicts, generation);

        SegmentWriter::new()
            .write_delta(
                &dir,
                &new_rows,
                &closures,
                &[],
                &[],
                &Dictionaries::default(),
                u64::from(generation),
            )
            .unwrap();

        for (k, vt) in &closures {
            reference.close(k, *vt);
        }
        reference.rows.extend(new_rows);
    }

    let pre_manifest = StoreReader::open(&dir).unwrap().manifest();
    let g = pre_manifest.generation;
    assert!(
        !pre_manifest.deltas.is_empty(),
        "test setup must produce deltas to compact"
    );

    // Open a reader BEFORE compaction and keep it alive across the
    // compact() call.
    let old_reader = StoreReader::open(&dir).unwrap();
    let old_all: Vec<[u8; 32]> = {
        let mut v: Vec<[u8; 32]> = old_reader.iter_visible(g).map(|v| v.record_id()).collect();
        v.sort();
        v
    };
    assert_eq!(old_all, reference.all_visible_ids(g));

    let pre_roots = urdira_structural_store::recompute_roots_from_scratch(&old_reader, g).unwrap();

    let old_dirs: Vec<std::path::PathBuf> = std::iter::once(pre_manifest.base.clone())
        .chain(pre_manifest.deltas.iter().cloned())
        .map(|name| dir.join(name))
        .collect();
    for d in &old_dirs {
        assert!(d.exists());
    }

    let summary = urdira_structural_store::compact(&dir, g).expect("compact");
    assert_eq!(summary.generation, g);
    assert_eq!(
        (summary.records_root, summary.dependency_root),
        pre_roots,
        "compaction must not change the visible-row Merkle roots"
    );

    // Refcount: `old_reader` is still alive and registered, so its
    // directories must not have been deleted by compact().
    let in_use = urdira_structural_store::refcount::segments_in_use(&dir).unwrap();
    for name in [&pre_manifest.base]
        .into_iter()
        .chain(pre_manifest.deltas.iter())
    {
        assert!(
            in_use.contains(name),
            "{name} must be reported in-use while old_reader is alive"
        );
    }
    for d in &old_dirs {
        assert!(
            d.exists(),
            "compact() must not delete a directory a live reader still references"
        );
    }

    // The old reader keeps working unaffected (it never re-reads
    // MANIFEST unless asked to).
    let mut old_all_after: Vec<[u8; 32]> =
        old_reader.iter_visible(g).map(|v| v.record_id()).collect();
    old_all_after.sort();
    assert_eq!(old_all_after, reference.all_visible_ids(g));

    // A fresh reader (post-compaction) must see an identical query
    // surface via the single new base.
    let new_manifest = StoreReader::open(&dir).unwrap().manifest();
    assert!(
        new_manifest.deltas.is_empty(),
        "compaction must fold every delta into the new base"
    );
    assert_ne!(new_manifest.base, pre_manifest.base);

    let new_reader = StoreReader::open(&dir).unwrap();
    let mut new_all: Vec<[u8; 32]> = new_reader.iter_visible(g).map(|v| v.record_id()).collect();
    new_all.sort();
    assert_eq!(new_all, reference.all_visible_ids(g));
    assert_eq!(new_reader.visible_count(g), reference.visible_count(g));

    for owner in 0..n_owners {
        let mut got: Vec<[u8; 32]> = new_reader
            .by_owner(owner, g)
            .iter()
            .map(|v| v.record_id())
            .collect();
        got.sort();
        assert_eq!(
            got,
            reference.visible_ids_by_owner(owner, g),
            "by_owner owner={owner} post-compaction"
        );
    }

    // Drop the old reader: its refcount marker goes away, so its
    // (now-superseded) directories are no longer reported in-use, and
    // are safe to remove without affecting any live reader.
    drop(old_reader);
    let in_use_after_drop = urdira_structural_store::refcount::segments_in_use(&dir).unwrap();
    for name in [&pre_manifest.base]
        .into_iter()
        .chain(pre_manifest.deltas.iter())
    {
        assert!(
            !in_use_after_drop.contains(name),
            "{name} must no longer be reported in-use after its reader drops"
        );
    }
    for d in &old_dirs {
        // Old delta generations are now single container files (P3-6 item
        // 1), not directories -- try both removal forms.
        if d.is_dir() {
            let _ = std::fs::remove_dir_all(d);
        } else {
            let _ = std::fs::remove_file(d);
        }
    }
    // The post-compaction reader never depended on those directories.
    let mut still_all: Vec<[u8; 32]> = new_reader.iter_visible(g).map(|v| v.record_id()).collect();
    still_all.sort();
    assert_eq!(still_all, reference.all_visible_ids(g));
}
