//! F1 1.2: `StoreReader::reopen_if_changed`'s incremental path
//! (`StoreInner::extend`) must produce query results byte-for-byte
//! identical to a from-scratch `StoreReader::open`, at every generation,
//! including for records that live in the BASE and are closed by a delta
//! published long after the reader was first opened (the correctness trap
//! documented on `StoreInner::extend` itself: `Segment::effective_valid_to`
//! reads a per-segment closures map fixed at `Segment::open` time, so a
//! naive "only build a `Segment` for the new delta" reopen would silently
//! keep serving stale closures for every previously-open segment).
//!
//! Independent-review follow-up: every cross-check here goes through
//! [`assert_incremental_matches_fresh`], which also compares `deps_by_
//! owner` (the exact function that reads `dep_owner_index`, the index
//! this task's `extend` shifts by the new segment count instead of
//! re-parsing `deps.meta`), the full `iter_visible_deps` row set, and the
//! full `iter_visible_pending_sites` row set -- not just their aggregate
//! counts. Two more tests cover catching up MORE THAN ONE new delta in a
//! single `reopen_if_changed` call, and a MANIFEST mtime bump that carries
//! no new delta at all (must fall back to a full `load`, not misread as a
//! zero-length extension).

mod common;

use common::*;
use std::collections::HashSet;
use urdira_structural_store::{
    DependencyView, Dictionaries, PendingSiteKey, PendingSiteRow, SegmentWriter, StoreReader,
};

/// A comparable, `Ord`-able snapshot of one `DependencyView`'s visible
/// fields -- `DependencyRow` itself does not derive `PartialEq`/`Ord` (see
/// its own doc comment: it is best-effort metadata, never part of any
/// digest), so every test here compares this tuple instead.
fn dep_row_tuple(v: &DependencyView) -> ([u8; 32], Option<u32>, u32, u32, u32, u32, u8, u32, u32) {
    (
        v.dependency_id(),
        v.record(),
        v.owner_artifact(),
        v.owner_version(),
        v.dep_artifact(),
        v.dep_version(),
        v.role(),
        v.valid_from(),
        v.valid_to_effective(),
    )
}

