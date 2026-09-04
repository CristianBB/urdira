//! P3-1 deliverable 3e/6.3: per-owner diff between an owner's PREVIOUS
//! visible rows (read from the live `StoreReader`) and its freshly
//! regenerated `RecordRow`s, following plan §6.3 exactly:
//!
//! ```text
//! for p in next:
//!   if prev has a live row with same record_digest and identity_key -> unchanged (keep)
//!   elif prev has a live row with same identity_key (different digest) -> replacement:
//!       record_id = H(record_digest || prev.record_id); close prev; previous_record_id = prev.record_id
//!   else: last = by_identity.lookup(identity_key_digest) (last row anywhere, live or closed)
//!       if last live in another owner -> owner migration: close last, chain off last.record_id
//!       if last closed -> reopen: chain off last.record_id (absence barrier)
//!       if none -> first occurrence: record_id = sha256(record_digest) (kernel's own cold recipe, untouched)
//! rows in prev not matched -> close (valid_to = generation)
//! ```
//!
//! `H` (the chaining hash) is NEW v4-only ground -- `structural_kernel_rows`
//! (the native kernel `materialize.rs` calls) has no predecessor/chaining
//! parameter at all (P2-2b's evidence doc, §3.1: "decision 11's cold case is
//! this function's ONLY behavior"), so there is no existing byte recipe to
//! reproduce for the replacement/migration/reopen cases -- v3's own chaining
//! lives in TypeScript SQL/JS this task does not read from (`DIRECT_
//! PUBLICATION_CLOSURES_SQL` only computes the CLOSURE SET, not a chained
//! id). This module mints `chained_record_id = sha256("urdira:v4-record-
//! chain:v1\0" || record_digest || predecessor_record_id)`, the same
//! domain-prefixed-sha256 convention every other new v4-only recipe in this
//! pipeline already uses (`dependency_id`, the merkle bucket framings) --
//! documented here as the v4 recipe for decision 11's non-cold cases, not a
//! v3 mirror.

use sha2::{Digest, Sha256};
use urdira_structural_store::reader::RecordView;
use urdira_structural_store::row::{CATEGORY_RELATION, RecordRow};
use urdira_structural_store::{StoreReader, merkle};

/// `H(record_digest, predecessor_record_id)` -- see this module's doc
/// comment for why this is new v4-only ground.
pub fn chained_record_id(record_digest: &[u8; 32], predecessor_record_id: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"urdira:v4-record-chain:v1\0");
    hasher.update(record_digest);
    hasher.update(predecessor_record_id);
    hasher.finalize().into()
}

/// Result of diffing one owner's previous rows against its freshly
/// regenerated rows.
#[derive(Default)]
pub struct OwnerDiff {
    /// Rows that must be OPENED at `generation` (new identity, replacement,
    /// owner migration, or reopen -- never a plain "unchanged" row, which
    /// is never re-written at all: it is already open in an earlier
    /// segment and stays that way).
    pub opened: Vec<RecordRow>,
    /// `(record_id, valid_to)` pairs for every row this diff closes
    /// (matched-but-superseded rows, plus every unmatched `prev` row).
    pub record_closures: Vec<([u8; 32], u32)>,
    /// The subset of `record_closures`' keys whose closed row was
    /// `CATEGORY_RELATION` -- `delta.rs` needs this to maintain the
    /// `graph` merkle tree (relation-only), which `urdira-structural-
    /// store::SegmentWriter::write_delta` does not track itself (plan §4.2
    /// of the P2-2b evidence doc: "no separate edge table... `graph`/
    /// `metric` computed by this task's own code").
    pub closed_relation_keys: Vec<[u8; 32]>,
    /// `materialize_incremental`'s kernel-cold `record_id` (always
    /// `sha256(record_digest)`, since the kernel has no chaining
    /// parameter -- see this module's doc comment) for every `next` row,
    /// mapped to that row's FINAL record_id after this diff (identical for
    /// "first occurrence"; the real, already-published id for "unchanged"
    /// -- which this diff drops from `opened` entirely; the chained id for
    /// replacement/migration/reopen). `delta.rs` needs this across EVERY
    /// owner's diff, merged, to patch `dicts.subjects`: a relation row's
    /// `source_subject`/`target_subject` was resolved during `materialize_
    /// incremental`'s in-batch pass using the kernel-cold id of whatever it
    /// pointed at (materialize has no visibility into this diff, which runs
    /// afterward, per owner) -- any subject dictionary entry appended THIS
    /// generation that still names a kernel-cold id must be rewritten to
    /// the row's real final id, or a relation would point at an id no
    /// record actually carries.
    pub kernel_to_final: std::collections::HashMap<[u8; 32], [u8; 32]>,
}

