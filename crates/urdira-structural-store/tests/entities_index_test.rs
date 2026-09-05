//! F4 4.3: round-trip for the `entities.index` section
//! (`SectionId::EntitiesIndex`) across a base plus two deltas --
//! `StoreReader::entity_by_owner_and_start` must resolve exactly the row
//! that is visible at the QUERIED generation, even when an owner/start key
//! is reused by a later generation's replacement row (the same "close old,
//! open new at the same span" pattern a real edit or residual upgrade
//! produces), and a `jsts:entity_inferred_type` row must never be
//! findable through this index at all (it deliberately shares its
//! declaration's own `(owner, start)` key -- see
//! `segment_io::is_entities_index_row`'s doc comment).

mod common;

use common::*;
use urdira_structural_store::{
    CATEGORY_ENTITY, Dictionaries, NONE_U16, NONE_U32, RecordRow, SegmentWriter, StoreReader,
};

/// One deterministic, uniquely-identified `CATEGORY_ENTITY` row. `tag` only
/// needs to make `identity_key`/`body` distinct across calls (this test
/// never decodes a body) -- `record_id` is that identity key's own digest,
/// good enough for a synthetic fixture with no real content-derived-identity
/// requirement.
fn entity_row(owner: u32, start: u32, valid_from: u32, kind_id: u16, tag: &str) -> RecordRow {
    let identity_key = format!("entity:{owner}:{start}:{tag}").into_bytes();
    let body = format!("body:{owner}:{start}:{tag}").into_bytes();
    let record_digest = digest_of(&body);
    let identity_key_digest = digest_of(&identity_key);
    RecordRow {
        record_id: identity_key_digest,
        owner_artifact: owner,
        owner_version: 0,
        valid_from,
        valid_to: 0,
        category: CATEGORY_ENTITY,
        kind_id,
        universal_kind_id: 0,
        facets: 0,
        span_artifact_version: 0,
        span_start_byte: start,
        span_end_byte: start + 10,
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

#[test]
fn entities_index_round_trips_across_base_and_two_deltas_with_visibility_by_generation() {
    let dir = tmp_dir("entities-index");
    let mut dicts = build_dictionaries(4, 0);
    // The one exclusion `entities.index` cares about -- appended at the end
    // so it does not collide with `build_dictionaries`' own `kind:0..8`.
    let inferred_type_kind_id = dicts.kinds.len() as u16;
    dicts.kinds.push("jsts:entity_inferred_type".to_string());

    // -- Base (generation 1) --
    let e1 = entity_row(0, 100, 1, 0, "e1"); // stays open through gen 3
    let e2 = entity_row(0, 200, 1, 0, "e2"); // closed at gen 2, replaced by e4
    let e3 = entity_row(1, 100, 1, 0, "e3"); // closed at gen 3, replaced by e6
    let inferred = entity_row(2, 300, 1, inferred_type_kind_id, "inferred-e1");
    let base_rows = vec![e1.clone(), e2.clone(), e3.clone(), inferred.clone()];

    let writer = SegmentWriter::new();
    writer
        .write_base(&dir, &base_rows, &[], &dicts, 1)
        .expect("write_base");

    // -- Delta 1 (generation 2): close e2, open e4 at the SAME (owner, start). --
    let e4 = entity_row(0, 200, 2, 0, "e4");
    let reader = StoreReader::open(&dir).expect("open after base");
    writer
        .write_delta_with_reader(
            &dir,
            &reader,
            std::slice::from_ref(&e4),
            &[(e2.record_id, 2)],
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .expect("write_delta 1");

    // -- Delta 2 (generation 3): close e1 and e3, open e5/e6 at their SAME keys. --
    let e5 = entity_row(0, 100, 3, 0, "e5");
    let e6 = entity_row(1, 100, 3, 0, "e6");
    reader.reopen_if_changed().expect("reopen after delta 1");
    writer
        .write_delta_with_reader(
            &dir,
            &reader,
            &[e5.clone(), e6.clone()],
            &[(e1.record_id, 3), (e3.record_id, 3)],
            &[],
            &[],
            &Dictionaries::default(),
            3,
        )
        .expect("write_delta 2");

    reader.reopen_if_changed().expect("reopen after delta 2");

    let resolves_to = |owner: u32, start: u32, generation: u64| -> Option<[u8; 32]> {
        reader
            .entity_by_owner_and_start(owner, start, generation)
            .map(|view| view.record_id())
    };

    // Generation 1: only the base's own rows exist yet.
    assert_eq!(resolves_to(0, 100, 1), Some(e1.record_id));
    assert_eq!(resolves_to(0, 200, 1), Some(e2.record_id));
    assert_eq!(resolves_to(1, 100, 1), Some(e3.record_id));
    assert_eq!(
        resolves_to(2, 300, 1),
        None,
        "a jsts:entity_inferred_type row must never be findable via entities.index"
    );

    // Generation 2: e2 -> e4 at (0, 200); e1/e3 untouched.
    assert_eq!(resolves_to(0, 100, 2), Some(e1.record_id));
    assert_eq!(
        resolves_to(0, 200, 2),
        Some(e4.record_id),
        "the delta-1 replacement must win over the now-closed base row"
    );
    assert_eq!(resolves_to(1, 100, 2), Some(e3.record_id));
    assert_eq!(resolves_to(2, 300, 2), None);

    // Generation 3: e1 -> e5 at (0, 100); e3 -> e6 at (1, 100); (0, 200)
    // still e4 (delta-2 never touched it).
    assert_eq!(
        resolves_to(0, 100, 3),
        Some(e5.record_id),
        "the delta-2 replacement must win over the now-closed base row"
    );
    assert_eq!(resolves_to(0, 200, 3), Some(e4.record_id));
    assert_eq!(
        resolves_to(1, 100, 3),
        Some(e6.record_id),
        "the delta-2 replacement must win over the now-closed base row"
    );
    assert_eq!(resolves_to(2, 300, 3), None);

    // A key that never existed at all.
    assert_eq!(resolves_to(3, 999, 3), None);

    // `verify_all` must accept the new mandatory section's header/xxh3 on
    // every segment (base + 2 deltas).
    reader
        .verify_all()
        .expect("verify_all accepts entities.index");
}

/// Revision fix (2026-09-05): `StoreReader::entity_by_owner_and_start`'s
/// deterministic tie-break (greatest `valid_from`, then newest segment,
/// then greatest `ordinal`) among several VISIBLE candidates sharing the
/// same `(owner, start)` key -- a genuine ambiguity this store format does
/// not itself forbid (only `push_entity`'s own producer discipline
/// normally prevents two LIVE rows at the same span; this test constructs
/// the ambiguous input directly rather than relying on a real corpus
/// happening to contain one).
#[test]
fn entity_by_owner_and_start_breaks_ties_deterministically() {
    let dicts = build_dictionaries(2, 0);
    let writer = SegmentWriter::new();

    // -- Same segment, same `valid_from`: the tie-break falls all the way
    // through to `ordinal`, which is this row's own position in
    // `compute_order`'s record_id-ascending sort within the base -- so the
    // row with the GREATER `record_id` (`high`) must win.
    let dir_a = tmp_dir("entities-index-tie-ordinal");
    let mut low = entity_row(0, 100, 1, 0, "low");
    low.record_id = [0x01; 32];
    let mut high = entity_row(0, 100, 1, 0, "high");
    high.record_id = [0xFF; 32];
    writer
        .write_base(&dir_a, &[low.clone(), high.clone()], &[], &dicts, 1)
        .expect("write_base (ordinal tie fixture)");
    let reader_a = StoreReader::open(&dir_a).expect("open ordinal tie fixture");
    assert_eq!(
        reader_a
            .entity_by_owner_and_start(0, 100, 1)
            .map(|view| view.record_id()),
        Some(high.record_id),
        "same valid_from, same segment: the candidate with the greater ordinal must win"
    );

    // -- Different segments, same key, BOTH still visible (the base row is
    // deliberately never closed): the delta's own row has the GREATER
    // `valid_from` and must win regardless of ordinal/record_id, since
    // `valid_from` is the PRIMARY tie-break key, checked before segment
    // recency or ordinal.
    let dir_b = tmp_dir("entities-index-tie-valid-from");
    let mut old = entity_row(1, 50, 1, 0, "old");
    old.record_id = [0xFF; 32]; // deliberately the LARGER record_id, to prove valid_from wins first.
    writer
        .write_base(&dir_b, &[old.clone()], &[], &dicts, 1)
        .expect("write_base (valid_from tie fixture)");
    let reader_b = StoreReader::open(&dir_b).expect("open valid_from tie fixture");
    let new_row = entity_row(1, 50, 2, 0, "new");
    writer
        .write_delta_with_reader(
            &dir_b,
            &reader_b,
            std::slice::from_ref(&new_row),
            &[], // `old` is deliberately never closed -- both rows are live.
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .expect("write_delta (valid_from tie fixture)");
    reader_b.reopen_if_changed().expect("reopen");
    assert_eq!(
        reader_b
            .entity_by_owner_and_start(1, 50, 2)
            .map(|view| view.record_id()),
        Some(new_row.record_id),
        "both rows visible at generation 2: the one with the greater valid_from must win, \
         even though the older row has the numerically larger record_id"
    );
    // At generation 1 only `old` was open yet -- unambiguous, no tie to break.
    assert_eq!(
        reader_b
            .entity_by_owner_and_start(1, 50, 1)
            .map(|view| view.record_id()),
        Some(old.record_id)
    );
}
