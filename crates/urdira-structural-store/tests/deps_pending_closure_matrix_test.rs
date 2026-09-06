//! Adversarial review of frente E-P0 (`docs/decisions/26-v4-structural-store.md`
//! "Effective valid_to"; `Segment::deps_effective_valid_to`/
//! `pending_effective_valid_to`'s own doc comments): `dependency_id` and
//! `PendingSiteKey` are plain, reusable, unsalted keys (unlike `record_id`,
//! which is chained fresh on every replace/reopen and therefore closes at
//! most once, ever, per key). This file drives a single reused key through
//! a full open/close/reopen/close cycle across many generations and checks
//! EVERY read generation in between, at the raw writer/reader level
//! (bypassing `urdira-indexing-worker`'s `delta.rs` entirely) -- exactly
//! the table-matrix the frente E-P0 adversarial review asked for.
//!
//! Found live by this review: the first cut of the P0-1 fix (`ae61841`)
//! gated a closure lookup by the row's own `valid_from`, but merged
//! `dep_closures`/`pending_closures` into a flat `HashMap<key, u32>`
//! (last-write-wins) -- correct for a key closed at most ONCE across the
//! store's history, silently wrong for a key closed TWICE or more (not
//! "three or more", as that commit's own doc comment claimed): a
//! point-in-time read strictly between two of the key's closures sees the
//! WRONG (too-late) effective `valid_to`, and `deps_visible_count`
//! overcounts live edges at ANY generation, including the current one, no
//! historical query needed. Fixed in this review by keeping every closure
//! ever recorded against a key (`Vec<u32>`) and picking, per row, the
//! smallest one strictly after that row's own `valid_from`.

mod common;

use common::*;
use urdira_structural_store::{
    DependencyRow, PendingSiteKey, PendingSiteRow, SegmentWriter, StoreReader,
};

const OWNER: u32 = 0;

fn dep_row(dependency_id: [u8; 32], valid_from: u32) -> DependencyRow {
    DependencyRow {
        dependency_id,
        record: None,
        owner_artifact: OWNER,
        owner_version: 0,
        dep_artifact: 1,
        dep_version: 0,
        role: 1,
        valid_from,
        valid_to: 0,
    }
}

fn pending_row(start: u32, valid_from: u32) -> PendingSiteRow {
    PendingSiteRow {
        owner_artifact: OWNER,
        owner_version: 0,
        valid_from,
        valid_to: 0,
        start,
        end: start + 10,
        start_line: 1,
        end_line: 1,
        site_kind: urdira_structural_store::PENDING_SITE_KIND_CALL,
        reason: 0,
        source_subject: None,
    }
}