/// Diffs one owner's rows (plan §6.3). `prev` MUST be exactly that owner's
/// currently-visible rows (`StoreReader::by_owner(owner_ordinal,
/// prev_generation)`); `next` is this generation's freshly regenerated,
/// kernel-canonicalized rows for the SAME owner (kernel-cold identity: every
/// `next` row's `record_id` already equals `sha256(record_digest)` and
/// `previous_record_id` is zero -- this function only OVERRIDES those two
/// fields for the replacement/migration/reopen cases, never for "unchanged"
/// or "first occurrence").
pub fn diff_owner(
    prev: Vec<RecordView>,
    mut next: Vec<RecordRow>,
    store: &StoreReader,
    generation: u32,
) -> OwnerDiff {
    let mut result = OwnerDiff::default();
    // `prev` keyed by identity_key_digest for O(1) lookup; an owner's rows
    // are all distinct identities in practice (one live row per identity
    // per owner at any generation), so a `Vec` per key is defensive, not
    // the expected case.
    let mut prev_by_identity: std::collections::HashMap<[u8; 32], Vec<&RecordView>> =
        std::collections::HashMap::new();
    for view in &prev {
        prev_by_identity
            .entry(view.identity_key_digest())
            .or_default()
            .push(view);
    }
    let mut matched: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();

    for row in &mut next {
        let identity_key_digest = row.identity_key_digest;
        let kernel_record_id = row.record_id;
        let candidates = prev_by_identity.get(&identity_key_digest);
        let same_identity_prev = candidates.and_then(|views| views.first().copied());

        if let Some(prev_view) = same_identity_prev {
            if prev_view.record_digest() == row.record_digest {
                // Unchanged: keep the prior row exactly as-is. Do not open
                // a new row at all -- but any OTHER row in this generation
                // that resolved a subject against this row's kernel-cold
                // id must be repointed at the row's REAL (already
                // published, possibly chained from an earlier generation)
                // id.
                let real_id = prev_view.record_id();
                matched.insert(real_id);
                result.kernel_to_final.insert(kernel_record_id, real_id);
                continue;
            }
            // Replacement: same identity, different content.
            let predecessor = prev_view.record_id();
            row.record_id = chained_record_id(&row.record_digest, &predecessor);
            row.previous_record_id = predecessor;
            row.valid_from = generation;
            matched.insert(predecessor);
            result.record_closures.push((predecessor, generation));
            if prev_view.category() == CATEGORY_RELATION {
                result.closed_relation_keys.push(predecessor);
            }
            result
                .kernel_to_final
                .insert(kernel_record_id, row.record_id);
            result.opened.push(row.clone());
            continue;
        }

        // No live row under this identity in THIS owner: consult the
        // store-wide identity chain (any owner, live or closed).
        match store.by_identity_last(&identity_key_digest) {
            Some(last) if last.is_visible(generation.saturating_sub(1) as u64) => {
                // Owner migration: the identity is currently live under a
                // DIFFERENT owner. Close it there and chain off it.
                let predecessor = last.record_id();
                row.record_id = chained_record_id(&row.record_digest, &predecessor);
                row.previous_record_id = predecessor;
                row.valid_from = generation;
                result.record_closures.push((predecessor, generation));
                if last.category() == CATEGORY_RELATION {
                    result.closed_relation_keys.push(predecessor);
                }
                result
                    .kernel_to_final
                    .insert(kernel_record_id, row.record_id);
                result.opened.push(row.clone());
            }
            Some(last) => {
                // Reopen: the identity existed before but is currently
                // closed everywhere (absence barrier).
                let predecessor = last.record_id();
                row.record_id = chained_record_id(&row.record_digest, &predecessor);
                row.previous_record_id = predecessor;
                row.valid_from = generation;
                result
                    .kernel_to_final
                    .insert(kernel_record_id, row.record_id);
                result.opened.push(row.clone());
            }
            None => {
                // First occurrence: keep the kernel's own cold recipe
                // (record_id = sha256(record_digest), previous_record_id
                // stays zero) unchanged.
                row.valid_from = generation;
                result.opened.push(row.clone());
            }
        }
    }

    // Every `prev` row not matched above is no longer produced by this
    // owner's regenerated facts: close it.
    for view in &prev {
        let record_id = view.record_id();
        if !matched.contains(&record_id) {
            result.record_closures.push((record_id, generation));
            if view.category() == CATEGORY_RELATION {
                result.closed_relation_keys.push(record_id);
            }
        }
    }

    result
}

