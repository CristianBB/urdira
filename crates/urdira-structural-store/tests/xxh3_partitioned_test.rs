//! A2 (2026-09-05): the five hot `records.*` files' header `body_xxh3` is
//! now `hash_of_partition_hashes` (xxh3 of the 16 per-nibble-partition
//! hashes, concatenated) instead of one plain xxh3 of the whole file --
//! computed inline by the writer, next to each partition's own buffers,
//! rather than by re-`mmap`-ing a just-written file to hash it whole. These
//! tests exercise the on-disk contract this formula change makes:
//! `write_base`/`write_base_partitioned` produce files `StoreReader::
//! verify_all` accepts as clean, and a single flipped byte anywhere in a
//! hot file -- including exactly on a nibble-partition boundary, where an
//! off-by-one in the reader's re-derived boundaries would most likely hide
//! it -- is still detected.

mod common;

use common::*;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use urdira_structural_store::{
    CATEGORY_ENTITY, Dictionaries, NONE_U16, NONE_U32, RecordRow, SegmentWriter, StoreReader,
    nibble_of,
};

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// A minimal non-canonical (RAW-layout) entity row with a `record_id`
/// deterministically placed in nibble `nib` (`record_id[0] == nib << 4`) --
/// nibble placement is all these tests care about; the identity string is
/// deliberately NOT `jsts:`-shaped, so every row is uninterestingly `Raw`
/// (this file tests xxh3 partitioning, not A3a-fix's classification).
fn row_in_nibble(nib: u8, salt: u8) -> RecordRow {
    assert!(nib < 16);
    let mut record_id = digest(&[salt]);
    record_id[0] = nib << 4; // low nibble left at whatever the digest gave, irrelevant
    let identity_key = format!("raw-identity-{nib}-{salt}").into_bytes();
    let body = format!("body-{nib}-{salt}").into_bytes();
    let identity_key_digest = digest(&identity_key);
    let record_digest = digest(&body);
    RecordRow {
        record_id,
        owner_artifact: 0,
        owner_version: 0,
        valid_from: 1,
        valid_to: 0,
        category: CATEGORY_ENTITY,
        kind_id: 0,
        universal_kind_id: 0,
        facets: 0,
        span_artifact_version: 0,
        span_start_byte: 0,
        span_end_byte: 0,
        span_start_line: 0,
        span_end_line: 0,
        identity_type: 0,
        assignment_kind: 0,
        name_id: NONE_U32,
        identity_key,
        record_digest,
        body_digest: record_digest,
        identity_id: identity_key_digest,
        identity_key_digest,
        previous_record_id: [0u8; 32],
        source_subject: None,
        target_subject: None,
        relation_kind_id: NONE_U16,
        body,
    }
}

fn minimal_dicts() -> Dictionaries {
    Dictionaries {
        kinds: Vec::new(),
        universal_kinds: Vec::new(),
        relation_kinds: Vec::new(),
        names: Vec::new(),
        subjects: Vec::new(),
        artifacts: vec![("artifact:digest".to_string(), String::new())],
        facet_names: Vec::new(),
        subject_text: Vec::new(),
        artifact_paths: Vec::new(),
        entity_kinds: Vec::new(),
    }
}

fn partitions_of(rows: &[RecordRow]) -> Vec<Vec<RecordRow>> {
    let mut partitions: Vec<Vec<RecordRow>> = (0..16).map(|_| Vec::new()).collect();
    for row in rows {
        partitions[nibble_of(&row.record_id)].push(row.clone());
    }
    for part in &mut partitions {
        part.sort_by_key(|r| r.record_id);
    }
    partitions
}

/// Several nibbles populated (not all 16) -- a realistic small delta/base
/// shape -- verifies clean via `write_base_partitioned`.
#[test]
fn write_base_partitioned_multi_nibble_store_verifies_clean() {
    let dicts = minimal_dicts();
    let rows: Vec<RecordRow> = (0..40)
        .map(|i| row_in_nibble((i % 5) as u8 * 3, i as u8))
        .collect();
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-multi-nibble");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();
    let reader = StoreReader::open(&dir).unwrap();
    reader
        .verify_all()
        .expect("freshly written store must verify clean");
    assert_eq!(reader.visible_count(1), rows.len() as u64);
}

/// Exactly ONE nibble populated -- 15 empty partitions, each contributing
/// `xxh::hash(&[])` to the combined hash -- must still verify clean.
#[test]
fn write_base_partitioned_single_nibble_store_verifies_clean() {
    let dicts = minimal_dicts();
    let rows: Vec<RecordRow> = (0..10).map(|i| row_in_nibble(7, i as u8)).collect();
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-single-nibble");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();
    let reader = StoreReader::open(&dir).unwrap();
    reader
        .verify_all()
        .expect("single-nibble store must verify clean");
    assert_eq!(reader.visible_count(1), rows.len() as u64);
}

