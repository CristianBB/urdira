//! Merkle: the incremental root maintained by `write_base`/`write_delta`
//! must equal a from-scratch recomputation over the store's visible rows
//! at every generation, including a compaction boundary.

mod common;

use common::*;
use urdira_structural_store::{
    Dictionaries, SegmentWriter, StoreReader, recompute_roots_from_scratch,
};

#[test]
fn incremental_roots_match_from_scratch_across_deltas_and_compaction() {
    let dir = tmp_dir("merkle");
    let n_owners = 12u32;
    let dicts = build_dictionaries(n_owners, 40);
    let base_rows = {
        let mut r = gen_rows(2_000, 40, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_deps = gen_deps(100, 41, n_owners);

    let summary = SegmentWriter::new()
        .write_base(&dir, &base_rows, &base_deps, &dicts, 1)
        .unwrap();
    {
        let reader = StoreReader::open(&dir).unwrap();
        let scratch = recompute_roots_from_scratch(&reader, 1).unwrap();
        assert_eq!(
            (summary.records_root, summary.dependency_root),
            scratch,
            "generation 1 (cold)"
        );
    }

    let mut reference = RefModel {
        rows: base_rows,
        deps: base_deps,
    };

    for generation in 2u32..=5u32 {
        let prev = u64::from(generation - 1);
        let open_idx: Vec<usize> = reference
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| RefModel::visible(r.valid_from, r.valid_to, prev))
            .map(|(i, _)| i)
            .take(30)
            .collect();
        let closures: Vec<([u8; 32], u32)> = open_idx
            .iter()
            .map(|&i| (reference.rows[i].record_id, generation))
            .collect();
        let new_rows = gen_rows(80, u64::from(generation) * 77, &dicts, generation);

        let open_dep_idx: Vec<usize> = reference
            .deps
            .iter()
            .enumerate()
            .filter(|(_, d)| RefModel::visible(d.valid_from, d.valid_to, prev))
            .map(|(i, _)| i)
            .take(5)
            .collect();
        let deps_closures: Vec<([u8; 32], u32)> = open_dep_idx
            .iter()
            .map(|&i| (reference.deps[i].dependency_id, generation))
            .collect();
        let deps_opened = gen_deps(10, u64::from(generation) * 88, n_owners);

        let summary = SegmentWriter::new()
            .write_delta(
                &dir,
                &new_rows,
                &closures,
                &deps_opened,
                &deps_closures,
                &Dictionaries::default(),
                u64::from(generation),
            )
            .unwrap();

        for (k, vt) in &closures {
            reference.close(k, *vt);
        }
        reference.rows.extend(new_rows);
        for (k, vt) in &deps_closures {
            reference.close_dep(k, *vt);
        }
        reference.deps.extend(deps_opened);

        let reader = StoreReader::open(&dir).unwrap();
        let scratch = recompute_roots_from_scratch(&reader, u64::from(generation)).unwrap();
        assert_eq!(
            (summary.records_root, summary.dependency_root),
            scratch,
            "generation {generation} (delta)"
        );
    }

    // A delta that opens/closes nothing must leave both roots unchanged.
    let reader = StoreReader::open(&dir).unwrap();
    let before = recompute_roots_from_scratch(&reader, 5).unwrap();
    let summary = SegmentWriter::new()
        .write_delta(&dir, &[], &[], &[], &[], &Dictionaries::default(), 6)
        .unwrap();
    assert_eq!(
        (summary.records_root, summary.dependency_root),
        before,
        "no-op delta must not change roots"
    );

    // Compaction must preserve both roots.
    let pre_compaction_roots = (summary.records_root, summary.dependency_root);
    let compacted = urdira_structural_store::compact(&dir, 6).unwrap();
    assert_eq!(
        (compacted.records_root, compacted.dependency_root),
        pre_compaction_roots,
        "compaction must preserve the Merkle roots"
    );
    let reader = StoreReader::open(&dir).unwrap();
    let scratch = recompute_roots_from_scratch(&reader, 6).unwrap();
    assert_eq!((compacted.records_root, compacted.dependency_root), scratch);
}
