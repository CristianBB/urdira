//! `pending.sites` / `closures.pending`: base round-trip, delta open/close
//! semantics (per-owner and cross-owner), compaction, backward
//! compatibility with the pre-existing `write_base`/`write_delta` code
//! path, corruption detection, and the writer's sort/dedup invariants.

mod common;

use common::*;
use std::collections::HashSet;
use urdira_structural_store::container::{self, SectionId};
use urdira_structural_store::{Dictionaries, PendingSiteRow, SegmentWriter, StoreReader};

fn sorted_keys(rows: &[PendingSiteRow]) -> Vec<(u32, u32, u32, u8)> {
    let mut v: Vec<(u32, u32, u32, u8)> = rows
        .iter()
        .map(|r| (r.owner_artifact, r.start, r.end, r.site_kind))
        .collect();
    v.sort();
    v
}

/// (1) Base round-trip: a few hundred rows across several owners, reopened
/// and read back byte-identical via `iter_visible_pending_sites`,
/// `pending_sites_by_owner`, and `pending_site`.
#[test]
fn base_round_trip() {
    let dir = tmp_dir("pending-base-roundtrip");
    let n_owners = 12u32;
    let dicts = build_dictionaries(n_owners, 30);
    let rows = {
        let mut r = gen_rows(200, 40, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let pending = gen_pending_sites(360, 41, n_owners, 1, 0);

    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &pending)
        .expect("write_base_with_pending");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");

    // iter_visible_pending_sites: same set of rows, (owner,start,end,kind)
    // order, every field intact.
    let got = reader.iter_visible_pending_sites(1);
    assert_eq!(got.len(), pending.len());
    let got_keys: Vec<(u32, u32, u32, u8)> = got
        .iter()
        .map(|v| (v.owner_artifact(), v.start(), v.end(), v.site_kind()))
        .collect();
    assert!(
        got_keys.windows(2).all(|w| w[0] < w[1]),
        "iter_visible_pending_sites must be strictly ascending by (owner,start,end,kind)"
    );
    assert_eq!(got_keys, sorted_keys(&pending));

    let by_key: std::collections::HashMap<(u32, u32, u32, u8), &PendingSiteRow> = pending
        .iter()
        .map(|r| ((r.owner_artifact, r.start, r.end, r.site_kind), r))
        .collect();
    for v in &got {
        let want = by_key[&(v.owner_artifact(), v.start(), v.end(), v.site_kind())];
        assert_eq!(v.owner_version(), want.owner_version);
        assert_eq!(v.valid_from(), want.valid_from);
        assert_eq!(v.valid_to_raw(), want.valid_to);
        assert_eq!(v.start_line(), want.start_line);
        assert_eq!(v.end_line(), want.end_line);
        assert_eq!(v.reason(), want.reason);
        assert_eq!(v.source_subject(), want.source_subject);
        assert_eq!(v.to_row(), *want);
    }

    // pending_sites_by_owner, cross-checked per owner.
    for owner in 0..n_owners {
        let want = sorted_keys(
            &pending
                .iter()
                .filter(|r| r.owner_artifact == owner)
                .cloned()
                .collect::<Vec<_>>(),
        );
        let got: Vec<(u32, u32, u32, u8)> = reader
            .pending_sites_by_owner(owner, 1)
            .iter()
            .map(|v| (v.owner_artifact(), v.start(), v.end(), v.site_kind()))
            .collect();
        assert_eq!(got, want, "pending_sites_by_owner owner={owner}");
    }

    // pending_site: exact-key lookup for every row.
    for row in &pending {
        let view = reader
            .pending_site(&row.key(), 1)
            .unwrap_or_else(|| panic!("pending_site must find {:?}", row.key()));
        assert_eq!(view.to_row(), *row);
    }

    assert_eq!(reader.pending_sites_visible_count(1), pending.len() as u64);
}

/// (2) + (3): a delta opens new rows for owner X and closes ALL of X's old
/// rows (per-key closures); a single site belonging to a DIFFERENT owner Y
/// is closed in the SAME delta. After the delta: `pending_sites_by_owner(X,
/// new_gen)` shows only the new rows, `(X, old_gen)` still shows the old
/// ones; Y's closed site behaves the same way; every other owner untouched.
#[test]
fn delta_reopens_owner_and_closes_a_different_owners_site() {
    let dir = tmp_dir("pending-delta");
    let n_owners = 8u32;
    let dicts = build_dictionaries(n_owners, 20);
    let rows = {
        let mut r = gen_rows(80, 50, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    // Owner X = 0, Owner Y = 1 -- pinned explicitly so the test doesn't
    // depend on the RNG's owner assignment.
    let owner_x = 0u32;
    let owner_y = 1u32;
    let mut base_pending = gen_pending_sites(40, 51, n_owners, 1, 0);
    // Force at least one row for X and one for Y so the test is never
    // vacuous regardless of the RNG.
    base_pending[0].owner_artifact = owner_x;
    base_pending[1].owner_artifact = owner_x;
    base_pending[2].owner_artifact = owner_y;

    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &base_pending)
        .expect("write_base_with_pending");

    let old_x_rows: Vec<PendingSiteRow> = base_pending
        .iter()
        .filter(|r| r.owner_artifact == owner_x)
        .cloned()
        .collect();
    assert!(!old_x_rows.is_empty());
    let y_row = base_pending
        .iter()
        .find(|r| r.owner_artifact == owner_y)
        .cloned()
        .unwrap();

    // New rows for X, opened at generation 2.
    let mut new_x_rows = gen_pending_sites(6, 52, 1, 2, 100_000);
    for r in &mut new_x_rows {
        r.owner_artifact = owner_x;
    }

    let pending_closures: Vec<_> = old_x_rows
        .iter()
        .map(|r| (r.key(), 2u32))
        .chain(std::iter::once((y_row.key(), 2u32)))
        .collect();

    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[],
            &Dictionaries::default(),
            2,
            &new_x_rows,
            &pending_closures,
        )
        .expect("write_delta_with_pending");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");

    // X at old generation: only the old rows.
    let x_at_1 = sorted_keys(
        &reader
            .pending_sites_by_owner(owner_x, 1)
            .iter()
            .map(|v| v.to_row())
            .collect::<Vec<_>>(),
    );
    assert_eq!(x_at_1, sorted_keys(&old_x_rows));

    // X at new generation: only the new rows.
    let x_at_2 = sorted_keys(
        &reader
            .pending_sites_by_owner(owner_x, 2)
            .iter()
            .map(|v| v.to_row())
            .collect::<Vec<_>>(),
    );
    assert_eq!(x_at_2, sorted_keys(&new_x_rows));

    // Y's closed site: visible one generation before its close, gone at
    // (and after) the generation it closed -- closed from a DIFFERENT
    // owner's delta batch than the one that opened X's new rows.
    assert!(reader.pending_site(&y_row.key(), 1).is_some());
    assert!(reader.pending_site(&y_row.key(), 2).is_none());
    let y_at_1: HashSet<_> = reader
        .pending_sites_by_owner(owner_y, 1)
        .iter()
        .map(|v| v.key())
        .collect();
    assert!(y_at_1.contains(&y_row.key()));
    let y_at_2: HashSet<_> = reader
        .pending_sites_by_owner(owner_y, 2)
        .iter()
        .map(|v| v.key())
        .collect();
    assert!(!y_at_2.contains(&y_row.key()));

    // Every other owner's base rows are untouched at generation 2.
    for owner in 0..n_owners {
        if owner == owner_x || owner == owner_y {
            continue;
        }
        let want = sorted_keys(
            &base_pending
                .iter()
                .filter(|r| r.owner_artifact == owner)
                .cloned()
                .collect::<Vec<_>>(),
        );
        let got = sorted_keys(
            &reader
                .pending_sites_by_owner(owner, 2)
                .iter()
                .map(|v| v.to_row())
                .collect::<Vec<_>>(),
        );
        assert_eq!(got, want, "owner={owner} must be untouched by the delta");
    }
}

/// (4) Compaction preserves exactly the visible set and drops closed rows.
#[test]
fn compaction_preserves_visible_pending_sites_and_drops_closed() {
    let dir = tmp_dir("pending-compaction");
    let n_owners = 6u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(60, 60, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_pending = gen_pending_sites(30, 61, n_owners, 1, 0);

    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &base_pending)
        .expect("write_base_with_pending");

    // Delta 2: close half of the base rows, open some new ones.
    let (closed, kept): (Vec<_>, Vec<_>) = base_pending
        .iter()
        .cloned()
        .enumerate()
        .partition(|(i, _)| i % 2 == 0);
    let closed: Vec<PendingSiteRow> = closed.into_iter().map(|(_, r)| r).collect();
    let kept: Vec<PendingSiteRow> = kept.into_iter().map(|(_, r)| r).collect();
    let pending_closures: Vec<_> = closed.iter().map(|r| (r.key(), 2u32)).collect();
    let new_rows = gen_pending_sites(10, 62, n_owners, 2, 200_000);

    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[],
            &Dictionaries::default(),
            2,
            &new_rows,
            &pending_closures,
        )
        .expect("write_delta_with_pending");

    let reader_before = StoreReader::open(&dir).expect("open before compact");
    let mut expected_visible: Vec<PendingSiteRow> = kept.clone();
    expected_visible.extend(new_rows.clone());
    let before = sorted_keys(&expected_visible);
    let got_before = sorted_keys(
        &reader_before
            .iter_visible_pending_sites(2)
            .iter()
            .map(|v| v.to_row())
            .collect::<Vec<_>>(),
    );
    assert_eq!(got_before, before, "sanity check before compaction");

    let summary = urdira_structural_store::compact(&dir, 2).expect("compact");
    assert_eq!(summary.generation, 2);

    let reader_after = StoreReader::open(&dir).expect("open after compact");
    reader_after.verify_all().expect("verify_all after compact");
    let got_after = sorted_keys(
        &reader_after
            .iter_visible_pending_sites(2)
            .iter()
            .map(|v| v.to_row())
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        got_after, before,
        "compaction must preserve exactly the visible set"
    );
    assert_eq!(
        reader_after.pending_sites_visible_count(2),
        expected_visible.len() as u64
    );

    // Closed rows must be gone entirely -- not just invisible, but not
    // present in the fresh base at all.
    for row in &closed {
        assert!(reader_after.pending_site(&row.key(), 2).is_none());
    }
}