/// A completely empty store (zero rows, all 16 partitions empty) -- must
/// still verify clean: `hash_of_partition_hashes` combines 16 `xxh::hash
/// (&[])` values into one well-defined constant, both writer paths agree
/// on it, and `verify_records_hot_partitioned`'s boundaries (all zero)
/// reproduce it exactly.
#[test]
fn write_base_partitioned_empty_store_verifies_clean() {
    let dicts = minimal_dicts();
    let partitions: Vec<Vec<RecordRow>> = (0..16).map(|_| Vec::new()).collect();
    let dir = tmp_dir("xxh3-partitioned-empty");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();
    let reader = StoreReader::open(&dir).unwrap();
    reader.verify_all().expect("empty store must verify clean");
    assert_eq!(reader.visible_count(1), 0);
}

/// `write_base` (non-partitioned) on the SAME empty input agrees byte for
/// byte with `write_base_partitioned` above -- both now compute `body_
/// xxh3` via the identical `hash_of_partition_hashes` formula.
#[test]
fn write_base_empty_store_verifies_clean_and_matches_partitioned_header() {
    let dicts = minimal_dicts();
    let dir_flat = tmp_dir("xxh3-empty-flat");
    SegmentWriter::new()
        .write_base(&dir_flat, &[], &[], &dicts, 1)
        .unwrap();
    let dir_part = tmp_dir("xxh3-empty-partitioned");
    let partitions: Vec<Vec<RecordRow>> = (0..16).map(|_| Vec::new()).collect();
    SegmentWriter::new()
        .write_base_partitioned(&dir_part, &partitions, &[], &dicts, 1)
        .unwrap();

    for name in [
        "records.keys",
        "records.meta",
        "records.digests",
        "records.body",
        "records.ident",
    ] {
        let flat = std::fs::read(dir_flat.join("base-1").join(name)).unwrap();
        let part = std::fs::read(dir_part.join("base-1").join(name)).unwrap();
        assert_eq!(
            flat, part,
            "{name} must be byte-identical for an empty store"
        );
    }
}

fn flip_last_byte(path: &std::path::Path) {
    let mut bytes = std::fs::read(path).unwrap();
    assert!(!bytes.is_empty(), "cannot corrupt an empty file");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    let mut file = OpenOptions::new().write(true).open(path).unwrap();
    file.seek(SeekFrom::Start(last as u64)).unwrap();
    file.write_all(&bytes[last..=last]).unwrap();
    file.sync_all().unwrap();
}

fn flip_byte_at(path: &std::path::Path, offset: usize) {
    let mut bytes = std::fs::read(path).unwrap();
    assert!(
        offset < bytes.len(),
        "corruption offset must be inside the file"
    );
    bytes[offset] ^= 0xFF;
    let mut file = OpenOptions::new().write(true).open(path).unwrap();
    file.seek(SeekFrom::Start(offset as u64)).unwrap();
    file.write_all(&bytes[offset..=offset]).unwrap();
    file.sync_all().unwrap();
}

/// A single flipped byte in `records.ident` (written via `write_base_
/// partitioned`) is detected by `verify_all`.
#[test]
fn write_base_partitioned_corrupted_ident_byte_is_detected() {
    let dicts = minimal_dicts();
    let rows: Vec<RecordRow> = (0..40)
        .map(|i| row_in_nibble((i % 5) as u8 * 3, i as u8))
        .collect();
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-corrupt-ident");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();

    let ident_path = dir.join("base-1").join("records.ident");
    flip_last_byte(&ident_path);

    let reader = StoreReader::open(&dir).expect("open must still succeed (corruption not sampled)");
    assert!(
        reader.verify_all().is_err(),
        "a corrupted records.ident byte must be detected"
    );
}

/// A single flipped byte in `records.body` (written via `write_base_
/// partitioned`) is detected by `verify_all`.
#[test]
fn write_base_partitioned_corrupted_body_byte_is_detected() {
    let dicts = minimal_dicts();
    let rows: Vec<RecordRow> = (0..40)
        .map(|i| row_in_nibble((i % 5) as u8 * 3, i as u8))
        .collect();
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-corrupt-body");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();

    let body_path = dir.join("base-1").join("records.body");
    flip_last_byte(&body_path);

    let reader = StoreReader::open(&dir).expect("open must still succeed (corruption not sampled)");
    assert!(
        reader.verify_all().is_err(),
        "a corrupted records.body byte must be detected"
    );
}

