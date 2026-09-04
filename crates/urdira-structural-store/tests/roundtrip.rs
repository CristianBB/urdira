//! Round trip: write_base with 50k synthetic rows -> open -> every query
//! agrees with a naive in-memory reference, including visibility at
//! several generations.

mod common;

use common::*;
use urdira_structural_store::{Direction, SegmentWriter, StoreReader};

#[test]
fn roundtrip_50k_rows_matches_reference() {
    let dir = tmp_dir("roundtrip");
    let dicts = build_dictionaries(64, 500);
    let mut rows = gen_rows(50_000, 1, &dicts, 1);
    // Give ~10% of rows a valid_to already set at cold-write time, at a
    // few different generations, so visibility filtering has real
    // history to check, not just "everything open".
    {
        let mut rng = Rng::new(777);
        for r in rows.iter_mut() {
            if rng.below(100) < 10 {
                r.valid_to = 1 + rng.below(3);
            }
        }
    }
    rows.sort_by_key(|r| r.record_id);
    let deps = gen_deps(2_000, 2, dicts.artifacts.len() as u32);

    let summary = SegmentWriter::new()
        .write_base(&dir, &rows, &deps, &dicts, 5)
        .expect("write_base");
    assert_eq!(summary.generation, 5);
    assert!(!summary.files.is_empty());

    let reader = StoreReader::open(&dir).expect("open");
    reader.wait_prefault();
    reader
        .verify_all()
        .expect("verify_all on a freshly written base");
    assert_eq!(reader.generation(), 5);

    let reference = RefModel {
        rows: rows.clone(),
        deps: deps.clone(),
    };

    for g in [0u64, 1, 2, 3, 5] {
        // get() / get_visible()
        for r in rows.iter().step_by(97) {
            let visible = RefModel::visible(r.valid_from, r.valid_to, g);
            let got = reader.get_visible(&r.record_id, g);
            assert_eq!(got.is_some(), visible, "get_visible mismatch at g={g}");
            if let Some(view) = got {
                assert_eq!(view.record_digest(), r.record_digest);
                assert_eq!(view.owner_artifact(), r.owner_artifact);
                assert_eq!(view.body(), r.body.as_slice());
                assert_eq!(view.identity_key(), r.identity_key.as_slice());
                assert_eq!(view.valid_from(), r.valid_from);
                assert_eq!(view.facets(), r.facets);
            }
        }

        // by_owner
        for owner in [0u32, 5, 10, 63] {
            let mut got: Vec<[u8; 32]> = reader
                .by_owner(owner, g)
                .iter()
                .map(|v| v.record_id())
                .collect();
            got.sort();
            assert_eq!(
                got,
                reference.visible_ids_by_owner(owner, g),
                "by_owner g={g} owner={owner}"
            );
        }

        // by_name
        for name_id in [0u32, 42, 1999] {
            let mut got: Vec<[u8; 32]> = reader
                .by_name(name_id, g)
                .iter()
                .map(|v| v.record_id())
                .collect();
            got.sort();
            assert_eq!(
                got,
                reference.visible_ids_by_name(name_id, g),
                "by_name g={g}"
            );
        }

        // by_kind (no limit/cursor)
        for (uk, cat, kd) in [
            (0u16, urdira_structural_store::CATEGORY_ENTITY, 0u16),
            (1, urdira_structural_store::CATEGORY_RELATION, 2),
        ] {
            let mut got: Vec<[u8; 32]> = reader
                .by_kind(uk, cat, kd, g, usize::MAX, None)
                .iter()
                .map(|v| v.record_id())
                .collect();
            got.sort();
            assert_eq!(
                got,
                reference.visible_ids_by_kind(uk, cat, kd, g),
                "by_kind g={g}"
            );
        }

        // adjacency
        for subject_ord in [0u32, 10, 100, 499] {
            let key = dicts.subjects[subject_ord as usize];
            let mut got_out: Vec<[u8; 32]> = reader
                .adjacency(&key, Direction::Out, g)
                .iter()
                .map(|v| v.record_id())
                .collect();
            got_out.sort();
            assert_eq!(
                got_out,
                reference.visible_ids_adjacency_out(subject_ord, g),
                "adjacency out g={g} subject={subject_ord}"
            );

            let mut got_in: Vec<[u8; 32]> = reader
                .adjacency(&key, Direction::In, g)
                .iter()
                .map(|v| v.record_id())
                .collect();
            got_in.sort();
            assert_eq!(
                got_in,
                reference.visible_ids_adjacency_in(subject_ord, g),
                "adjacency in g={g} subject={subject_ord}"
            );
        }

        // visible_count
        assert_eq!(
            reader.visible_count(g),
            reference.visible_count(g),
            "visible_count g={g}"
        );
        assert_eq!(
            reader.deps_visible_count(g),
            reference.deps_visible_count(g),
            "deps_visible_count g={g}"
        );

        // iter_visible: exact set + strictly ascending key order
        let seq: Vec<[u8; 32]> = reader.iter_visible(g).map(|v| v.record_id()).collect();
        assert!(
            seq.windows(2).all(|w| w[0] < w[1]),
            "iter_visible not ascending at g={g}"
        );
        let mut got_all = seq.clone();
        got_all.sort();
        assert_eq!(
            got_all,
            reference.all_visible_ids(g),
            "iter_visible set g={g}"
        );
    }

    // by_kind pagination
    let (uk, cat, kd) = (0u16, urdira_structural_store::CATEGORY_ENTITY, 0u16);
    let mut want = reference.visible_ids_by_kind(uk, cat, kd, 5);
    want.sort();
    let mut got = Vec::new();
    let mut after = None;
    loop {
        let page = reader.by_kind(uk, cat, kd, 5, 7, after);
        if page.is_empty() {
            break;
        }
        after = Some(page.last().unwrap().record_id());
        got.extend(page.iter().map(|v| v.record_id()));
    }
    assert_eq!(
        got, want,
        "by_kind pagination must reassemble the full unpaginated result"
    );

    // by_identity_last: latest row (incl. closed) per identity digest.
    for r in rows.iter().step_by(500) {
        let want_id = reference
            .rows
            .iter()
            .filter(|c| c.identity_key_digest == r.identity_key_digest)
            .max_by_key(|c| c.valid_from)
            .map(|c| c.record_id);
        let got_id = reader
            .by_identity_last(&r.identity_key_digest)
            .map(|v| v.record_id());
        assert_eq!(got_id, want_id, "by_identity_last");
    }

    // iter_visible_batches reassembles the same set.
    let mut batched: Vec<[u8; 32]> = reader
        .iter_visible_batches(5, 4096)
        .flat_map(|batch| batch.into_iter().map(|v| v.record_id()))
        .collect();
    batched.sort();
    assert_eq!(batched, reference.all_visible_ids(5));

    // deps_by_owner / deps_reverse
    for owner in [0u32, 10, 30] {
        let mut got: Vec<[u8; 32]> = reader
            .deps_by_owner(owner, 5)
            .iter()
            .map(|v| v.dependency_id())
            .collect();
        got.sort();
        let mut want: Vec<[u8; 32]> = deps
            .iter()
            .filter(|d| d.owner_artifact == owner && RefModel::visible(d.valid_from, d.valid_to, 5))
            .map(|d| d.dependency_id)
            .collect();
        want.sort();
        assert_eq!(got, want, "deps_by_owner owner={owner}");
    }
    for dep_artifact in [0u32, 10, 30] {
        let mut got: Vec<[u8; 32]> = reader
            .deps_reverse(dep_artifact, 5)
            .iter()
            .map(|v| v.dependency_id())
            .collect();
        got.sort();
        let mut want: Vec<[u8; 32]> = deps
            .iter()
            .filter(|d| {
                d.dep_artifact == dep_artifact && RefModel::visible(d.valid_from, d.valid_to, 5)
            })
            .map(|d| d.dependency_id)
            .collect();
        want.sort();
        assert_eq!(got, want, "deps_reverse dep_artifact={dep_artifact}");
    }
}