/// The shared cross-check every test in this file runs: every query
/// surface `StoreInner::extend`'s own doc comment lists as a correctness
/// risk, compared between an incrementally-reopened `persistent` reader
/// and a from-scratch `fresh` one, at `generation`. `touched_owners` is
/// checked via BOTH `by_owner` (the records secondary index) and `deps_
/// by_owner` (the `dep_owner_index` this task shifts instead of
/// rebuilding) -- callers pass the union of every owner touched on either
/// side this round, since checking one index for an owner only the other
/// side touched is still a valid (if less targeted) agreement check.
fn assert_incremental_matches_fresh(
    persistent: &StoreReader,
    fresh: &StoreReader,
    generation: u64,
    touched_owners: &HashSet<u32>,
    label: &str,
) {
    assert_eq!(
        persistent.generation(),
        fresh.generation(),
        "{label}: generation"
    );
    persistent.verify_all().unwrap_or_else(|e| {
        panic!("{label}: verify_all on the incrementally-reopened reader failed: {e}")
    });

    assert_eq!(
        persistent.visible_count(generation),
        fresh.visible_count(generation),
        "{label}: visible_count"
    );
    assert_eq!(
        persistent.deps_visible_count(generation),
        fresh.deps_visible_count(generation),
        "{label}: deps_visible_count"
    );

    // Full `iter_visible` id set.
    let mut incremental_ids: Vec<[u8; 32]> = persistent
        .iter_visible(generation)
        .map(|v| v.record_id())
        .collect();
    incremental_ids.sort();
    let mut fresh_ids: Vec<[u8; 32]> = fresh
        .iter_visible(generation)
        .map(|v| v.record_id())
        .collect();
    fresh_ids.sort();
    assert_eq!(incremental_ids, fresh_ids, "{label}: iter_visible id set");

    // Full `iter_visible_deps` row set (not just `deps_visible_count`).
    let mut incremental_deps: Vec<_> = persistent
        .iter_visible_deps(generation)
        .iter()
        .map(dep_row_tuple)
        .collect();
    incremental_deps.sort();
    let mut fresh_deps: Vec<_> = fresh
        .iter_visible_deps(generation)
        .iter()
        .map(dep_row_tuple)
        .collect();
    fresh_deps.sort();
    assert_eq!(
        incremental_deps, fresh_deps,
        "{label}: iter_visible_deps full rows"
    );

    // Full `iter_visible_pending_sites` row set (`PendingSiteRow` derives
    // `PartialEq`/`Eq`, unlike `DependencyRow`, so no tuple needed here).
    let mut incremental_pending: Vec<PendingSiteRow> = persistent
        .iter_visible_pending_sites(generation)
        .iter()
        .map(|v| v.to_row())
        .collect();
    incremental_pending.sort_by_key(|r| (r.owner_artifact, r.start, r.end, r.site_kind));
    let mut fresh_pending: Vec<PendingSiteRow> = fresh
        .iter_visible_pending_sites(generation)
        .iter()
        .map(|v| v.to_row())
        .collect();
    fresh_pending.sort_by_key(|r| (r.owner_artifact, r.start, r.end, r.site_kind));
    assert_eq!(
        incremental_pending, fresh_pending,
        "{label}: iter_visible_pending_sites full rows"
    );

    for &owner in touched_owners {
        let mut incremental_owned: Vec<[u8; 32]> = persistent
            .by_owner(owner, generation)
            .iter()
            .map(|v| v.record_id())
            .collect();
        incremental_owned.sort();
        let mut fresh_owned: Vec<[u8; 32]> = fresh
            .by_owner(owner, generation)
            .iter()
            .map(|v| v.record_id())
            .collect();
        fresh_owned.sort();
        assert_eq!(
            incremental_owned, fresh_owned,
            "{label}: by_owner owner={owner}"
        );

        // `deps_by_owner` reads `dep_owner_index` -- the exact index
        // `StoreInner::extend` shifts by the new-segment count instead of
        // re-parsing `deps.meta`.
        let mut incremental_dep_owned: Vec<_> = persistent
            .deps_by_owner(owner, generation)
            .iter()
            .map(dep_row_tuple)
            .collect();
        incremental_dep_owned.sort();
        let mut fresh_dep_owned: Vec<_> = fresh
            .deps_by_owner(owner, generation)
            .iter()
            .map(dep_row_tuple)
            .collect();
        fresh_dep_owned.sort();
        assert_eq!(
            incremental_dep_owned, fresh_dep_owned,
            "{label}: deps_by_owner owner={owner}"
        );
    }

    assert_eq!(
        persistent.dictionaries().names.len(),
        fresh.dictionaries().names.len(),
        "{label}: dictionaries().names.len()"
    );
}

