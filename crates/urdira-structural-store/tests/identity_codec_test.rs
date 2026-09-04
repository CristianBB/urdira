//! A3a integration tests (identity keys reconstructed from typed fields
//! instead of stored verbatim): end-to-end round-trips of `identity_key()`
//! through `write_base`/`write_base_partitioned`/`write_delta`/`compact`,
//! for both canonical (tagged, zero bytes in `records.ident`) and
//! non-canonical (`Raw`, stored verbatim -- unchanged from pre-A3a
//! behavior) rows, plus the `HEADER_FORMAT` 4->5 bump's rejection of an
//! old-format segment file.

mod common;

use common::*;
use sha2::{Digest, Sha256};
use urdira_structural_store::{
    CATEGORY_ENTITY, CATEGORY_RELATION, Dictionaries, NONE_U16, NONE_U32, RecordRow, SegmentWriter,
    StoreReader, nibble_of,
};

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// One `records.*` common file header is 64 bytes (magic + format + table
/// id + row_count + generation + xxh3 + reserved) -- this crate's own
/// `layout::HEADER_LEN`, not re-exported, but documented as a stable part
/// of the on-disk format in `layout.rs`'s module doc, so hardcoding it
/// here (as every file-size assertion below does) tracks the real format
/// rather than an implementation detail that could drift silently.
const HEADER_LEN: u64 = 64;

fn entity_row(
    record_id: [u8; 32],
    owner_artifact: u32,
    kind_id: u16,
    name_id: u32,
    start: u32,
    identity_key: Vec<u8>,
) -> RecordRow {
    let identity_key_digest = digest(&identity_key);
    RecordRow {
        record_id,
        owner_artifact,
        owner_version: 0,
        valid_from: 1,
        valid_to: 0,
        category: CATEGORY_ENTITY,
        kind_id,
        universal_kind_id: 0,
        facets: 0,
        span_artifact_version: 0,
        span_start_byte: start,
        span_end_byte: start + 5,
        span_start_line: 0,
        span_end_line: 0,
        identity_type: 0,
        assignment_kind: 0,
        name_id,
        record_digest: digest(&identity_key),
        body_digest: [0u8; 32],
        identity_id: identity_key_digest,
        identity_key_digest,
        previous_record_id: [0u8; 32],
        source_subject: None,
        target_subject: None,
        relation_kind_id: NONE_U16,
        body: Vec::new(),
        identity_key,
    }
}

#[allow(clippy::too_many_arguments)]
fn relation_row(
    record_id: [u8; 32],
    owner_artifact: u32,
    kind_id: u16,
    relation_kind_id: u16,
    start: u32,
    end: u32,
    source_subject: Option<u32>,
    target_subject: Option<u32>,
    identity_key: Vec<u8>,
) -> RecordRow {
    let identity_key_digest = digest(&identity_key);
    RecordRow {
        record_id,
        owner_artifact,
        owner_version: 0,
        valid_from: 1,
        valid_to: 0,
        category: CATEGORY_RELATION,
        kind_id,
        universal_kind_id: 0,
        facets: 0,
        span_artifact_version: 0,
        span_start_byte: start,
        span_end_byte: end,
        span_start_line: 0,
        span_end_line: 0,
        identity_type: 1,
        assignment_kind: 0,
        name_id: NONE_U32,
        record_digest: digest(&identity_key),
        body_digest: [0u8; 32],
        identity_id: identity_key_digest,
        identity_key_digest,
        previous_record_id: [0u8; 32],
        source_subject,
        target_subject,
        relation_kind_id,
        body: Vec::new(),
        identity_key,
    }
}

/// Reads every row back via `StoreReader` and asserts `identity_key()`
/// matches `rows` byte for byte, in whatever order the store returns them
/// (`StoreReader::get`, keyed by `record_id`, is order-independent).
fn assert_identity_roundtrip(dir: &std::path::Path, rows: &[RecordRow]) {
    let reader = StoreReader::open(dir).unwrap();
    for row in rows {
        let view = reader
            .get(&row.record_id)
            .unwrap_or_else(|| panic!("record {:?} not found", row.record_id));
        assert_eq!(
            view.identity_key().as_ref(),
            row.identity_key.as_slice(),
            "identity_key mismatch for record_id {:?} (expected {:?})",
            row.record_id,
            String::from_utf8_lossy(&row.identity_key),
        );
    }
}