/// The full matrix: `K`/`P` open at g1, close at g3, reopen at g5, close
/// at g7 -- every intervening generation (2,4,6,8) is a no-op delta, so
/// each of g2/g4/g6/g8 is a REAL published generation whose read must show
/// the historically-correct answer, not just "whatever the current
/// generation's answer happens to be" (g8's read, at the very end, IS the
/// current generation, so it alone would pass even under the buggy
/// last-write-wins map -- g2/g4/g6 are what actually distinguish the fix).
#[test]
fn reused_key_survives_two_full_close_reopen_cycles_at_every_read_generation() {
    let dir = tmp_dir("deps-pending-matrix");
    let dicts = build_dictionaries(4, 4);
    let dependency_id = [0x11u8; 32];
    let pending_key = PendingSiteKey {
        owner_artifact: OWNER,
        start: 500,
        end: 510,
        site_kind: urdira_structural_store::PENDING_SITE_KIND_CALL,
    };

    // g1 (base): K, P opened.
    SegmentWriter::new()
        .write_base_with_pending(
            &dir,
            &[],
            &[dep_row(dependency_id, 1)],
            &dicts,
            1,
            &[pending_row(500, 1)],
        )
        .expect("write_base_with_pending g1");

    // g2: no-op delta (advances the generation only).
    SegmentWriter::new()
        .write_delta_with_pending(&dir, &[], &[], &[], &[], &Default::default(), 2, &[], &[])
        .expect("write_delta g2 (no-op)");

    // g3: close K, close P.
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 3)],
            &Default::default(),
            3,
            &[],
            &[(pending_key, 3)],
        )
        .expect("write_delta g3 (close)");

    // g4: no-op delta.
    SegmentWriter::new()
        .write_delta_with_pending(&dir, &[], &[], &[], &[], &Default::default(), 4, &[], &[])
        .expect("write_delta g4 (no-op)");

    // g5: reopen K, P (SAME keys, fresh physical rows).
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[dep_row(dependency_id, 5)],
            &[],
            &Default::default(),
            5,
            &[pending_row(500, 5)],
            &[],
        )
        .expect("write_delta g5 (reopen)");

    // g6: no-op delta.
    SegmentWriter::new()
        .write_delta_with_pending(&dir, &[], &[], &[], &[], &Default::default(), 6, &[], &[])
        .expect("write_delta g6 (no-op)");

    // g7: close K, P AGAIN -- this is the SECOND closure of this exact
    // key, the case the first cut of the P0-1 fix collapsed away.
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 7)],
            &Default::default(),
            7,
            &[],
            &[(pending_key, 7)],
        )
        .expect("write_delta g7 (close again)");

    // g8: no-op delta.
    SegmentWriter::new()
        .write_delta_with_pending(&dir, &[], &[], &[], &[], &Default::default(), 8, &[], &[])
        .expect("write_delta g8 (no-op)");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");
    assert_eq!(reader.generation(), 8);

    let dep_visible_at = |g: u64| -> bool {
        reader
            .deps_by_owner(OWNER, g)
            .iter()
            .any(|v| v.dependency_id() == dependency_id)
    };
    let pending_visible_at = |g: u64| -> bool { reader.pending_site(&pending_key, g).is_some() };

    // The ground truth, generation by generation.
    let expected: &[(u64, bool)] = &[
        (1, true),  // just opened
        (2, true),  // still open (no-op delta)
        (3, false), // closed AT g3 (is_visible is exclusive of valid_to)
        (4, false), // still closed (no-op delta)
        (5, true),  // reopened AT g5
        (6, true),  // still open (no-op delta)
        (7, false), // closed AGAIN at g7 -- the second-cycle case
        (8, false), // still closed (no-op delta, and this IS "current")
    ];
    for &(g, want) in expected {
        assert_eq!(
            dep_visible_at(g),
            want,
            "dependency visibility mismatch at generation {g}"
        );
        assert_eq!(
            pending_visible_at(g),
            want,
            "pending-site visibility mismatch at generation {g}"
        );
    }

    // deps_visible_count/pending_sites_visible_count must agree with the
    // same ground truth for THIS key's own contribution (the store has no
    // other rows in this test, so the count is exactly 0 or 1).
    for &(g, want) in expected {
        assert_eq!(
            reader.deps_visible_count(g),
            want as u64,
            "deps_visible_count mismatch at generation {g}"
        );
        assert_eq!(
            reader.pending_sites_visible_count(g),
            want as u64,
            "pending_sites_visible_count mismatch at generation {g}"
        );
    }
}

/// Isolates the `deps_visible_count` aggregate-formula bug this review
/// found: it does not require reading an old generation at all -- a key
/// closed twice, queried only at the CURRENT (final) generation, already
/// overcounts under the flat last-write-wins map, because that function's
/// `O(log n)` derivation subtracts one unit per map ENTRY, not one unit
/// per physically closed row.
#[test]
fn deps_visible_count_does_not_overcount_a_twice_closed_key() {
    let dir = tmp_dir("deps-visible-count-twice-closed");
    let dicts = build_dictionaries(4, 4);
    let dependency_id = [0x22u8; 32];

    SegmentWriter::new()
        .write_base(&dir, &[], &[dep_row(dependency_id, 1)], &dicts, 1)
        .expect("write_base");
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 2)],
            &Default::default(),
            2,
        )
        .expect("close at g2");
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[dep_row(dependency_id, 3)],
            &[],
            &Default::default(),
            3,
        )
        .expect("reopen at g3");
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 4)],
            &Default::default(),
            4,
        )
        .expect("close again at g4 (second closure of this key)");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");
    assert_eq!(reader.generation(), 4);

    // Currently closed (since g4, never reopened again): both the exact
    // per-row query and the aggregate count must agree it is invisible.
    assert!(
        reader
            .deps_by_owner(OWNER, 4)
            .iter()
            .all(|v| v.dependency_id() != dependency_id)
    );
    assert_eq!(
        reader.deps_visible_count(4),
        0,
        "a twice-closed, currently-closed key must not be counted as visible"
    );
}