/// (5) A store written by the OLD code path (`write_base`/`write_delta`,
/// unchanged signatures) opens, has zero pending sites, and passes
/// `verify_all`.
#[test]
fn old_code_path_has_zero_pending_sites_and_verifies_clean() {
    let dir = tmp_dir("pending-old-code-path");
    let n_owners = 5u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(50, 70, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    SegmentWriter::new()
        .write_base(&dir, &rows, &[], &dicts, 1)
        .expect("write_base (old signature)");

    let new_rows = gen_rows(10, 71, &dicts, 2);
    SegmentWriter::new()
        .write_delta(&dir, &new_rows, &[], &[], &[], &Dictionaries::default(), 2)
        .expect("write_delta (old signature)");

    let reader = StoreReader::open(&dir).expect("open");
    reader
        .verify_all()
        .expect("verify_all on an old-code-path store");
    assert!(reader.iter_visible_pending_sites(2).is_empty());
    assert_eq!(reader.pending_sites_visible_count(2), 0);
    assert!(reader.pending_sites_by_owner(0, 2).is_empty());
}

/// (6a) `verify_all` detects a corrupted byte inside `pending.sites`
/// (a base-segment plain file).
#[test]
fn verify_all_detects_corrupted_pending_sites_file() {
    let dir = tmp_dir("pending-corrupt-sites");
    let n_owners = 4u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(30, 80, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let pending = gen_pending_sites(20, 81, n_owners, 1, 0);
    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &pending)
        .expect("write_base_with_pending");

    let reader = StoreReader::open(&dir).expect("open before corruption");
    reader
        .verify_all()
        .expect("freshly written store must verify clean");
    // Windows refuses writes to a file with an active memory mapping. Drop
    // the reader before mutating the fixture, then reopen it below.
    drop(reader);

    let manifest = urdira_structural_store::Manifest::read(&dir.join("MANIFEST")).unwrap();
    let path = dir.join(&manifest.base).join("pending.sites");
    let mut bytes = std::fs::read(&path).unwrap();
    let flip_at = bytes.len() - 1;
    bytes[flip_at] ^= 0xFF;
    std::fs::write(&path, &bytes).unwrap();

    let reader = StoreReader::open(&dir)
        .expect("open must still succeed (sample doesn't cover pending.sites)");
    let result = reader.verify_all();
    assert!(
        result.is_err(),
        "verify_all must detect the corrupted pending.sites file"
    );
}

/// (6b) `verify_all` detects a corrupted byte inside `closures.pending`
/// (a section within a delta's single container file).
#[test]
fn verify_all_detects_corrupted_closures_pending_section() {
    let dir = tmp_dir("pending-corrupt-closures");
    let n_owners = 4u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(30, 90, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };
    let base_pending = gen_pending_sites(10, 91, n_owners, 1, 0);
    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &base_pending)
        .expect("write_base_with_pending");

    let pending_closures: Vec<_> = base_pending.iter().map(|r| (r.key(), 2u32)).collect();
    SegmentWriter::new()
        .write_delta_with_pending(
            &dir,
            &[],
            &[],
            &[],
            &[],
            &Dictionaries::default(),
            2,
            &[],
            &pending_closures,
        )
        .expect("write_delta_with_pending");

    let reader = StoreReader::open(&dir).expect("open before corruption");
    reader
        .verify_all()
        .expect("freshly written store must verify clean");
    // Windows refuses writes to a file with an active memory mapping. Drop
    // the reader before mutating the container, then reopen it below.
    drop(reader);

    let manifest = urdira_structural_store::Manifest::read(&dir.join("MANIFEST")).unwrap();
    let delta_path = dir.join(&manifest.deltas[0]);
    let (_, _, ranges) = container::open_container(&delta_path).expect("open_container");
    let (start, end) = *ranges
        .get(&SectionId::ClosuresPending)
        .expect("closures.pending section must exist");
    assert!(
        end > start + 64,
        "section must have a non-empty body past its own 64-byte header"
    );

    let mut bytes = std::fs::read(&delta_path).unwrap();
    bytes[end - 1] ^= 0xFF; // flip the LAST byte of the section's body
    std::fs::write(&delta_path, &bytes).unwrap();

    let reader = StoreReader::open(&dir)
        .expect("open must still succeed (corruption is in the body, not the TOC)");
    let result = reader.verify_all();
    assert!(
        result.is_err(),
        "verify_all must detect the corrupted closures.pending section"
    );
}