/// A canonical entity, a canonical relation pointing at it plus a second
/// canonical entity, a canonical NO-SPAN `contains` relation over the same
/// two entities, and one non-canonical (`jsts:external_module:*`) entity --
/// the full mix `classify_identity` needs to exercise the `ENTITY`/
/// `RELATION`/`RELATION_NO_SPAN` tagged paths and the `RAW` fallback in the
/// same batch. Returns `(dicts, rows)`.
///
/// A3a-fix note: `dicts.kinds[0]`/`[1]` here are deliberately the COARSE
/// `UniversalKind`-bucketed word a REAL entity producer would stamp
/// (`"jsts:entity_callable"`), NOT the fine word -- this fixture no longer
/// needs to lie about that the way the pre-fix version of this test did
/// (`try_entity` used to read the fine word straight out of `dicts.kinds`,
/// which is exactly the bug this fix corrects), because the fine word is
/// now parsed straight out of each row's own `identity_key` and interned
/// into `dicts.entity_kinds` by the writer itself.
fn canonical_and_noncanonical_fixture() -> (Dictionaries, Vec<RecordRow>) {
    let entity_a_id = digest(b"entity-a");
    let entity_a_identity = b"jsts:function:src/a.ts:10:greet".to_vec();
    let entity_a = entity_row(entity_a_id, 0, 0, 0, 10, entity_a_identity.clone());

    let entity_b_id = digest(b"entity-b");
    let entity_b_identity = b"jsts:function:src/a.ts:20:helper".to_vec();
    let entity_b = entity_row(entity_b_id, 0, 0, 1, 20, entity_b_identity.clone());

    let relation_identity = [
        b"jsts:call:src/a.ts:1:2:".as_slice(),
        entity_a_identity.as_slice(),
        b":",
        entity_b_identity.as_slice(),
    ]
    .concat();
    let relation = relation_row(
        digest(b"relation-ab"),
        0,
        1, // kinds[1] == "jsts:relation_call"
        0, // relation_kinds[0] == "call"
        1,
        2,
        Some(0), // subjects[0] == entity_a_id
        Some(1), // subjects[1] == entity_b_id
        relation_identity,
    );

    // A3a-fix: a NO-SPAN relation (`jsts:contains:*`, `IDENTITY_LAYOUT_
    // RELATION_NO_SPAN`) over the SAME two entities -- start/end are 0
    // (never part of this shape's identity string, so their actual value
    // is irrelevant to classification).
    let contains_identity = [
        b"jsts:contains:".as_slice(),
        entity_a_identity.as_slice(),
        b":",
        entity_b_identity.as_slice(),
    ]
    .concat();
    let contains_relation = relation_row(
        digest(b"contains-ab"),
        0,
        2, // kinds[2] == "jsts:relation_contains"
        1, // relation_kinds[1] == "contains"
        0,
        0,
        Some(0),
        Some(1),
        contains_identity,
    );

    let external = entity_row(
        digest(b"external-lodash"),
        0,
        0,
        NONE_U32,
        0,
        b"jsts:external_module:lodash".to_vec(),
    );

    let dicts = Dictionaries {
        kinds: vec![
            "jsts:entity_callable".to_string(),
            "jsts:relation_call".to_string(),
            "jsts:relation_contains".to_string(),
        ],
        universal_kinds: vec!["core:callable".to_string()],
        relation_kinds: vec!["call".to_string(), "contains".to_string()],
        names: vec!["greet".to_string(), "helper".to_string()],
        subjects: vec![entity_a_id, entity_b_id],
        artifacts: vec![("artifact:src/a.ts".to_string(), "v1".to_string())],
        facet_names: Vec::new(),
        subject_text: Vec::new(),
        artifact_paths: vec!["src/a.ts".to_string()],
        entity_kinds: Vec::new(), // interned by the writer itself, not the caller
    };

    (
        dicts,
        vec![entity_a, entity_b, relation, contains_relation, external],
    )
}

#[test]
fn canonical_and_noncanonical_rows_roundtrip_through_write_base() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-write-base");
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();
    assert_identity_roundtrip(&dir, &rows);

    // Only the non-canonical (`external`) row's real bytes should be in
    // `records.ident` -- the two entities and the relation are all
    // canonical and store zero bytes each.
    let ident_path = dir.join("base-1").join("records.ident");
    let external_len = rows[4].identity_key.len() as u64;
    let actual = std::fs::metadata(&ident_path).unwrap().len();
    assert_eq!(
        actual,
        HEADER_LEN + external_len,
        "records.ident should hold only the non-canonical row's bytes"
    );
}

