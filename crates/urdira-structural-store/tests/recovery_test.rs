//! Recovery: simulate a crash (`MANIFEST.next` + a partial directory) ->
//! `recover` cleans up; a corrupted file (one flipped byte) -> `verify_all`
//! reports it.

mod common;

use common::*;
use urdira_structural_store::{Manifest, SegmentWriter, StoreReader};

#[test]
fn recover_cleans_up_an_unpublished_generation() {
    let dir = tmp_dir("recovery-crash");
    let dicts = build_dictionaries(8, 20);
    let rows = {
        let mut r = gen_rows(500, 30, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    let published = Manifest::read(&dir.join("MANIFEST")).unwrap();
    assert_eq!(published.generation, 1);

    // Simulate a crash mid-write_delta: a partial `delta-2.seg` container
    // file exists (P3-6 item 1: a delta generation is one file, not a
    // directory), and MANIFEST.next names it, but the rename to MANIFEST
    // never happened.
    let partial_file = dir.join("delta-2.seg");
    std::fs::write(&partial_file, b"not a real container file").unwrap();

    let mut crashed = published.clone();
    crashed.generation = 2;
    crashed.deltas.push("delta-2.seg".to_string());
    crashed.write_atomic(&dir.join("MANIFEST.next")).unwrap();

    assert!(dir.join("MANIFEST.next").exists());
    assert!(partial_file.exists());

    urdira_structural_store::recover(&dir).expect("recover");

    assert!(
        !dir.join("MANIFEST.next").exists(),
        "recover must remove a dangling MANIFEST.next"
    );
    assert!(
        !partial_file.exists(),
        "recover must remove the unpublished generation's container file"
    );

    // MANIFEST itself (generation 1) is untouched and still fully usable.
    let after = Manifest::read(&dir.join("MANIFEST")).unwrap();
    assert_eq!(after.generation, 1);
    let reader = StoreReader::open(&dir).expect("store must still open after recovery");
    assert_eq!(reader.generation(), 1);
    reader.verify_all().expect("verify_all after recovery");
    assert_eq!(reader.visible_count(1), rows.len() as u64);
}

#[test]
fn recover_removes_orphan_directories_not_named_by_manifest() {
    let dir = tmp_dir("recovery-orphan");
    let dicts = build_dictionaries(4, 10);
    let rows = {
        let mut r = gen_rows(200, 31, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    // A leftover base directory AND a leftover delta container file from
    // some earlier, never-published attempts -- neither named by MANIFEST,
    // and no MANIFEST.next exists either.
    std::fs::create_dir_all(dir.join("base-99")).unwrap();
    std::fs::write(dir.join("delta-99.seg"), b"orphan").unwrap();

    urdira_structural_store::recover(&dir).unwrap();

    assert!(!dir.join("base-99").exists());
    assert!(!dir.join("delta-99.seg").exists());
    let reader = StoreReader::open(&dir).unwrap();
    assert_eq!(reader.visible_count(1), rows.len() as u64);
}

#[test]
fn verify_all_reports_a_corrupted_file() {
    let dir = tmp_dir("recovery-corrupt");
    let dicts = build_dictionaries(8, 20);
    let rows = {
        let mut r = gen_rows(500, 32, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    let reader = StoreReader::open(&dir).expect("open before corruption");
    reader
        .verify_all()
        .expect("freshly written store must verify clean");
    // Windows refuses writes to a file with an active memory mapping. Drop
    // the reader before mutating the fixture, then reopen it below.
    drop(reader);

    // Flip one byte in a file NOT covered by open()'s 4-file sample
    // (records.keys/meta/digests of the base, plus the newest segment's
    // keys), so StoreReader::open itself keeps succeeding and the
    // corruption is caught only by an explicit full `verify_all`.
    let path = {
        let manifest = Manifest::read(&dir.join("MANIFEST")).unwrap();
        dir.join(&manifest.base).join("records.by_owner")
    };
    let mut bytes = std::fs::read(&path).unwrap();
    let flip_at = bytes.len() - 1;
    bytes[flip_at] ^= 0xFF;
    std::fs::write(&path, &bytes).unwrap();

    let reader =
        StoreReader::open(&dir).expect("open must still succeed (corruption outside the sample)");
    let result = reader.verify_all();
    assert!(result.is_err(), "verify_all must detect the corrupted file");
}