/// Reader tolerance for the LEGACY pattern (the pre-frente-E-P0 `delta.rs`
/// owner-granularity diff, and today's still-current `pending.sites`
/// wholesale-replace-on-every-touch): a closure and a reopen of the
/// IDENTICAL key recorded in the SAME generation. The valid_from gate
/// (`closed_at > valid_from`, strict) must resolve the OLD row as closed
/// exactly at that generation and the NEW row as open from that same
/// generation, never hiding the reopened row.
#[test]
fn same_generation_close_and_reopen_of_the_identical_key_is_tolerated() {
    let dir = tmp_dir("deps-pending-same-gen-reopen");
    let dicts = build_dictionaries(4, 4);
    let dependency_id = [0x33u8; 32];
    let pending_key = PendingSiteKey {
        owner_artifact: OWNER,
        start: 700,
        end: 710,
        site_kind: urdira_structural_store::PENDING_SITE_KIND_CALL,
    };

    SegmentWriter::new()
        .write_base_with_pending(
            &dir,
            &[],
            &[dep_row(dependency_id, 1)],
            &dicts,
            1,
            &[pending_row(700, 1)],
        )
        .expect("write_base_with_pending g1");

    // g2: close AND reopen the identical key in the SAME delta -- exactly
    // what the pre-fix `delta.rs` used to do for every "unchanged" edge,
    // and what `pending.sites`' wholesale replace still does today for
    // every reprocessed owner.
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[dep_row(dependency_id, 2)],
            &[(dependency_id, 2)],
            &Default::default(),
            2,
            &[pending_row(700, 2)],
            &[(pending_key, 2)],
        )
        .expect("write_delta g2 (same-generation close+reopen)");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");

    // At g1: the OLD row, still open.
    assert!(
        reader
            .deps_by_owner(OWNER, 1)
            .iter()
            .any(|v| v.dependency_id() == dependency_id)
    );
    assert!(reader.pending_site(&pending_key, 1).is_some());

    // At g2 (the generation of the close+reopen itself): the NEW row must
    // be visible -- the whole point of the valid_from gate.
    assert!(
        reader
            .deps_by_owner(OWNER, 2)
            .iter()
            .any(|v| v.dependency_id() == dependency_id),
        "the reopened row at the SAME generation as its predecessor's close must be visible"
    );
    assert!(
        reader.pending_site(&pending_key, 2).is_some(),
        "the reopened pending site at the SAME generation as its predecessor's close must be visible"
    );
    assert_eq!(reader.deps_visible_count(2), 1);
    assert_eq!(reader.pending_sites_visible_count(2), 1);
}