/// (7) Duplicate keys in one segment are rejected -- both at base write
/// time and at delta write time.
#[test]
fn duplicate_keys_in_one_segment_are_rejected() {
    let dir = tmp_dir("pending-duplicate-keys");
    let n_owners = 4u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(20, 100, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };

    let mut dup = gen_pending_sites(5, 101, n_owners, 1, 0);
    // Force rows 0 and 1 to share an identical key (owner/start/end/kind)
    // but differ in a field the key ignores (reason), so this is a genuine
    // duplicate-KEY case, not an accidental full-row duplicate.
    dup[1].owner_artifact = dup[0].owner_artifact;
    dup[1].start = dup[0].start;
    dup[1].end = dup[0].end;
    dup[1].site_kind = dup[0].site_kind;
    dup[1].reason = dup[0].reason.wrapping_add(1);

    let base_result =
        SegmentWriter::new().write_base_with_pending(&dir, &rows, &[], &dicts, 1, &dup);
    assert!(
        base_result.is_err(),
        "write_base_with_pending must reject a duplicate pending site key"
    );

    // A clean base (no duplicates) so the delta path has something to
    // write against.
    let clean = gen_pending_sites(5, 102, n_owners, 1, 0);
    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &clean)
        .expect("clean base must succeed");

    let mut dup_delta = gen_pending_sites(4, 103, n_owners, 2, 100_000);
    dup_delta[1].owner_artifact = dup_delta[0].owner_artifact;
    dup_delta[1].start = dup_delta[0].start;
    dup_delta[1].end = dup_delta[0].end;
    dup_delta[1].site_kind = dup_delta[0].site_kind;
    dup_delta[1].reason = dup_delta[0].reason.wrapping_add(1);

    let delta_result = SegmentWriter::new().write_delta_with_pending(
        &dir,
        &[],
        &[],
        &[],
        &[],
        &Dictionaries::default(),
        2,
        &dup_delta,
        &[],
    );
    assert!(
        delta_result.is_err(),
        "write_delta_with_pending must reject a duplicate pending site key"
    );
}

