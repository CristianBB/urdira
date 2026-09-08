//! Frente Q-4 (2026-09-08): `StoreReader::by_identity_key`/`by_identity_id`
//! -- the two new indexed, visibility-filtered lookups
//! `crates/urdira-native-node/src/structural_store_napi.rs`'s
//! `records_by_identity_keys`/`records_by_identity_ids` sit on top of (see
//! `StoreInner::identity_id_index`'s own doc comment, `reader.rs`, for the
//! full design rationale: `identity_id`/`identity_key` are two DIFFERENT
//! digests of related-but-distinct data, so each needs its own index).
//!
//! Unlike `by_identity_last` (writer.rs's own diffing primitive, which
//! deliberately does NOT check visibility -- "the most recent version of
//! this identity_key, period"), both new methods must never return a row
//! that is not actually visible at the REQUESTED generation. This is the
//! property that makes them safe for a live query (as opposed to a write-
//! time diff), and the one differential property this test suite exists to
//! pin down.

mod common;

use common::{digest_of, tmp_dir};
use urdira_structural_store::{
    CATEGORY_ENTITY, Dictionaries, NONE_U16, NONE_U32, RecordRow, SegmentWriter, StoreReader,
};

fn entity_row(
    record_id: [u8; 32],
    identity_key: &[u8],
    valid_from: u32,
    valid_to: u32,
) -> RecordRow {
    let identity_key_digest = digest_of(identity_key);
    RecordRow {
        record_id,
        owner_artifact: 0,
        owner_version: 0,
        valid_from,
        valid_to,
        category: CATEGORY_ENTITY,
        kind_id: 0,
        universal_kind_id: 0,
        facets: 0,
        span_artifact_version: 0,
        span_start_byte: 0,
        span_end_byte: 5,
        span_start_line: 0,
        span_end_line: 0,
        identity_type: 0,
        assignment_kind: 0,
        name_id: NONE_U32,
        record_digest: digest_of(identity_key),
        body_digest: [0u8; 32],
        // Deliberately a DIFFERENT digest than `identity_key_digest` --
        // this test's whole point is that `by_identity_id`/`by_identity_key`
        // are two independent indexes, not the same lookup under two names
        // (a bug this test would otherwise fail to catch: reusing
        // `identity_key_digest` for BOTH, as `identity_codec_test.rs`'s own
        // `entity_row` helper does for a DIFFERENT reason -- that file
        // never exercises `identity_id`-keyed lookups at all).
        identity_id: digest_of(&[identity_key, b":id"].concat()),
        identity_key_digest,
        previous_record_id: [0u8; 32],
        source_subject: None,
        target_subject: None,
        relation_kind_id: NONE_U16,
        body: Vec::new(),
        identity_key: identity_key.to_vec(),
    }
}

#[test]
fn by_identity_key_and_by_identity_id_resolve_the_same_row_via_two_independent_indexes() {
    let record_id = digest_of(b"record-a");
    let row = entity_row(record_id, b"jsts:function:src/a.ts:10:greet", 1, 0);
    let identity_id = row.identity_id;
    let identity_key_digest = row.identity_key_digest;
    let dir = tmp_dir("identity-index-basic");
    SegmentWriter::new()
        .write_base(&dir, &[row], &[], &Dictionaries::default(), 1)
        .unwrap();

    let reader = StoreReader::open(&dir).unwrap();
    let by_key = reader
        .by_identity_key(&identity_key_digest, 1)
        .expect("by_identity_key should find the row");
    assert_eq!(by_key.record_id(), record_id);
    let by_id = reader
        .by_identity_id(&identity_id, 1)
        .expect("by_identity_id should find the row");
    assert_eq!(by_id.record_id(), record_id);

    // The two digests are genuinely different values (see `entity_row`'s
    // own comment) -- cross-querying either index with the OTHER's digest
    // must find nothing, proving these are two independent indexes, not
    // one lookup answering to two names.
    assert!(reader.by_identity_key(&identity_id, 1).is_none());
    assert!(reader.by_identity_id(&identity_key_digest, 1).is_none());
}