/// Compaction resets the closures history to empty (bases carry none, by
/// construction) -- after the full close/reopen/close matrix above,
/// compacting at the CURRENT (closed) generation must not resurrect the
/// dead key, and compacting while the key is OPEN must keep it open with
/// no residual multi-closure ambiguity afterward (the compacted base has
/// exactly one physical row for the key, with no closures section at
/// all).
#[test]
fn compaction_after_a_two_cycle_history_preserves_the_correct_final_state() {
    let dir = tmp_dir("deps-pending-compaction-two-cycle");
    let dicts = build_dictionaries(4, 4);
    let dependency_id = [0x44u8; 32];

    SegmentWriter::new()
        .write_base(&dir, &[], &[dep_row(dependency_id, 1)], &dicts, 1)
        .expect("write_base");
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 2)],
            &Default::default(),
            2,
        )
        .expect("close at g2");
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[dep_row(dependency_id, 3)],
            &[],
            &Default::default(),
            3,
        )
        .expect("reopen at g3");

    // Compact while the key is OPEN (current generation 3).
    urdira_structural_store::compact(&dir, 3).expect("compact while open");
    let reader = StoreReader::open(&dir).expect("open after compact-while-open");
    reader.verify_all().expect("verify_all");
    assert!(
        reader
            .deps_by_owner(OWNER, 3)
            .iter()
            .any(|v| v.dependency_id() == dependency_id),
        "compacting while the key is open must keep it visible"
    );
    assert_eq!(reader.deps_visible_count(3), 1);

    // Now close it again post-compaction (second closure since the
    // compaction boundary) and compact again at the closed generation.
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[],
            &[(dependency_id, 4)],
            &Default::default(),
            4,
        )
        .expect("close at g4 (post-compaction)");
    urdira_structural_store::compact(&dir, 4).expect("compact while closed");
    let reader = StoreReader::open(&dir).expect("open after compact-while-closed");
    reader.verify_all().expect("verify_all");
    assert!(
        reader
            .deps_by_owner(OWNER, 4)
            .iter()
            .all(|v| v.dependency_id() != dependency_id),
        "compacting a closed key must not resurrect it"
    );
    assert_eq!(reader.deps_visible_count(4), 0);
}

/// Cost check (item 6 of the review): a key reused/closed many times (the
/// documented worst case -- a `pending.sites` key touched on every delta
/// since the last compaction) must not make the reader's per-row gate
/// (or `deps_visible_count`'s aggregate derivation) scale badly, and a
/// large corpus of DISTINCT keys (no reuse at all -- the overwhelmingly
/// common case) must stay fast. Not a strict benchmark -- a generous
/// wall-clock ceiling that only a real quadratic regression would miss.
#[test]
fn fifty_thousand_distinct_keys_plus_one_heavily_reused_key_stays_fast() {
    let dir = tmp_dir("deps-pending-perf-50k");
    let dicts = build_dictionaries(4, 4);
    let n = 50_000usize;
    let base_deps: Vec<DependencyRow> = (0..n)
        .map(|i| {
            let mut id = [0u8; 32];
            id[0..8].copy_from_slice(&(i as u64).to_le_bytes());
            dep_row(id, 1)
        })
        .collect();
    SegmentWriter::new()
        .write_base(&dir, &[], &base_deps, &dicts, 1)
        .expect("write_base 50k deps");

    // One hot key, closed+reopened on every one of 32 consecutive deltas
    // (the plan's own compaction trigger bound -- `deltas > 32` -- so this
    // is the documented worst case for how large one key's closures `Vec`
    // can grow between compactions).
    let hot_key = [0xFFu8; 32];
    let mut generation = 2u32;
    SegmentWriter::new()
        .write_delta(
            &dir,
            &[],
            &[],
            &[dep_row(hot_key, generation)],
            &[],
            &Default::default(),
            u64::from(generation),
        )
        .expect("open hot key");
    for _ in 0..32 {
        let close_gen = generation + 1;
        let reopen_gen = generation + 2;
        SegmentWriter::new()
            .write_delta(
                &dir,
                &[],
                &[],
                &[],
                &[(hot_key, close_gen)],
                &Default::default(),
                u64::from(close_gen),
            )
            .expect("close hot key");
        SegmentWriter::new()
            .write_delta(
                &dir,
                &[],
                &[],
                &[dep_row(hot_key, reopen_gen)],
                &[],
                &Default::default(),
                u64::from(reopen_gen),
            )
            .expect("reopen hot key");
        generation = reopen_gen;
    }

    let reader = StoreReader::open(&dir).expect("open");
    let g = u64::from(generation);

    let started = std::time::Instant::now();
    for _ in 0..50 {
        assert_eq!(reader.deps_visible_count(g), n as u64 + 1);
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_secs() < 5,
        "50 deps_visible_count calls over {} rows (one key reused 32x) took {:?} -- likely quadratic",
        n + 1,
        elapsed
    );
}

