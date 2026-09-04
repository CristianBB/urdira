//! P2-2j item 2: `write_base_partitioned` is a NEW, additive writer entry
//! point (`urdira-indexing-worker`'s v4 cold-scan path calls it instead of
//! `write_base`) -- this test is the strongest correctness check available
//! for it: given the SAME rows, bucketed into 16 nibble-sorted partitions,
//! `write_base_partitioned` must produce a `base-<g>/` directory that is
//! byte-for-byte IDENTICAL (every file, including the 64-byte header
//! carrying each file's own xxh3) to what `write_base` produces from the
//! same rows passed as one flat slice. Reuses the same synthetic generator
//! `write_base_determinism_test.rs` uses.

mod common;

use common::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use urdira_structural_store::{N_NIBBLES, RecordRow, SegmentWriter, nibble_of};

fn hash_segment_dir(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .expect("read_dir")
        .map(|e| e.expect("dir entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_file() {
            let bytes = std::fs::read(&path).expect("read file");
            let digest = Sha256::digest(&bytes);
            let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            out.insert(name, hex);
        }
    }
    out
}

/// Buckets `rows` (consumed) into `N_NIBBLES` partitions by
/// `nibble_of(&row.record_id)`, sorting each partition ascending by
/// `record_id` -- exactly the contract `write_base_partitioned` documents.
fn partition_by_nibble(rows: Vec<RecordRow>) -> Vec<Vec<RecordRow>> {
    let mut partitions: Vec<Vec<RecordRow>> = (0..N_NIBBLES).map(|_| Vec::new()).collect();
    for row in rows {
        let nib = nibble_of(&row.record_id);
        partitions[nib].push(row);
    }
    for partition in &mut partitions {
        partition.sort_by_key(|r| r.record_id);
    }
    partitions
}

#[test]
fn write_base_partitioned_matches_write_base_byte_for_byte() {
    let dicts = build_dictionaries(64, 500);
    let rows = gen_rows(50_000, 9191, &dicts, 1);
    let deps = gen_deps(2_000, 9292, dicts.artifacts.len() as u32);

    let mut flat_sorted = rows.clone();
    flat_sorted.sort_by_key(|r| r.record_id);
    let partitions = partition_by_nibble(rows);
    let partitioned_total: usize = partitions.iter().map(Vec::len).sum();
    assert_eq!(
        partitioned_total,
        flat_sorted.len(),
        "partitioning must not drop or duplicate rows"
    );

    let dir_flat = tmp_dir("partitioned-flat");
    SegmentWriter::new()
        .write_base(&dir_flat, &flat_sorted, &deps, &dicts, 7)
        .expect("write_base");

    let dir_partitioned = tmp_dir("partitioned-buckets");
    SegmentWriter::new()
        .write_base_partitioned(&dir_partitioned, &partitions, &deps, &dicts, 7)
        .expect("write_base_partitioned");

    let base_flat = hash_segment_dir(&dir_flat.join("base-7"));
    let base_partitioned = hash_segment_dir(&dir_partitioned.join("base-7"));

    assert!(!base_flat.is_empty(), "expected non-empty base-7 directory");
    assert_eq!(
        base_flat.keys().collect::<Vec<_>>(),
        base_partitioned.keys().collect::<Vec<_>>(),
        "write_base and write_base_partitioned must produce the same file set"
    );
    for (name, hash_flat) in &base_flat {
        let hash_partitioned = &base_partitioned[name];
        assert_eq!(
            hash_flat, hash_partitioned,
            "file {name} differs in bytes between write_base and write_base_partitioned"
        );
    }

    // Also confirm the two `MANIFEST`s agree on both roots (the actual
    // correctness property the rest of this task's evidence doc leans on).
    let manifest_flat = urdira_structural_store::Manifest::read(&dir_flat.join("MANIFEST"))
        .expect("read flat MANIFEST");
    let manifest_partitioned =
        urdira_structural_store::Manifest::read(&dir_partitioned.join("MANIFEST"))
            .expect("read partitioned MANIFEST");
    assert_eq!(manifest_flat.roots, manifest_partitioned.roots);
}

#[test]
fn write_base_partitioned_rejects_wrong_partition_count() {
    let dicts = build_dictionaries(4, 10);
    let rows = gen_rows(100, 1, &dicts, 1);
    let deps = Vec::new();
    let mut partitions = partition_by_nibble(rows);
    partitions.pop();

    let dir = tmp_dir("partitioned-wrong-count");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        SegmentWriter::new().write_base_partitioned(&dir, &partitions, &deps, &dicts, 1)
    }));
    assert!(
        result.is_err(),
        "write_base_partitioned must reject a partition count != N_NIBBLES"
    );
}