#[test]
fn canonical_and_noncanonical_rows_roundtrip_through_write_base_partitioned() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-write-base-partitioned");
    let mut partitions: Vec<Vec<RecordRow>> = (0..16).map(|_| Vec::new()).collect();
    for row in &rows {
        partitions[nibble_of(&row.record_id)].push(row.clone());
    }
    for part in &mut partitions {
        part.sort_by_key(|r| r.record_id);
    }
    SegmentWriter::new()
        .write_base_partitioned(&dir, &partitions, &[], &dicts, 1)
        .unwrap();
    assert_identity_roundtrip(&dir, &rows);

    let ident_path = dir.join("base-1").join("records.ident");
    let external_len = rows[4].identity_key.len() as u64;
    let actual = std::fs::metadata(&ident_path).unwrap().len();
    assert_eq!(actual, HEADER_LEN + external_len);
}

/// A fully canonical store (no non-canonical rows at all) writes ZERO
/// data bytes to `records.ident` -- file size is exactly `HEADER_LEN`.
#[test]
fn fully_canonical_store_writes_zero_ident_bytes() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let canonical_rows: Vec<RecordRow> = rows.into_iter().take(4).collect(); // drop the external row
    let dir = tmp_dir("identity-fully-canonical");
    SegmentWriter::new()
        .write_base(&dir, &canonical_rows, &[], &dicts, 1)
        .unwrap();
    assert_identity_roundtrip(&dir, &canonical_rows);
    let ident_path = dir.join("base-1").join("records.ident");
    let actual = std::fs::metadata(&ident_path).unwrap().len();
    assert_eq!(actual, HEADER_LEN, "records.ident must hold 0 data bytes");
}

/// Delta rows, both entities and the relation opened in the SAME delta
/// batch (in-batch endpoint resolution, no store fallback needed).
#[test]
fn canonical_and_noncanonical_rows_roundtrip_through_write_delta_same_batch() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-write-delta-same-batch");
    SegmentWriter::new()
        .write_base(&dir, &[], &[], &Dictionaries::default(), 1)
        .unwrap();
    SegmentWriter::new()
        .write_delta(&dir, &rows, &[], &[], &[], &dicts, 2)
        .unwrap();
    assert_identity_roundtrip(&dir, &rows);
}

/// A delta relation whose SOURCE endpoint was opened in an earlier
/// generation (the base) -- `resolve_identity`'s store-fallback path
/// (`current_reader.get(id).identity_key()`), not the in-batch index.
#[test]
fn delta_relation_resolves_source_endpoint_from_the_base_via_the_store() {
    let entity_a_id = digest(b"entity-a-base");
    let entity_a_identity = b"jsts:function:src/a.ts:10:greet".to_vec();
    let entity_a = entity_row(entity_a_id, 0, 0, 0, 10, entity_a_identity.clone());

    let base_dicts = Dictionaries {
        kinds: vec!["function".to_string()],
        universal_kinds: vec!["core:callable".to_string()],
        relation_kinds: Vec::new(),
        names: vec!["greet".to_string()],
        subjects: vec![entity_a_id], // registered up front for the later relation
        artifacts: vec![("artifact:src/a.ts".to_string(), "v1".to_string())],
        facet_names: Vec::new(),
        subject_text: Vec::new(),
        artifact_paths: vec!["src/a.ts".to_string()],
        entity_kinds: Vec::new(),
    };

    let dir = tmp_dir("identity-delta-store-fallback");
    SegmentWriter::new()
        .write_base(&dir, std::slice::from_ref(&entity_a), &[], &base_dicts, 1)
        .unwrap();

    let entity_b_id = digest(b"entity-b-delta");
    let entity_b_identity = b"jsts:function:src/a.ts:20:helper".to_vec();
    let entity_b = entity_row(entity_b_id, 0, 0, 1, 20, entity_b_identity.clone());

    let relation_identity = [
        b"jsts:call:src/a.ts:1:2:".as_slice(),
        entity_a_identity.as_slice(),
        b":",
        entity_b_identity.as_slice(),
    ]
    .concat();
    let relation = relation_row(
        digest(b"relation-ab-delta"),
        0,
        1, // merged kinds[1] == "jsts:relation_call" (this delta's own addition)
        0, // merged relation_kinds[0] == "call" (this delta's own addition)
        1,
        2,
        Some(0), // merged subjects[0] == entity_a_id (from the BASE)
        Some(1), // merged subjects[1] == entity_b_id (this delta's own addition)
        relation_identity,
    );

    let dict_additions = Dictionaries {
        kinds: vec!["jsts:relation_call".to_string()],
        universal_kinds: Vec::new(),
        relation_kinds: vec!["call".to_string()],
        names: vec!["helper".to_string()],
        subjects: vec![entity_b_id],
        artifacts: Vec::new(),
        facet_names: Vec::new(),
        subject_text: Vec::new(),
        artifact_paths: Vec::new(), // owner_artifact 0 already resolved via the base's own entry
        entity_kinds: Vec::new(),
    };

    SegmentWriter::new()
        .write_delta(
            &dir,
            &[entity_b.clone(), relation.clone()],
            &[],
            &[],
            &[],
            &dict_additions,
            2,
        )
        .unwrap();

    assert_identity_roundtrip(&dir, &[entity_a, entity_b, relation]);
}