/// (8) Sorting is enforced regardless of input order: rows handed to the
/// writer in reverse (and shuffled) order must still read back correctly
/// -- proven indirectly through `pending_sites_by_owner`'s binary-search
/// range lookup, which only returns correct results if the on-disk array
/// is genuinely sorted by `(owner_artifact, start, end, site_kind)`.
#[test]
fn writer_sorts_regardless_of_input_order() {
    let dir = tmp_dir("pending-sort-enforced");
    let n_owners = 10u32;
    let dicts = build_dictionaries(n_owners, 10);
    let rows = {
        let mut r = gen_rows(40, 110, &dicts, 1);
        r.sort_by_key(|row| row.record_id);
        r
    };

    let mut pending = gen_pending_sites(200, 111, n_owners, 1, 0);
    // Reverse, then apply a deterministic riffle shuffle so input order is
    // neither ascending nor descending by any of the key fields.
    pending.reverse();
    {
        let mut rng = Rng::new(999_777);
        for i in (1..pending.len()).rev() {
            let j = rng.below((i + 1) as u32) as usize;
            pending.swap(i, j);
        }
    }
    assert!(!pending.is_empty(), "sanity: pending is non-empty");

    SegmentWriter::new()
        .write_base_with_pending(&dir, &rows, &[], &dicts, 1, &pending)
        .expect("write_base_with_pending with shuffled input");

    let reader = StoreReader::open(&dir).expect("open");
    reader.verify_all().expect("verify_all");

    let got_all = sorted_keys(
        &reader
            .iter_visible_pending_sites(1)
            .iter()
            .map(|v| v.to_row())
            .collect::<Vec<_>>(),
    );
    assert_eq!(got_all, sorted_keys(&pending));

    for owner in 0..n_owners {
        let want = sorted_keys(
            &pending
                .iter()
                .filter(|r| r.owner_artifact == owner)
                .cloned()
                .collect::<Vec<_>>(),
        );
        let got = sorted_keys(
            &reader
                .pending_sites_by_owner(owner, 1)
                .iter()
                .map(|v| v.to_row())
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            got, want,
            "pending_sites_by_owner owner={owner} (binary search requires on-disk sort)"
        );
    }
}