/// A single flipped byte in `records.keys` at EXACTLY the first byte of a
/// nibble boundary -- the off-by-one case where a wrong `<`/`<=` in the
/// reader's re-derived boundaries would most likely hide corruption (by
/// attributing the byte to the wrong partition's hash, which -- since both
/// partitions' hashes still feed the SAME combined hash -- could otherwise
/// only fail to detect it if the boundary arithmetic silently dropped the
/// byte from every partition, not merely reattributed it; this test pins
/// that no such gap exists).
#[test]
fn write_base_partitioned_corruption_at_nibble_boundary_start_is_detected() {
    let dicts = minimal_dicts();
    // Two populated nibbles (3 and 4) with a KNOWN row count each, so the
    // boundary between them is a known row (and therefore keys-byte)
    // index: nibble 3 gets rows [0], nibble 4 gets rows [1].
    let rows = vec![row_in_nibble(3, 1), row_in_nibble(4, 2)];
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-boundary-start");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();

    // `records.keys` header is 64 bytes; row 1 (nibble 4's row, the second
    // partition's first row) starts at `HEADER_LEN + 1 * KEYS_STRIDE` --
    // its FIRST byte is exactly the boundary this test targets. `KEYS_
    // STRIDE` (32) and `HEADER_LEN` (64) are this crate's own layout
    // constants, not re-exported; hardcoded here the same way `identity_
    // codec_test.rs` hardcodes `HEADER_LEN` for the identical reason.
    const HEADER_LEN: usize = 64;
    const KEYS_STRIDE: usize = 32;
    let keys_path = dir.join("base-1").join("records.keys");
    flip_byte_at(&keys_path, HEADER_LEN + KEYS_STRIDE);

    // `records.keys` is one of the 4 sections `StoreReader::open` itself
    // sample-verifies (plan §2.6), so this corruption is caught right at
    // open -- `verify_all` (the FULL check every other corruption test in
    // this file drives) never even gets a `StoreReader` to call it on.
    // Either counts as "detected".
    match StoreReader::open(&dir) {
        Err(_) => {} // detected at open
        Ok(reader) => assert!(
            reader.verify_all().is_err(),
            "corruption exactly at a nibble boundary's first byte must be detected"
        ),
    }
}

/// Same as above, but at the LAST byte of the first partition's own byte
/// range (`row 0`'s last key byte) -- the other off-by-one direction.
#[test]
fn write_base_partitioned_corruption_at_nibble_boundary_end_is_detected() {
    let dicts = minimal_dicts();
    let rows = vec![row_in_nibble(3, 1), row_in_nibble(4, 2)];
    let partitions = partitions_of(&rows);
    let dir = tmp_dir("xxh3-partitioned-boundary-end");
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();

    const HEADER_LEN: usize = 64;
    const KEYS_STRIDE: usize = 32;
    let keys_path = dir.join("base-1").join("records.keys");
    // Last byte of row 0's own 32-byte key (the first partition's own
    // byte range's last byte).
    flip_byte_at(&keys_path, HEADER_LEN + KEYS_STRIDE - 1);

    match StoreReader::open(&dir) {
        Err(_) => {} // detected at open (records.keys is sample-verified there)
        Ok(reader) => assert!(
            reader.verify_all().is_err(),
            "corruption exactly at a nibble boundary's last byte must be detected"
        ),
    }
}

/// A delta (via `write_delta`, `build_delta_sections`'s `encode_framed_
/// partitioned`) spanning several nibbles verifies clean, and a single
/// flipped byte in its `records.ident` is detected.
#[test]
fn delta_with_several_nibbles_verifies_clean_and_detects_corruption() {
    let dicts = minimal_dicts();
    let dir = tmp_dir("xxh3-delta-multi-nibble");
    SegmentWriter::new()
        .write_base(&dir, &[], &[], &Dictionaries::default(), 1)
        .unwrap();

    let rows: Vec<RecordRow> = (0..25)
        .map(|i| row_in_nibble((i % 6) as u8 * 2, i as u8))
        .collect();
    SegmentWriter::new()
        .write_delta(&dir, &rows, &[], &[], &[], &dicts, 2)
        .unwrap();

    let reader = StoreReader::open(&dir).unwrap();
    reader.verify_all().expect("delta must verify clean");
    assert_eq!(reader.visible_count(2), rows.len() as u64);
    // Windows refuses writes to a file with an active memory mapping. Drop
    // the reader before mutating the container, then reopen it below.
    reader.wait_prefault();
    drop(reader);

    // Corrupt the delta container file itself -- flip a byte somewhere in
    // its back half, likely to land inside one of the larger sections
    // (body/ident) rather than the small fixed-size header area shared by
    // every section.
    let manifest = urdira_structural_store::Manifest::read(&dir.join("MANIFEST")).unwrap();
    let delta_name = manifest.deltas.last().expect("a delta must exist").clone();
    let delta_path = dir.join(&delta_name);
    let mut bytes = std::fs::read(&delta_path).unwrap();
    let mid = bytes.len() * 3 / 4;
    bytes[mid] ^= 0xFF;
    std::fs::write(&delta_path, &bytes).unwrap();

    let reader = StoreReader::open(&dir).expect("open must still succeed (corruption not sampled)");
    assert!(
        reader.verify_all().is_err(),
        "a corrupted delta container byte must be detected"
    );
}