/// Two compactions in a row reach a stable fixed point: `records.meta`
/// and `records.ident` (their DATA sections -- the common 64-byte header
/// carries the target generation, which necessarily differs between the
/// two compactions) are byte-identical.
#[test]
fn two_compactions_reach_a_byte_identical_fixed_point() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-compaction-fixed-point");
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    urdira_structural_store::compact(&dir, 2).unwrap();
    let meta_gen2 = std::fs::read(dir.join("base-2").join("records.meta")).unwrap();
    let ident_gen2 = std::fs::read(dir.join("base-2").join("records.ident")).unwrap();

    urdira_structural_store::compact(&dir, 3).unwrap();
    let meta_gen3 = std::fs::read(dir.join("base-3").join("records.meta")).unwrap();
    let ident_gen3 = std::fs::read(dir.join("base-3").join("records.ident")).unwrap();

    let header_len = HEADER_LEN as usize;
    assert_eq!(
        meta_gen2[header_len..],
        meta_gen3[header_len..],
        "records.meta data section must be identical across a no-op compaction"
    );
    assert_eq!(
        ident_gen2[header_len..],
        ident_gen3[header_len..],
        "records.ident data section must be identical across a no-op compaction"
    );

    assert_identity_roundtrip(&dir, &rows);
}

/// A `records.keys` file written at the pre-A3a `HEADER_FORMAT` (4)
/// fails `StoreReader::open` with a clear error instead of panicking or
/// silently misreading the (now-different) `records.meta` byte layout.
#[test]
fn store_written_at_the_old_header_format_fails_to_open_with_a_clear_error() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-old-format-rejected");
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    // Patch every hot file's format u16 (offset 4, little-endian) from 5
    // to 4 -- simulates a store written by a pre-A3a build.
    for name in [
        "records.keys",
        "records.meta",
        "records.digests",
        "records.body",
        "records.ident",
    ] {
        let path = dir.join("base-1").join(name);
        let mut bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            &bytes[4..6],
            &5u16.to_le_bytes(),
            "expected format 5 before patching"
        );
        bytes[4..6].copy_from_slice(&4u16.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
    }

    let result = StoreReader::open(&dir);
    assert!(
        result.is_err(),
        "opening a format-4 store must fail, not panic"
    );
    let message = result.err().unwrap().to_string();
    assert!(
        message.contains("format"),
        "error message should mention the format mismatch, got: {message}"
    );
}

/// Same rejection at the `MANIFEST` JSON level (`Manifest::format`, bumped
/// alongside `HEADER_FORMAT`).
#[test]
fn manifest_written_at_the_old_format_fails_to_open_with_a_clear_error() {
    let (dicts, rows) = canonical_and_noncanonical_fixture();
    let dir = tmp_dir("identity-old-manifest-format-rejected");
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .unwrap();

    let manifest_path = dir.join("MANIFEST");
    let text = std::fs::read_to_string(&manifest_path).unwrap();
    assert!(
        text.contains("\"format\": 5"),
        "expected format 5 before patching"
    );
    let patched = text.replace("\"format\": 5", "\"format\": 4");
    std::fs::write(&manifest_path, patched).unwrap();

    let result = StoreReader::open(&dir);
    assert!(
        result.is_err(),
        "opening a format-4 manifest must fail, not panic"
    );
    let message = result.err().unwrap().to_string();
    assert!(
        message.contains("format"),
        "error message should mention the format mismatch, got: {message}"
    );
}
