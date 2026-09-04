//! Byte-identity regression test for `write_base`'s hot-file + secondary
//! -array writer path (P2-3b perf work: merged the two into one
//! `std::thread::scope` so they run concurrently instead of sequentially).
//! Since the merge only changes *when* threads run, never what they
//! compute, every segment file's bytes (including the 64-byte header,
//! whose `xxh3` covers the whole data region) must be identical
//! regardless of how many hot-file partition threads are used. Hashes
//! every file in `base-<g>/` with SHA-256 and compares a 1-thread write
//! against a many-thread write of the same 50k-row synthetic set.

mod common;

use common::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use urdira_structural_store::SegmentWriter;

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

#[test]
fn write_base_output_is_byte_identical_across_thread_counts() {
    let dicts = build_dictionaries(64, 500);
    let mut rows = gen_rows(50_000, 4242, &dicts, 1);
    rows.sort_by_key(|r| r.record_id);
    let deps = gen_deps(2_000, 4343, dicts.artifacts.len() as u32);

    let dir_1 = tmp_dir("determinism-1thread");
    SegmentWriter::with_threads(1)
        .write_base(&dir_1, &rows, &deps, &dicts, 7)
        .expect("write_base (1 thread)");

    let dir_n = tmp_dir("determinism-nthreads");
    SegmentWriter::with_threads(10)
        .write_base(&dir_n, &rows, &deps, &dicts, 7)
        .expect("write_base (10 threads)");

    let dir_default = tmp_dir("determinism-default");
    SegmentWriter::new()
        .write_base(&dir_default, &rows, &deps, &dicts, 7)
        .expect("write_base (default thread count)");

    let base_1 = hash_segment_dir(&dir_1.join("base-7"));
    let base_n = hash_segment_dir(&dir_n.join("base-7"));
    let base_default = hash_segment_dir(&dir_default.join("base-7"));

    assert!(!base_1.is_empty(), "expected non-empty base-7 directory");
    assert_eq!(
        base_1.keys().collect::<Vec<_>>(),
        base_n.keys().collect::<Vec<_>>(),
        "1-thread and 10-thread writes must produce the same file set"
    );

    for (name, hash_1) in &base_1 {
        let hash_n = &base_n[name];
        assert_eq!(
            hash_1, hash_n,
            "file {name} differs in bytes between a 1-thread and a 10-thread write_base"
        );
        let hash_default = &base_default[name];
        assert_eq!(
            hash_1, hash_default,
            "file {name} differs in bytes between a 1-thread write and SegmentWriter::new()'s default thread count"
        );
    }
}