/// Builds the `graph` merkle set's `Change`s for one delta (plan §4.2 of
/// the P2-2b evidence doc: `urdira-structural-store` only tracks
/// `records`/`dependency`, so this task's own `delta.rs` maintains `graph`
/// the same way `publish.rs` maintains it for a cold scan, incrementally).
pub fn graph_changes(
    opened: &[RecordRow],
    closed_relation_keys: &[[u8; 32]],
) -> Vec<urdira_indexing_core::merkle_bucket::Change> {
    use urdira_indexing_core::merkle_bucket::Change;
    let mut changes: Vec<Change> = opened
        .iter()
        .filter(|row| row.category == CATEGORY_RELATION)
        .map(|row| Change::Set {
            key: row.record_id,
            logical: row.record_digest,
        })
        .collect();
    changes.extend(
        closed_relation_keys
            .iter()
            .map(|key| Change::Delete { key: *key }),
    );
    changes
}

/// Groups `changes` by `merkle::bucket_index_of(key)` in one O(N) pass.
/// `delta.rs` calls this ONCE for `graph_changes` and passes each bucket's
/// own tiny slice to [`graph_bucket_entries`] below -- see that function's
/// doc comment for why passing the FULL list on every call (this
/// function's own earlier version) was a real, `sample`-confirmed O(N^2)
/// bug at n8n hub-edit scale (`urdira-structural-store::writer::
/// group_changes_by_bucket` is the sibling fix for the SAME bug pattern in
/// the `records`/`dependency` trees' own `apply_changes_in_bucket` calls).
pub fn group_changes_by_bucket(
    changes: &[urdira_indexing_core::merkle_bucket::Change],
) -> std::collections::HashMap<u32, Vec<urdira_indexing_core::merkle_bucket::Change>> {
    let mut grouped: std::collections::HashMap<
        u32,
        Vec<urdira_indexing_core::merkle_bucket::Change>,
    > = std::collections::HashMap::new();
    for change in changes {
        let key = match change {
            urdira_indexing_core::merkle_bucket::Change::Set { key, .. } => key,
            urdira_indexing_core::merkle_bucket::Change::Delete { key } => key,
        };
        grouped
            .entry(merkle::bucket_index_of(key))
            .or_default()
            .push(*change);
    }
    grouped
}