/// Review item 3 (pending sites + residual confirmation): the store-level
/// mechanics that make "residual confirms a pending site, a later
/// unrelated delta touches the SAME owner, the confirmed site does not
/// reappear" correct. Simulates the residual's confirmation as exactly
/// what `residual.rs` does structurally -- a closure for that key with NO
/// corresponding reopen -- then simulates `delta.rs`'s wholesale-replace
/// for a later, unrelated edit to the SAME owner: it closes every
/// PREVIOUSLY VISIBLE pending site of that owner (which, after the
/// confirmation, no longer includes the confirmed one -- `pending_sites_
/// by_owner(owner, prev_generation)` filters through `is_visible`) and
/// opens a fresh set that (correctly, per the materializer never
/// re-proposing an already-resolved site) does not include it either.
#[test]
fn a_confirmed_pending_site_does_not_reappear_when_a_later_delta_touches_the_same_owner() {
    let dir = tmp_dir("pending-confirm-then-touch");
    let dicts = build_dictionaries(4, 4);
    let confirmed_key = PendingSiteKey {
        owner_artifact: OWNER,
        start: 100,
        end: 110,
        site_kind: urdira_structural_store::PENDING_SITE_KIND_CALL,
    };
    let stays_pending_key = PendingSiteKey {
        owner_artifact: OWNER,
        start: 200,
        end: 210,
        site_kind: urdira_structural_store::PENDING_SITE_KIND_CALL,
    };

    // g1: owner O has two pending sites.
    SegmentWriter::new()
        .write_base_with_pending(
            &dir,
            &[],
            &[],
            &dicts,
            1,
            &[pending_row(100, 1), pending_row(200, 1)],
        )
        .expect("write_base_with_pending g1");

    // g2: the residual confirms the FIRST site (closes it, no reopen --
    // exactly `materialize.rs::plan_relation_repair`'s "drops it, emits a
    // record instead" shape). The second site is untouched.
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[],
            &Default::default(),
            2,
            &[],
            &[(confirmed_key, 2)],
        )
        .expect("write_delta g2 (residual confirms site 1)");

    // Sanity: at g2, site 1 is gone, site 2 is still pending.
    let reader = StoreReader::open(&dir).expect("open after g2");
    assert!(reader.pending_site(&confirmed_key, 2).is_none());
    assert!(reader.pending_site(&stays_pending_key, 2).is_some());

    // g3: an UNRELATED edit touches owner O -- `delta.rs`'s wholesale
    // replace: close every one of O's PREVIOUSLY VISIBLE pending sites
    // (`pending_sites_by_owner(OWNER, 2)`, which by construction no
    // longer includes the confirmed site) and open the freshly
    // materialized set (site 2 again, still unresolved -- NOT site 1,
    // since a real materializer would not re-propose an already-resolved
    // site).
    let previously_visible = reader.pending_sites_by_owner(OWNER, 2);
    assert_eq!(
        previously_visible.len(),
        1,
        "only the still-pending site should be 'previously visible' after confirmation"
    );
    let closures: Vec<(PendingSiteKey, u32)> =
        previously_visible.iter().map(|v| (v.key(), 3)).collect();
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[],
            &Default::default(),
            3,
            &[pending_row(200, 3)],
            &closures,
        )
        .expect("write_delta g3 (unrelated edit touches owner O)");

    let reader = StoreReader::open(&dir).expect("open after g3");
    reader.verify_all().expect("verify_all");
    assert!(
        reader.pending_site(&confirmed_key, 3).is_none(),
        "a confirmed pending site must not reappear when a later delta touches the same owner"
    );
    assert!(
        reader.pending_site(&stays_pending_key, 3).is_some(),
        "the still-unresolved site must still be visible after being wholesale-replaced"
    );
    assert_eq!(reader.pending_sites_visible_count(3), 1);
}