/// Five deltas, one persistent `StoreReader` reopened incrementally after
/// each publish, cross-checked against a from-scratch `StoreReader::open`
/// at every generation via [`assert_incremental_matches_fresh`] (visible_
/// count, deps_visible_count, verify_all, the full iter_visible/iter_
/// visible_deps/iter_visible_pending_sites row sets, and by_owner/deps_by_
/// owner for every touched owner). Deliberately mirrors `delta_test.rs`'s
/// `five_deltas_match_reference` fixture shape (random opens/closes across
/// owners, records AND deps AND pending sites) so this test also exercises
/// records/deps/pending-sites opened in the BASE getting closed several
/// deltas later, not just same-generation churn.
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
    let base_pending = gen_pending_sites(40, 12, n_owners, 1, 0);

    SegmentWriter::new()
        .write_base_with_pending(&dir, &base_rows, &base_deps, &dicts, 1, &base_pending)
        .expect("write_base_with_pending");

    let mut reference = RefModel {
        rows: base_rows,
        deps: base_deps,
    };
    // `RefModel` has no pending-site tracking of its own (unlike rows/deps
    // above) -- a plain `Vec` kept alongside it is enough here, since this
    // test only needs to know which keys are CURRENTLY open to pick valid
    // closures from, not a full oracle (that role is played by `fresh`,
    // the from-scratch reader, for pending sites).
    let mut pending_registry: Vec<PendingSiteRow> = base_pending;

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

        // Same "pick a handful of currently-open sites, close them"
        // pattern as records/deps above.
        let open_pending_now: Vec<usize> = pending_registry
            .iter()
            .enumerate()
            .filter(|(_, p)| RefModel::visible(p.valid_from, p.valid_to, prev))
            .map(|(i, _)| i)
            .collect();
        let mut pending_closures: Vec<(PendingSiteKey, u32)> = Vec::new();
        let mut chosen_p = HashSet::new();
        for _ in 0..5 {
            if open_pending_now.is_empty() {
                break;
            }
            let idx = open_pending_now[rng.below(open_pending_now.len() as u32) as usize];
            if chosen_p.insert(idx) {
                let row = &pending_registry[idx];
                pending_closures.push((
                    PendingSiteKey {
                        owner_artifact: row.owner_artifact,
                        start: row.start,
                        end: row.end,
                        site_kind: row.site_kind,
                    },
                    generation,
                ));
            }
        }
        // `key_base` offset by generation so this batch's `(owner, start,
        // end, kind)` keys never collide with an earlier generation's
        // (`gen_pending_sites`'s own doc comment).
        let pending_opened = gen_pending_sites(
            15,
            u64::from(generation) * 4000 + 1,
            n_owners,
            generation,
            generation * 100_000,
        );

        let dict_additions = Dictionaries {
            names: vec![format!("added-name-{generation}")],
            ..Default::default()
        };

        SegmentWriter::new()
            .write_delta_with_pending(
                &dir,
                &new_rows,
                &closures,
                &deps_opened,
                &deps_closures,
                &dict_additions,
                u64::from(generation),
                &pending_opened,
                &pending_closures,
            )
            .expect("write_delta_with_pending");

        let touched_dep_owners: HashSet<u32> = deps_closures
            .iter()
            .map(|(k, _)| {
                reference
                    .deps
                    .iter()
                    .find(|d| &d.dependency_id == k)
                    .unwrap()
                    .owner_artifact
            })
            .chain(deps_opened.iter().map(|d| d.owner_artifact))
            .collect();

        for (k, vt) in &closures {
            reference.close(k, *vt);
        }
        reference.rows.extend(new_rows.clone());
        for (k, vt) in &deps_closures {
            reference.close_dep(k, *vt);
        }
        reference.deps.extend(deps_opened.clone());
        for (key, vt) in &pending_closures {
            if let Some(row) = pending_registry.iter_mut().find(|r| {
                r.owner_artifact == key.owner_artifact
                    && r.start == key.start
                    && r.end == key.end
                    && r.site_kind == key.site_kind
            }) {
                row.valid_to = *vt;
            }
        }
        pending_registry.extend(pending_opened.clone());

        // Incremental reopen of the ONE persistent reader.
        let reopened = persistent
            .reopen_if_changed()
            .expect("reopen_if_changed after write_delta_with_pending");
        assert!(
            reopened,
            "MANIFEST mtime must have advanced (generation {generation})"
        );
        assert_eq!(persistent.generation(), u64::from(generation));

        // Fresh, from-scratch reader for the SAME generation.
        let fresh = StoreReader::open(&dir).expect("fresh open");
        assert_eq!(fresh.generation(), u64::from(generation));

        assert_eq!(
            persistent.visible_count(u64::from(generation)),
            reference.visible_count(u64::from(generation)),
            "visible_count incremental vs reference model at generation {generation}"
        );

        // `by_owner`/`deps_by_owner` for every owner touched this
        // generation (record closures + new rows, PLUS dep closures/
        // opens), including owners whose OWN rows live in the base --
        // this is the closures-fusion correctness trap in practice.
        let mut touched_owners: HashSet<u32> = closures
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
        touched_owners.extend(&touched_dep_owners);

        assert_incremental_matches_fresh(
            &persistent,
            &fresh,
            u64::from(generation),
            &touched_owners,
            &format!("fuzz-gen{generation}"),
        );

        for owner in &touched_owners {
            let mut incremental_owned: Vec<[u8; 32]> = persistent
                .by_owner(*owner, u64::from(generation))
                .iter()
                .map(|v| v.record_id())
                .collect();
            incremental_owned.sort();
            assert_eq!(
                incremental_owned,
                reference.visible_ids_by_owner(*owner, u64::from(generation)),
                "by_owner owner={owner} incremental vs reference model at generation {generation}"
            );
        }
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