#[test]
fn by_identity_key_and_by_identity_id_are_visibility_filtered_unlike_by_identity_last() {
    let record_id = digest_of(b"record-b");
    // valid_from = 5: this row does not exist yet at generation 1..4.
    let row = entity_row(record_id, b"jsts:function:src/b.ts:1:notYetVisible", 5, 0);
    let identity_id = row.identity_id;
    let identity_key_digest = row.identity_key_digest;
    let dir = tmp_dir("identity-index-visibility");
    SegmentWriter::new()
        .write_base(&dir, &[row], &[], &Dictionaries::default(), 5)
        .unwrap();

    let reader = StoreReader::open(&dir).unwrap();
    // At generation 1 (before valid_from), the row must be invisible to
    // BOTH indexed lookups -- the exact property `by_identity_last` (no
    // generation parameter at all) cannot express and must never be used
    // for a live query in its place.
    assert!(
        reader.by_identity_key(&identity_key_digest, 1).is_none(),
        "by_identity_key must not return a not-yet-visible row"
    );
    assert!(
        reader.by_identity_id(&identity_id, 1).is_none(),
        "by_identity_id must not return a not-yet-visible row"
    );

    // At generation 5 (>= valid_from, valid_to == 0 i.e. still open), both
    // must find it.
    assert_eq!(
        reader
            .by_identity_key(&identity_key_digest, 5)
            .unwrap()
            .record_id(),
        record_id
    );
    assert_eq!(
        reader.by_identity_id(&identity_id, 5).unwrap().record_id(),
        record_id
    );

    // `by_identity_last` (no visibility filter at all) finds it even at the
    // "too early" query -- confirming this test actually exercises the
    // DIFFERENCE between the two families, not a property they share.
    assert_eq!(
        reader
            .by_identity_last(&identity_key_digest)
            .unwrap()
            .record_id(),
        record_id
    );
}

#[test]
fn by_identity_key_and_by_identity_id_stop_resolving_a_closed_identity() {
    let record_id = digest_of(b"record-c");
    // valid_to = 3: this row was superseded/tombstoned starting at
    // generation 3 (closed-open interval, matching `is_visible`'s
    // `valid_to == 0 || generation < valid_to` convention elsewhere in this
    // crate).
    let row = entity_row(record_id, b"jsts:function:src/c.ts:1:closed", 1, 3);
    let identity_id = row.identity_id;
    let identity_key_digest = row.identity_key_digest;
    let dir = tmp_dir("identity-index-closed");
    SegmentWriter::new()
        .write_base(&dir, &[row], &[], &Dictionaries::default(), 3)
        .unwrap();

    let reader = StoreReader::open(&dir).unwrap();
    assert_eq!(
        reader
            .by_identity_key(&identity_key_digest, 2)
            .unwrap()
            .record_id(),
        record_id,
        "still visible one generation before it closes"
    );
    assert!(
        reader.by_identity_key(&identity_key_digest, 3).is_none(),
        "closed at generation 3, must no longer resolve"
    );
    assert!(
        reader.by_identity_id(&identity_id, 3).is_none(),
        "closed at generation 3, must no longer resolve"
    );
}

#[test]
fn by_identity_id_finds_nothing_for_a_zero_digest_or_unknown_key() {
    let record_id = digest_of(b"record-d");
    let row = entity_row(record_id, b"jsts:function:src/d.ts:1:onlyOne", 1, 0);
    let dir = tmp_dir("identity-index-miss");
    SegmentWriter::new()
        .write_base(&dir, &[row], &[], &Dictionaries::default(), 1)
        .unwrap();

    let reader = StoreReader::open(&dir).unwrap();
    assert!(
        reader.by_identity_id(&[0u8; 32], 1).is_none(),
        "a zero digest must never be indexed (see StoreInner::identity_id_index's own doc comment)"
    );
    assert!(
        reader
            .by_identity_key(&digest_of(b"never-written"), 1)
            .is_none()
    );
    assert!(
        reader
            .by_identity_id(&digest_of(b"never-written"), 1)
            .is_none()
    );
}