/// `bucket_entries` callback for the `graph` tree's `merkle::load_and_
/// update` (relation-category rows only, unlike `records.tree`'s callback
/// which covers every category -- see `merkle::bucket_index_of` for the
/// shared bucketing scheme both trees use). Buckets are tiny in practice
/// (plan §8.2: ~3 leaves/bucket at 3.2M keys; this task's incremental
/// buckets are touched only by the handful of relation rows this
/// generation actually opens/closes), so the extra `get_visible` lookup per
/// candidate is cheap.
///
/// **`changes` must already be pre-filtered to this bucket** (via
/// [`group_changes_by_bucket`]) -- a real O(N^2) bug, found live via
/// `sample` against n8n's `migration-types.ts` hub edit (2,196 owners,
/// 356,905 records: this callback used to receive the FULL `graph_changes`
/// list on every one of up to ~356,905 distinct-bucket calls, the exact
/// same bug pattern this task ALSO found and fixed in `urdira-structural-
/// store::writer::write_delta`'s own two `apply_changes_in_bucket` calls,
/// but reintroduced here independently since this function is this
/// crate's own duplicate of that pattern). This function's own per-entry
/// bucket-index check below is now a cheap, redundant safety net over an
/// already-tiny slice, not the hot path.
///
/// **Must return POST-change contents**, not the pre-delta snapshot:
/// `BucketedMerkleSet::update`'s own contract (`urdira-structural-store`'s
/// `writer::write_delta` applies this same pattern for `records`/
/// `dependency` via its private `apply_changes_in_bucket`, which this is a
/// by-necessity duplicate of -- that helper is not `pub`, and duplicating
/// ~15 lines was cheaper than widening that crate's API surface for one
/// caller). Missing this update-application step was a real bug found live
/// by `tests_e2e.rs`'s incremental edit test: the graph root diverged from
/// a from-scratch rebuild over the SAME final key set until fixed.
pub fn graph_bucket_entries(
    store: &StoreReader,
    bucket_idx: u32,
    prev_generation: u64,
    changes: &[urdira_indexing_core::merkle_bucket::Change],
) -> Vec<(merkle::Digest32, merkle::Digest32)> {
    let mut entries: Vec<(merkle::Digest32, merkle::Digest32)> = store
        .visible_entries_in_bucket(bucket_idx, prev_generation)
        .into_iter()
        .filter(|(key, _)| {
            store
                .get_visible(key, prev_generation)
                .is_some_and(|view| view.category() == CATEGORY_RELATION)
        })
        .collect();
    for change in changes {
        match change {
            urdira_indexing_core::merkle_bucket::Change::Set { key, logical }
                if merkle::bucket_index_of(key) == bucket_idx =>
            {
                entries.retain(|(k, _)| k != key);
                entries.push((*key, *logical));
            }
            urdira_indexing_core::merkle_bucket::Change::Delete { key }
                if merkle::bucket_index_of(key) == bucket_idx =>
            {
                entries.retain(|(k, _)| k != key);
            }
            _ => {}
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use urdira_structural_store::row::{CATEGORY_ENTITY, Dictionaries, NONE_U16, NONE_U32, ZERO32};
    use urdira_structural_store::writer::SegmentWriter;

    fn digest(label: &str) -> [u8; 32] {
        Sha256::digest(label.as_bytes()).into()
    }

    /// The same UCE text digest recipe `RecordRow.identity_key_digest`
    /// uses (`urdira-native-core`'s private `uce_text_digest_bytes`,
    /// reproduced independently -- see `delta.rs`'s identical copy for the
    /// full rationale). Test-only duplicate: real callers compute this via
    /// the kernel, this module's tests need to construct rows by hand.
    fn identity_digest(value: &str) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update([3u8]);
        let mut len = value.len();
        loop {
            let mut byte = (len % 128) as u8;
            len /= 128;
            if len > 0 {
                byte |= 0x80;
            }
            hasher.update([byte]);
            if len == 0 {
                break;
            }
        }
        hasher.update(value.as_bytes());
        hasher.finalize().into()
    }

    #[allow(clippy::too_many_arguments)]
    fn row(
        record_id: [u8; 32],
        owner: u32,
        identity_key: &str,
        record_digest: [u8; 32],
        valid_from: u32,
        valid_to: u32,
        previous_record_id: [u8; 32],
    ) -> RecordRow {
        RecordRow {
            record_id,
            owner_artifact: owner,
            owner_version: owner,
            valid_from,
            valid_to,
            category: CATEGORY_ENTITY,
            kind_id: 0,
            universal_kind_id: 0,
            facets: 0,
            span_artifact_version: owner,
            span_start_byte: 0,
            span_end_byte: 0,
            // A4 (line numbers task): this synthetic test row carries no
            // real span, so "no line known" (`NONE_U32`) is the correct
            // sentinel here -- matches what a real producer emits for a
            // record whose `ProposedRecord::span_start_line`/`span_end_line`
            // are `0` (see `materialize.rs`'s own doc comment).
            span_start_line: NONE_U32,
            span_end_line: NONE_U32,
            identity_type: 0,
            assignment_kind: 0,
            name_id: NONE_U32,
            identity_key: identity_key.as_bytes().to_vec(),
            record_digest,
            body_digest: record_digest,
            identity_id: identity_digest(identity_key),
            identity_key_digest: identity_digest(identity_key),
            previous_record_id,
            source_subject: None,
            target_subject: None,
            relation_kind_id: NONE_U16,
            body: Vec::new(),
        }
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("v4-diff-test")
            .join(format!(
                "{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Plan §6.3's "unchanged" case: same identity_key, same record_digest
    /// -> no row is opened at all, and the PRIOR row's exact id survives.
    #[test]
    fn unchanged_row_is_kept_and_not_reopened() {
        let dir = scratch("unchanged");
        let digest_a = digest("a");
        let id1 = digest("id1-first-occurrence-stand-in");
        let base_row = row(id1, 0, "sym", digest_a, 1, 0, ZERO32);
        SegmentWriter::new()
            .write_base(&dir, &[base_row], &[], &Dictionaries::default(), 1)
            .expect("write_base succeeds");
        let reader = StoreReader::open(&dir).expect("reader opens");

        let prev = reader.by_owner(0, 1);
        assert_eq!(prev.len(), 1);
        // "next" regenerated by the kernel would recompute a fresh
        // kernel-cold id for identical content -- diff_owner must ignore
        // that and keep the store's real, already-published id.
        let kernel_fresh_id = digest("kernel-would-recompute-this");
        let next = vec![row(kernel_fresh_id, 0, "sym", digest_a, 0, 0, ZERO32)];
        let result = diff_owner(prev, next, &reader, 2);
        assert!(
            result.opened.is_empty(),
            "an unchanged row must never be re-opened"
        );
        assert!(result.record_closures.is_empty());
        assert_eq!(result.kernel_to_final.get(&kernel_fresh_id), Some(&id1));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Plan §6.3's "replacement" case, chained through THREE generations
    /// (A -> B -> A again) -- decision 11's own stated guarantee: "an
    /// A-to-B-to-A lifecycle cannot reopen a closed row under the same
    /// record_id."
    #[test]
    fn revert_a_to_b_to_a_never_reopens_the_original_id() {
        let dir = scratch("revert");
        let digest_a = digest("content-a");
        let digest_b = digest("content-b");
        let id1 = digest("id1-first-occurrence-stand-in");

        // Generation 1: first occurrence.
        let gen1_row = row(id1, 0, "sym", digest_a, 1, 0, ZERO32);
        SegmentWriter::new()
            .write_base(&dir, &[gen1_row], &[], &Dictionaries::default(), 1)
            .expect("write_base succeeds");
        let reader1 = StoreReader::open(&dir).expect("reader opens");

        // Generation 2: content edited to B -> replacement, chained off id1.
        let prev2 = reader1.by_owner(0, 1);
        let kernel_b = digest("kernel-would-recompute-b");
        let next2 = vec![row(kernel_b, 0, "sym", digest_b, 0, 0, ZERO32)];
        let diff2 = diff_owner(prev2, next2, &reader1, 2);
        assert_eq!(diff2.opened.len(), 1);
        let id2 = diff2.opened[0].record_id;
        assert_eq!(id2, chained_record_id(&digest_b, &id1));
        assert_eq!(diff2.opened[0].previous_record_id, id1);
        assert_eq!(diff2.record_closures, vec![(id1, 2)]);
        SegmentWriter::new()
            .write_delta(
                &dir,
                &diff2.opened,
                &diff2.record_closures,
                &[],
                &[],
                &Dictionaries::default(),
                2,
            )
            .expect("write_delta succeeds");

        // Generation 3: content reverted back to A -> replacement AGAIN,
        // chained off id2 (NOT a reopen of id1 -- decision 11's guarantee).
        let reader2 = StoreReader::open(&dir).expect("reader reopens");
        let prev3 = reader2.by_owner(0, 2);
        assert_eq!(prev3.len(), 1);
        assert_eq!(prev3[0].record_id(), id2);
        let kernel_a_again = digest("kernel-would-recompute-a-again");
        let next3 = vec![row(kernel_a_again, 0, "sym", digest_a, 0, 0, ZERO32)];
        let diff3 = diff_owner(prev3, next3, &reader2, 3);
        assert_eq!(diff3.opened.len(), 1);
        let id3 = diff3.opened[0].record_id;
        assert_eq!(id3, chained_record_id(&digest_a, &id2));
        assert_ne!(
            id3, id1,
            "decision 11: an A-to-B-to-A lifecycle must NOT reopen the original id"
        );
        assert_eq!(diff3.record_closures, vec![(id2, 3)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Plan §6.3's "owner migration" case: the identity is currently LIVE
    /// under a DIFFERENT owner -> close it there, chain the new owner's
    /// row off it.
    #[test]
    fn owner_migration_closes_the_old_owner_and_chains_off_it() {
        let dir = scratch("migration");
        let digest_a = digest("shared-content");
        let id1 = digest("id1-owner-a");
        // Generation 1: identity "sym" lives under owner 0.
        let gen1_row = row(id1, 0, "sym", digest_a, 1, 0, ZERO32);
        SegmentWriter::new()
            .write_base(&dir, &[gen1_row], &[], &Dictionaries::default(), 1)
            .expect("write_base succeeds");
        let reader = StoreReader::open(&dir).expect("reader opens");

        // Generation 2: owner 1 regenerates a row under the SAME identity
        // (e.g. a symbol moved between files) -- owner 1's own `prev` is
        // empty (it never had this identity), but the identity is live
        // under owner 0.
        let prev_owner1 = reader.by_owner(1, 1);
        assert!(prev_owner1.is_empty());
        let kernel_fresh = digest("kernel-would-recompute-migrated");
        let next = vec![row(kernel_fresh, 1, "sym", digest_a, 0, 0, ZERO32)];
        let diff = diff_owner(prev_owner1, next, &reader, 2);
        assert_eq!(diff.opened.len(), 1);
        assert_eq!(diff.opened[0].record_id, chained_record_id(&digest_a, &id1));
        assert_eq!(diff.opened[0].owner_artifact, 1);
        assert_eq!(diff.record_closures, vec![(id1, 2)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Plan §6.3's "reopen" case: the identity existed before but is
    /// CLOSED everywhere -- chains off the last closed id (absence
    /// barrier), and does not re-close anything (it is already closed).
    #[test]
    fn reopen_chains_off_the_absence_barrier_without_reclosing() {
        let dir = scratch("reopen");
        let digest_a = digest("content-a");
        let digest_removed = digest("content-removed-marker");
        let id1 = digest("id1-before-removal");

        // Generation 1: identity "sym" exists under owner 0.
        let gen1_row = row(id1, 0, "sym", digest_a, 1, 0, ZERO32);
        SegmentWriter::new()
            .write_base(&dir, &[gen1_row], &[], &Dictionaries::default(), 1)
            .expect("write_base succeeds");
        let reader1 = StoreReader::open(&dir).expect("reader opens");

        // Generation 2: owner 0's regenerated facts no longer include
        // "sym" at all (e.g. the symbol was deleted) -- diffed against an
        // EMPTY `next` for owner 0, so "sym"'s row closes as an unmatched
        // `prev` entry.
        let prev2 = reader1.by_owner(0, 1);
        let diff2 = diff_owner(prev2, Vec::new(), &reader1, 2);
        assert!(diff2.opened.is_empty());
        assert_eq!(diff2.record_closures, vec![(id1, 2)]);
        SegmentWriter::new()
            .write_delta(
                &dir,
                &diff2.opened,
                &diff2.record_closures,
                &[],
                &[],
                &Dictionaries::default(),
                2,
            )
            .expect("write_delta succeeds");
        let _ = digest_removed;

        // Generation 3: "sym" reappears (e.g. the deletion was undone) --
        // owner 0's `prev` at generation 2 is empty (the row is closed),
        // so this is NOT a same-owner match; `by_identity_last` finds the
        // CLOSED id1 -- reopen, chained off it, no closure recorded (it is
        // already closed).
        let reader2 = StoreReader::open(&dir).expect("reader reopens");
        let prev3 = reader2.by_owner(0, 2);
        assert!(prev3.is_empty());
        let kernel_fresh = digest("kernel-would-recompute-reopened");
        let next3 = vec![row(kernel_fresh, 0, "sym", digest_a, 0, 0, ZERO32)];
        let diff3 = diff_owner(prev3, next3, &reader2, 3);
        assert_eq!(diff3.opened.len(), 1);
        assert_eq!(
            diff3.opened[0].record_id,
            chained_record_id(&digest_a, &id1)
        );
        assert!(
            diff3.record_closures.is_empty(),
            "reopening an already-closed row must not close anything again"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