/// Independent-review follow-up (coverage gap 2): `reopen_if_changed`
/// must also handle catching up MORE THAN ONE new delta in a single call
/// -- every other test here only ever reopens after exactly one new
/// delta. Publishes generation 3 WITHOUT reopening the persistent reader
/// at all, then generation 4, and only then calls `reopen_if_changed`
/// once -- forcing `new_delta_suffix` to return two names and `StoreInner
/// ::extend` to fold two container opens/closures-merges/`dep_owner_
/// index` shifts in one call (`shift == 2`, not the usual `1`).
#[test]
fn reopen_incremental_handles_two_new_deltas_in_one_reopen() {
    let dir = tmp_dir("reopen-incremental-two-deltas");
    let n_owners = 12u32;
    let dicts = build_dictionaries(n_owners, 30);
    let base_rows = {
        let mut r = gen_rows(300, 50, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_deps = gen_deps(40, 51, n_owners);
    let base_pending = gen_pending_sites(10, 52, n_owners, 1, 0);

    SegmentWriter::new()
        .write_base_with_pending(&dir, &base_rows, &base_deps, &dicts, 1, &base_pending)
        .expect("write_base_with_pending");

    let persistent = StoreReader::open(&dir).expect("open persistent reader");
    assert_eq!(persistent.generation(), 1);

    // Generation 2: reopen normally (the single-delta path every other
    // test already covers) -- just keeps this reader realistically warm.
    let gen2_rows = gen_rows(20, 60, &dicts, 2);
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &gen2_rows,
            &[(base_rows[5].record_id, 2)],
            &[],
            &[],
            &Dictionaries::default(),
            2,
            &[],
            &[],
        )
        .expect("write_delta gen2");
    assert!(persistent.reopen_if_changed().expect("reopen gen2"));
    assert_eq!(persistent.generation(), 2);

    // Generation 3: published but the persistent reader is DELIBERATELY
    // NOT reopened here -- closes a BASE pending site.
    let gen3_rows = gen_rows(20, 70, &dicts, 3);
    let base_pending_key = PendingSiteKey {
        owner_artifact: base_pending[0].owner_artifact,
        start: base_pending[0].start,
        end: base_pending[0].end,
        site_kind: base_pending[0].site_kind,
    };
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &gen3_rows,
            &[(base_rows[6].record_id, 3)],
            &[],
            &[],
            &Dictionaries::default(),
            3,
            &gen_pending_sites(5, 71, n_owners, 3, 300_000),
            &[(base_pending_key, 3)],
        )
        .expect("write_delta gen3 (no reopen yet)");

    // Generation 4: published too, still no reopen -- also opens new deps
    // (exercises `dep_owner_index`'s shift-by-2 for a BRAND NEW segment,
    // not just a carried-forward one).
    let gen4_rows = gen_rows(20, 80, &dicts, 4);
    let gen4_deps_opened = gen_deps(6, 81, n_owners);
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &gen4_rows,
            &[(gen2_rows[0].record_id, 4)],
            &gen4_deps_opened,
            &[],
            &Dictionaries::default(),
            4,
            &gen_pending_sites(5, 82, n_owners, 4, 400_000),
            &[],
        )
        .expect("write_delta gen4 (no reopen yet)");

    // ONE reopen call must catch up both generation 3 and 4 at once.
    let manifest_before = persistent.manifest();
    assert_eq!(
        manifest_before.deltas.len(),
        1,
        "sanity: only generation 2's delta has been reopened so far"
    );
    let reopened = persistent
        .reopen_if_changed()
        .expect("reopen_if_changed catching up two deltas at once");
    assert!(reopened);
    assert_eq!(persistent.generation(), 4);
    let manifest_after = persistent.manifest();
    assert_eq!(
        manifest_after.deltas.len() - manifest_before.deltas.len(),
        2,
        "exactly two new deltas must have been folded in by one reopen_if_changed call"
    );

    let fresh = StoreReader::open(&dir).expect("fresh open at generation 4");

    let mut touched_owners: HashSet<u32> = HashSet::new();
    touched_owners.insert(base_rows[5].owner_artifact);
    touched_owners.insert(base_rows[6].owner_artifact);
    touched_owners.insert(gen2_rows[0].owner_artifact);
    touched_owners.extend(gen2_rows.iter().map(|r| r.owner_artifact));
    touched_owners.extend(gen3_rows.iter().map(|r| r.owner_artifact));
    touched_owners.extend(gen4_rows.iter().map(|r| r.owner_artifact));
    touched_owners.extend(gen4_deps_opened.iter().map(|d| d.owner_artifact));

    assert_incremental_matches_fresh(&persistent, &fresh, 4, &touched_owners, "two-new-deltas");

    // The base pending site closed at generation 3 (a segment that was
    // NOT the newest of the two folded in) must have stayed closed.
    assert!(
        persistent
            .pending_site(&base_pending_key, 4)
            .is_none_or(|v| !v.is_visible(4)),
        "the base pending site closed at generation 3 must not be visible at generation 4"
    );
}

