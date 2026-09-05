//! F1 1.2: `StoreReader::reopen_if_changed`'s incremental path
//! (`StoreInner::extend`) must produce query results byte-for-byte
//! identical to a from-scratch `StoreReader::open`, at every generation,
//! including for records that live in the BASE and are closed by a delta
//! published long after the reader was first opened (the correctness trap
//! documented on `StoreInner::extend` itself: `Segment::effective_valid_to`
//! reads a per-segment closures map fixed at `Segment::open` time, so a
//! naive "only build a `Segment` for the new delta" reopen would silently
//! keep serving stale closures for every previously-open segment).

mod common;

use common::*;
use std::collections::HashSet;
use urdira_structural_store::{Dictionaries, SegmentWriter, StoreReader};

/// Five deltas, one persistent `StoreReader` reopened incrementally after
/// each publish, cross-checked against a from-scratch `StoreReader::open`
/// at every generation: `visible_count`, `deps_visible_count`,
/// `verify_all()`, the full `iter_visible` id set, and `by_owner` for
/// every owner touched that generation. Deliberately mirrors `delta_test.
/// rs`'s `five_deltas_match_reference` fixture shape (random opens/closes
/// across owners) so this test also exercises records opened in the BASE
/// getting closed several deltas later, not just same-generation churn.
#[test]
fn reopen_incremental_matches_fresh_open() {
    let dir = tmp_dir("reopen-incremental");
    let n_owners = 32u32;
    let dicts = build_dictionaries(n_owners, 100);
    let base_rows = {
        let mut r = gen_rows(5_000, 10, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_deps = gen_deps(300, 11, n_owners);

    SegmentWriter::new()
        .write_base(&dir, &base_rows, &base_deps, &dicts, 1)
        .expect("write_base");

    let mut reference = RefModel {
        rows: base_rows,
        deps: base_deps,
    };

    // The persistent reader: opened once at generation 1, reopened
    // INCREMENTALLY (never re-`open`ed) after every subsequent publish.
    let persistent = StoreReader::open(&dir).expect("open persistent reader");
    assert_eq!(persistent.generation(), 1);

    let mut rng = Rng::new(999);

    for generation in 2u32..=6u32 {
        let prev = u64::from(generation - 1);

        let open_now: Vec<usize> = reference
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| RefModel::visible(r.valid_from, r.valid_to, prev))
            .map(|(i, _)| i)
            .collect();
        let mut closures = Vec::new();
        let mut chosen = HashSet::new();
        for _ in 0..50 {
            if open_now.is_empty() {
                break;
            }
            let idx = open_now[rng.below(open_now.len() as u32) as usize];
            if chosen.insert(idx) {
                closures.push((reference.rows[idx].record_id, generation));
            }
        }

        let new_rows = gen_rows(200, u64::from(generation) * 1000 + 1, &dicts, generation);

        let open_deps_now: Vec<usize> = reference
            .deps
            .iter()
            .enumerate()
            .filter(|(_, d)| RefModel::visible(d.valid_from, d.valid_to, prev))
            .map(|(i, _)| i)
            .collect();
        let mut deps_closures = Vec::new();
        let mut chosen_d = HashSet::new();
        for _ in 0..5 {
            if open_deps_now.is_empty() {
                break;
            }
            let idx = open_deps_now[rng.below(open_deps_now.len() as u32) as usize];
            if chosen_d.insert(idx) {
                deps_closures.push((reference.deps[idx].dependency_id, generation));
            }
        }
        let deps_opened = gen_deps(20, u64::from(generation) * 2000 + 1, n_owners);

        let dict_additions = Dictionaries {
            names: vec![format!("added-name-{generation}")],
            ..Default::default()
        };

        SegmentWriter::new()
            .write_delta(
                &dir,
                &new_rows,
                &closures,
                &deps_opened,
                &deps_closures,
                &dict_additions,
                u64::from(generation),
            )
            .expect("write_delta");

        for (k, vt) in &closures {
            reference.close(k, *vt);
        }
        reference.rows.extend(new_rows.clone());
        for (k, vt) in &deps_closures {
            reference.close_dep(k, *vt);
        }
        reference.deps.extend(deps_opened.clone());

        // Incremental reopen of the ONE persistent reader.
        let reopened = persistent
            .reopen_if_changed()
            .expect("reopen_if_changed after write_delta");
        assert!(
            reopened,
            "MANIFEST mtime must have advanced (generation {generation})"
        );
        assert_eq!(persistent.generation(), u64::from(generation));

        // Fresh, from-scratch reader for the SAME generation.
        let fresh = StoreReader::open(&dir).expect("fresh open");
        assert_eq!(fresh.generation(), u64::from(generation));

        persistent
            .verify_all()
            .expect("verify_all on the incrementally-reopened reader");

        assert_eq!(
            persistent.visible_count(u64::from(generation)),
            fresh.visible_count(u64::from(generation)),
            "visible_count incremental vs fresh at generation {generation}"
        );
        assert_eq!(
            persistent.deps_visible_count(u64::from(generation)),
            fresh.deps_visible_count(u64::from(generation)),
            "deps_visible_count incremental vs fresh at generation {generation}"
        );
        assert_eq!(
            persistent.visible_count(u64::from(generation)),
            reference.visible_count(u64::from(generation)),
            "visible_count incremental vs reference model at generation {generation}"
        );

        // Full `iter_visible` id set must match exactly.
        let mut incremental_ids: Vec<[u8; 32]> = persistent
            .iter_visible(u64::from(generation))
            .map(|v| v.record_id())
            .collect();
        incremental_ids.sort();
        let mut fresh_ids: Vec<[u8; 32]> = fresh
            .iter_visible(u64::from(generation))
            .map(|v| v.record_id())
            .collect();
        fresh_ids.sort();
        assert_eq!(
            incremental_ids, fresh_ids,
            "iter_visible id set incremental vs fresh at generation {generation}"
        );

        // `by_owner` for every owner touched this generation (closures +
        // new rows), including owners whose OWN rows live in the base --
        // this is the closures-fusion correctness trap in practice.
        let touched_owners: HashSet<u32> = closures
            .iter()
            .map(|(k, _)| {
                reference
                    .rows
                    .iter()
                    .find(|r| &r.record_id == k)
                    .unwrap()
                    .owner_artifact
            })
            .chain(new_rows.iter().map(|r| r.owner_artifact))
            .collect();
        for owner in touched_owners {
            let mut incremental_owned: Vec<[u8; 32]> = persistent
                .by_owner(owner, u64::from(generation))
                .iter()
                .map(|v| v.record_id())
                .collect();
            incremental_owned.sort();
            let mut fresh_owned: Vec<[u8; 32]> = fresh
                .by_owner(owner, u64::from(generation))
                .iter()
                .map(|v| v.record_id())
                .collect();
            fresh_owned.sort();
            assert_eq!(
                incremental_owned, fresh_owned,
                "by_owner owner={owner} incremental vs fresh at generation {generation}"
            );
            assert_eq!(
                incremental_owned,
                reference.visible_ids_by_owner(owner, u64::from(generation)),
                "by_owner owner={owner} incremental vs reference model at generation {generation}"
            );
        }

        assert_eq!(
            persistent.dictionaries().names.len(),
            fresh.dictionaries().names.len(),
            "dictionaries().names.len() incremental vs fresh at generation {generation}"
        );
    }
}

/// A deliberately minimal, fully deterministic companion to the fuzz test
/// above: exactly ONE record lives in the BASE, a NEW delta closes it, and
/// nothing else in that generation touches its owner at all. Isolates the
/// exact scenario `StoreInner::extend`'s doc comment warns about (a delta
/// closing a record that lives in an OLDER segment) from the noise of a
/// 5000-row fuzz fixture.
#[test]
fn reopen_incremental_closes_a_base_record_via_a_new_delta() {
    let dir = tmp_dir("reopen-incremental-base-close");
    let n_owners = 4u32;
    let dicts = build_dictionaries(n_owners, 10);
    let base_rows = {
        let mut r = gen_rows(50, 20, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_deps = gen_deps(10, 21, n_owners);
    SegmentWriter::new()
        .write_base(&dir, &base_rows, &base_deps, &dicts, 1)
        .expect("write_base");

    let target = base_rows[17].record_id;
    let target_owner = base_rows[17].owner_artifact;

    let persistent = StoreReader::open(&dir).expect("open persistent reader");
    assert!(persistent.get_visible(&target, 1).is_some());

    // Generation 2: an UNRELATED delta (no closures at all) -- confirms
    // the incremental path handles a "nothing closed yet" delta too.
    SegmentWriter::new()
        .write_delta(
            &dir,
            &gen_rows(5, 30, &dicts, 2),
            &[],
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .expect("write_delta gen2");
    assert!(persistent.reopen_if_changed().expect("reopen gen2"));
    assert_eq!(persistent.generation(), 2);
    assert!(
        persistent.get_visible(&target, 2).is_some(),
        "base record must still be visible before it closes"
    );

    // Generation 3: closes the BASE record via the delta.
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[(target, 3)],
            &[],
            &[],
            &Dictionaries::default(),
            3,
        )
        .expect("write_delta gen3 (closes base record)");
    assert!(persistent.reopen_if_changed().expect("reopen gen3"));
    assert_eq!(persistent.generation(), 3);

    let fresh = StoreReader::open(&dir).expect("fresh open at generation 3");

    // `is_visible` must agree between the incrementally-reopened reader
    // and a from-scratch open, at every relevant generation.
    assert_eq!(
        persistent.get_visible(&target, 2).is_some(),
        fresh.get_visible(&target, 2).is_some()
    );
    assert!(
        persistent.get_visible(&target, 2).is_some(),
        "still visible one generation before its close (incremental reader)"
    );
    assert!(
        persistent.get_visible(&target, 3).is_none(),
        "must not be visible at the generation it closed (incremental reader)"
    );
    assert!(
        fresh.get_visible(&target, 3).is_none(),
        "must not be visible at the generation it closed (fresh reader)"
    );

    // `by_owner` for the target's owner must agree too (the touched-owner
    // path `delta.rs`'s close-protection code relies on).
    let mut incremental_owned: Vec<[u8; 32]> = persistent
        .by_owner(target_owner, 3)
        .iter()
        .map(|v| v.record_id())
        .collect();
    incremental_owned.sort();
    let mut fresh_owned: Vec<[u8; 32]> = fresh
        .by_owner(target_owner, 3)
        .iter()
        .map(|v| v.record_id())
        .collect();
    fresh_owned.sort();
    assert_eq!(incremental_owned, fresh_owned);
    assert!(!incremental_owned.contains(&target));

    // `iter_visible` must agree too.
    let mut incremental_ids: Vec<[u8; 32]> =
        persistent.iter_visible(3).map(|v| v.record_id()).collect();
    incremental_ids.sort();
    let mut fresh_ids: Vec<[u8; 32]> = fresh.iter_visible(3).map(|v| v.record_id()).collect();
    fresh_ids.sort();
    assert_eq!(incremental_ids, fresh_ids);
    assert!(!incremental_ids.contains(&target));

    persistent
        .verify_all()
        .expect("verify_all after base close");
}

/// A "compaction" (a genuinely new base, empty deltas) is NOT a prefix
/// extension of the previous manifest -- `reopen_if_changed` must fall
/// back to a full `StoreInner::load` rather than erroring or serving
/// stale data, and the result must still match a from-scratch open.
#[test]
fn reopen_falls_back_on_non_prefix_manifest() {
    let dir = tmp_dir("reopen-non-prefix-fallback");
    let n_owners = 8u32;
    let dicts = build_dictionaries(n_owners, 20);
    let base_rows = {
        let mut r = gen_rows(200, 40, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &base_rows, &[], &dicts, 1)
        .expect("write_base");

    let persistent = StoreReader::open(&dir).expect("open persistent reader");

    // A normal incremental delta first (exercises the incremental path,
    // same as the other tests here).
    let closed = base_rows[3].record_id;
    SegmentWriter::new()
        .write_delta(
            &dir,
            &gen_rows(10, 41, &dicts, 2),
            &[(closed, 2)],
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .expect("write_delta gen2");
    assert!(persistent.reopen_if_changed().expect("reopen gen2"));
    assert_eq!(persistent.generation(), 2);
    let manifest_before_compaction = persistent.manifest();
    assert!(
        !manifest_before_compaction.deltas.is_empty(),
        "sanity: generation 2 must have a real delta list before compaction"
    );

    // Compaction: folds base + delta into a brand-new base directory and
    // an EMPTY delta list -- `fresh.base != current.base`, so `new_delta_
    // suffix` must return `None` and `reopen_if_changed` must take the
    // full-`load` fallback branch.
    urdira_structural_store::compact(&dir, 3).expect("compact");

    let reopened = persistent
        .reopen_if_changed()
        .expect("reopen_if_changed across a compaction");
    assert!(reopened, "compaction must be observed as a change");
    assert_eq!(persistent.generation(), 3);
    let manifest_after_compaction = persistent.manifest();
    assert_ne!(
        manifest_after_compaction.base, manifest_before_compaction.base,
        "compaction must have produced a new base"
    );
    assert!(
        manifest_after_compaction.deltas.is_empty(),
        "compaction folds every delta into the new base"
    );

    let fresh = StoreReader::open(&dir).expect("fresh open after compaction");
    assert_eq!(persistent.generation(), fresh.generation());
    assert_eq!(
        persistent.visible_count(3),
        fresh.visible_count(3),
        "visible_count incremental(fallback) vs fresh after compaction"
    );
    assert!(
        persistent.get_visible(&closed, 3).is_none(),
        "the record closed before compaction must stay closed after it"
    );
    persistent
        .verify_all()
        .expect("verify_all after compaction fallback reopen");

    // One more ordinary incremental delta AFTER the compaction, to prove
    // the persistent reader's post-fallback state is a fully working base
    // for further incremental reopens (not just a one-shot recovery).
    SegmentWriter::new()
        .write_delta(
            &dir,
            &gen_rows(5, 42, &dicts, 4),
            &[],
            &[],
            &[],
            &Dictionaries::default(),
            4,
        )
        .expect("write_delta gen4 (post-compaction)");
    assert!(persistent.reopen_if_changed().expect("reopen gen4"));
    assert_eq!(persistent.generation(), 4);
    let fresh4 = StoreReader::open(&dir).expect("fresh open gen4");
    assert_eq!(persistent.visible_count(4), fresh4.visible_count(4));
}
