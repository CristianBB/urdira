//! Delta: apply 5 random deltas (open/close random owners' rows,
//! dictionary additions) -> queries agree with reference;
//! `changed_between` correct; `visible_count` exact.

mod common;

use common::*;
use std::collections::HashSet;
use urdira_structural_store::{ChangeEntry, Dictionaries, SegmentWriter, StoreReader};

#[test]
fn five_deltas_match_reference() {
    let dir = tmp_dir("delta");
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

    let mut rng = Rng::new(999);
    let mut expected_name_additions = 0usize;

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
        expected_name_additions += 1;

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

        let reader = StoreReader::open(&dir).expect("open");
        assert_eq!(reader.generation(), u64::from(generation));
        reader.verify_all().expect("verify_all after delta");

        assert_eq!(
            reader.visible_count(u64::from(generation)),
            reference.visible_count(u64::from(generation)),
            "visible_count at generation {generation}"
        );
        assert_eq!(
            reader.deps_visible_count(u64::from(generation)),
            reference.deps_visible_count(u64::from(generation)),
            "deps_visible_count at generation {generation}"
        );

        for (k, _) in &closures {
            assert!(
                reader.get_visible(k, prev).is_some(),
                "row must still be visible one generation before its close"
            );
            assert!(
                reader.get_visible(k, u64::from(generation)).is_none(),
                "row must not be visible at the generation it closed"
            );
        }
        for r in &new_rows {
            assert!(
                reader
                    .get_visible(&r.record_id, u64::from(generation))
                    .is_some()
            );
        }

        // by_owner cross-check for every touched owner.
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
            let mut got: Vec<[u8; 32]> = reader
                .by_owner(owner, u64::from(generation))
                .iter()
                .map(|v| v.record_id())
                .collect();
            got.sort();
            assert_eq!(
                got,
                reference.visible_ids_by_owner(owner, u64::from(generation)),
                "by_owner owner={owner} generation={generation}"
            );
        }

        // changed_between(prev, generation).
        let changes = reader.changed_between(prev, u64::from(generation));
        let mut opened_ids: Vec<[u8; 32]> = changes
            .iter()
            .filter_map(|c| match c {
                ChangeEntry::Opened(v) => Some(v.record_id()),
                ChangeEntry::Closed { .. } => None,
            })
            .collect();
        opened_ids.sort();
        let mut want_opened: Vec<[u8; 32]> = new_rows.iter().map(|r| r.record_id).collect();
        want_opened.sort();
        assert_eq!(
            opened_ids, want_opened,
            "changed_between opened set generation={generation}"
        );

        let mut closed_ids: Vec<[u8; 32]> = changes
            .iter()
            .filter_map(|c| match c {
                ChangeEntry::Closed { record_id, .. } => Some(*record_id),
                ChangeEntry::Opened(_) => None,
            })
            .collect();
        closed_ids.sort();
        let mut want_closed: Vec<[u8; 32]> = closures.iter().map(|(k, _)| *k).collect();
        want_closed.sort();
        assert_eq!(
            closed_ids, want_closed,
            "changed_between closed set generation={generation}"
        );

        assert_eq!(
            reader.dictionaries().names.len(),
            dicts.names.len() + expected_name_additions,
            "dict additions must merge across deltas"
        );

        // changed_between over the whole run must equal the union of
        // every per-generation window.
        let full = reader.changed_between(0, u64::from(generation));
        let full_opened: usize = full
            .iter()
            .filter(|c| matches!(c, ChangeEntry::Opened(_)))
            .count();
        assert_eq!(full_opened, (generation as usize - 1) * 200 + 5_000);
    }

    // Final full-set cross-check.
    let reader = StoreReader::open(&dir).expect("open");
    let mut all: Vec<[u8; 32]> = reader.iter_visible(6).map(|v| v.record_id()).collect();
    assert!(all.windows(2).all(|w| w[0] < w[1]));
    all.sort();
    assert_eq!(all, reference.all_visible_ids(6));
}