/// Independent-review follow-up (coverage gap 3): touching `MANIFEST`'s
/// mtime WITHOUT changing its content (rewriting the exact same bytes)
/// must NOT be misread as a zero-length extension -- `new_delta_suffix`
/// returns `Some(vec![])` for byte-identical manifests, and `reopen_if_
/// changed`'s guard (`Some(new_delta_names) if !new_delta_names.is_
/// empty()`) must route that to the full `StoreInner::load` fallback
/// arm instead of calling `extend` with zero new deltas.
#[test]
fn reopen_falls_back_when_manifest_mtime_changes_with_no_new_delta() {
    let dir = tmp_dir("reopen-mtime-only-no-new-delta");
    let n_owners = 6u32;
    let dicts = build_dictionaries(n_owners, 15);
    let base_rows = {
        let mut r = gen_rows(100, 90, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &base_rows, &[], &dicts, 1)
        .expect("write_base");

    let persistent = StoreReader::open(&dir).expect("open persistent reader");

    let closed = base_rows[2].record_id;
    SegmentWriter::new()
        .write_delta(
            &dir,
            &gen_rows(10, 91, &dicts, 2),
            &[(closed, 2)],
            &[],
            &[],
            &Dictionaries::default(),
            2,
        )
        .expect("write_delta gen2");
    assert!(persistent.reopen_if_changed().expect("reopen gen2"));
    assert_eq!(persistent.generation(), 2);
    let manifest_before = persistent.manifest();

    // Touch MANIFEST: rewrite the IDENTICAL bytes (bumps mtime, changes
    // nothing else) -- simulates a filesystem/clock quirk or a
    // concurrent no-op republish, without any real new generation. The
    // short sleep guards against coarse filesystem mtime resolution.
    let manifest_path = dir.join("MANIFEST");
    let bytes = std::fs::read(&manifest_path).expect("read MANIFEST");
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&manifest_path, &bytes).expect("rewrite MANIFEST with identical bytes");

    let reopened = persistent
        .reopen_if_changed()
        .expect("reopen_if_changed on a same-content mtime bump");
    assert!(
        reopened,
        "mtime advanced, so reopen_if_changed must report a reload happened"
    );
    assert_eq!(
        persistent.generation(),
        2,
        "no new generation was actually published"
    );
    let manifest_after = persistent.manifest();
    assert_eq!(
        manifest_after, manifest_before,
        "manifest content must be byte-identical -- only its mtime changed"
    );

    let fresh = StoreReader::open(&dir).expect("fresh open");
    let touched_owners: HashSet<u32> = [base_rows[2].owner_artifact].into_iter().collect();
    assert_incremental_matches_fresh(
        &persistent,
        &fresh,
        2,
        &touched_owners,
        "mtime-only-no-new-delta",
    );
}
