//! Diffs a batch of [`crate::walker::Observation`]s against a
//! [`crate::frontier::Frontier`].
//!
//! **Frente E-fix (plan `generic-waddling-hartmanis.md` §0/§2, 2026-09-06):
//! content-hash equivalence, not `isEquivalentObservation`'s stricter rule.**
//! The TS oracle this crate was originally ported from
//! (`isEquivalentObservation`, `packages/engine/src/source-indexer.ts:342`)
//! requires BOTH `content_hash` AND `metadata_digest` to match the
//! frontier's current entry for a uri to count as unchanged. That rule
//! makes every stat-only mutation that never touches a byte of content — a
//! bare `touch`, a `git stash`/checkout round trip that rewrites mtimes, or
//! copying/importing an already-indexed tree onto a fresh filesystem (an
//! index-pack import: same bytes, new inode/ctime) — look exactly like a
//! full-corpus edit: `Delta::compute` used to put every such uri in
//! `changed`, and a reconcile of an otherwise byte-identical tree came back
//! `mode: "cold"` with `changed == frontier_size`, re-analyzing content that
//! never changed. Deliberately diverging from the TS oracle here (this
//! crate's `walker.rs` module doc already documents one such deliberate
//! simplification versus the TS provider): this crate's own equivalence
//! rule is now content-addressed — `content_hash` (and `byte_length`,
//! `set_present`'s own invariant) equal to the frontier's current entry
//! means nothing changed, full stop, regardless of `metadata_digest`. A
//! `metadata_digest`-only difference is still recorded (in
//! `Delta::metadata_refreshed`) so [`crate::catalog::Catalog`] can keep the
//! stored digest current — the next diff against the SAME on-disk state
//! then costs nothing extra — without opening a new `artifact_versions` row
//! or otherwise treating the uri as a real content change. This is the
//! SAME guarantee `isEquivalentObservation`'s stricter rule protected
//! (content-addressed identity), just without the metadata-driven false
//! positives.
use crate::frontier::Frontier;
use crate::walker::{Observation, PathObservation};
use std::collections::HashSet;

/// Result of diffing an observation batch against the frontier. `added` and
/// `changed` are kept as separate buckets (rather than one flat "upsert"
/// list) because [`crate::catalog::Catalog::apply`] needs to know whether a
/// prior tombstone must be closed (a `changed` uri may have come from
/// `Frontier::absent`, not just a different `Frontier::present` entry).
#[derive(Debug, Default)]
pub struct Delta {
    /// Uris with no prior artifact at all (never present, never tombstoned).
    pub added: Vec<Observation>,
    /// Uris with a materially different observation than the frontier's
    /// current state: a different CONTENT hash than the live
    /// `Frontier::present` entry, or a uri that was tombstoned
    /// (recreated/reincluded — its prior tombstone must be closed). A
    /// `metadata_digest`-only difference is never enough to land a uri here
    /// (see the module doc's Frente E-fix note) — that goes to
    /// `metadata_refreshed` instead.
    pub changed: Vec<Observation>,
    /// Uris previously present (per `Frontier::present`) that this batch no
    /// longer observes.
    pub deleted: Vec<String>,
    /// Frente E-fix: uris whose `content_hash`/`byte_length` are UNCHANGED
    /// from the frontier's current entry (so they are counted in
    /// `equivalent_count`, never in `changed`) but whose `metadata_digest`
    /// differs — `(normalized_uri, new_metadata_digest)`. `Catalog::apply`
    /// (the `changed`/`Full` path) and `Catalog::refresh_metadata` (the
    /// reconcile no-op path, which never calls `apply` at all) both use
    /// this to keep `artifact_versions.analysis_metadata_digest` current
    /// without opening a new version or touching `valid_from_generation`.
    pub metadata_refreshed: Vec<(String, String)>,
    pub equivalent_count: u64,
}

impl Delta {
    /// Full-scan case: `observations` is a complete, authoritative
    /// enumeration (deletion authority), so any `Frontier::present` uri NOT
    /// in it is deleted.
    pub fn compute(frontier: &Frontier, observations: &[Observation]) -> Delta {
        let mut delta = Delta::default();
        let mut observed_uris: HashSet<&str> = HashSet::with_capacity(observations.len());
        for observation in observations {
            observed_uris.insert(observation.normalized_uri.as_str());
            classify(frontier, observation, &mut delta);
        }
        delta.deleted = frontier
            .present
            .keys()
            .filter(|uri| !observed_uris.contains(uri.as_str()))
            .cloned()
            .collect();
        delta
    }

    /// Incremental case (plan §6.2/§6.4): `results` covers only the paths
    /// the caller already knows changed (watcher events / a create /
    /// rename pair), so deletion is scoped to exactly the `Absent` entries
    /// this batch reports, never a full frontier diff.
    pub fn compute_partial(frontier: &Frontier, results: &[PathObservation]) -> Delta {
        let mut delta = Delta::default();
        for result in results {
            match result {
                PathObservation::Present(observation) => {
                    classify(frontier, observation, &mut delta)
                }
                PathObservation::Absent { normalized_uri } => {
                    if frontier.present.contains_key(normalized_uri) {
                        delta.deleted.push(normalized_uri.clone());
                    }
                    // Already absent (or never observed at all): nothing to do.
                }
            }
        }
        delta
    }
}

fn classify(frontier: &Frontier, observation: &Observation, delta: &mut Delta) {
    match frontier.present.get(&observation.normalized_uri) {
        // Frente E-fix: content-addressed equivalence — a uri whose
        // content_hash/byte_length exactly match the frontier's current
        // entry is unchanged, regardless of metadata_digest (see the
        // module doc). A metadata_digest difference on an otherwise
        // equivalent observation is recorded in `metadata_refreshed`
        // rather than promoting the uri to `changed`.
        Some(entry)
            if entry.content_hash == observation.content_hash
                && entry.byte_length == observation.byte_length =>
        {
            delta.equivalent_count += 1;
            if entry.metadata_digest != observation.metadata_digest {
                delta.metadata_refreshed.push((
                    observation.normalized_uri.clone(),
                    observation.metadata_digest.clone(),
                ));
            }
        }
        Some(_) => delta.changed.push(observation.clone()),
        None => {
            if frontier.absent.contains_key(&observation.normalized_uri) {
                delta.changed.push(observation.clone());
            } else {
                delta.added.push(observation.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontier::{FrontierEntry, TombstoneEntry};

    /// A stand-in `sha256:<64 hex>` digest, deterministic per `label` — the
    /// frontier's `content_hash` must decode as canonical sha256 hex (see
    /// `Frontier::set_present`), so tests use this instead of short
    /// human-readable placeholders like `"sha256:old"`.
    fn fake_hash(label: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut out = String::from("sha256:");
        for byte in Sha256::digest(label.as_bytes()) {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "{byte:02x}");
        }
        out
    }

    fn observation(uri: &str, content_hash_label: &str, metadata_digest: &str) -> Observation {
        Observation {
            normalized_uri: uri.to_string(),
            content_hash: fake_hash(content_hash_label),
            byte_length: 10,
            metadata: crate::walker::StatMetadata {
                byte_length: 10,
                ctime_ms: 0.0,
                device: 0,
                inode: 0,
                mode: 0,
                mtime_ms: 0.0,
            },
            metadata_digest: metadata_digest.to_string(),
            version_token:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            encoding: "utf-8",
            language_hint: Some("text"),
        }
    }

    #[test]
    fn cold_apply_is_all_added() {
        let frontier = Frontier::empty();
        let observations = vec![
            observation("a.ts", "sha256:aa", "sha256:meta-a"),
            observation("b.ts", "sha256:bb", "sha256:meta-b"),
        ];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.added.len(), 2);
        assert_eq!(delta.changed.len(), 0);
        assert_eq!(delta.deleted.len(), 0);
        assert_eq!(delta.equivalent_count, 0);
    }

    #[test]
    fn unchanged_observation_is_equivalent() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("a"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-a".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        let observations = vec![observation("a.ts", "a", "sha256:meta-a")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.equivalent_count, 1);
        assert!(delta.added.is_empty());
        assert!(delta.changed.is_empty());
    }

    #[test]
    fn changed_content_and_missing_file_are_classified() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("old"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-old".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        frontier
            .set_present(
                "b.ts",
                FrontierEntry {
                    artifact_id: "artifact:b".to_string(),
                    artifact_version_id: "artifact-version:b".to_string(),
                    content_hash: fake_hash("b"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-b".to_string(),
                    artifact_ordinal: 1,
                },
            )
            .unwrap();
        // Full observation set omits b.ts (deleted) and changes a.ts.
        let observations = vec![observation("a.ts", "sha256:new", "sha256:meta-new")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.changed.len(), 1);
        assert_eq!(delta.changed[0].normalized_uri, "a.ts");
        assert_eq!(delta.deleted, vec!["b.ts".to_string()]);
    }

    #[test]
    fn reincluded_tombstoned_uri_is_changed_not_added() {
        let mut frontier = Frontier::empty();
        frontier
            .set_absent(
                "a.ts",
                TombstoneEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_tombstone_id: "artifact-tombstone:a".to_string(),
                },
            )
            .unwrap();
        let observations = vec![observation("a.ts", "sha256:new", "sha256:meta-new")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.changed.len(), 1);
        assert!(delta.added.is_empty());
    }

    #[test]
    fn partial_scope_only_deletes_explicit_absent_entries() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("old"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-old".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        frontier
            .set_present(
                "b.ts",
                FrontierEntry {
                    artifact_id: "artifact:b".to_string(),
                    artifact_version_id: "artifact-version:b".to_string(),
                    content_hash: fake_hash("b"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-b".to_string(),
                    artifact_ordinal: 1,
                },
            )
            .unwrap();
        // b.ts is untouched by this incremental batch and must NOT be
        // treated as deleted, unlike the full-scan case above.
        let results = vec![PathObservation::Absent {
            normalized_uri: "a.ts".to_string(),
        }];
        let delta = Delta::compute_partial(&frontier, &results);
        assert_eq!(delta.deleted, vec!["a.ts".to_string()]);
    }

    // -----------------------------------------------------------------
    // Frente E-fix (plan `generic-waddling-hartmanis.md` §0/§2, 2026-09-06):
    // content-hash equivalence, metadata-only refresh.
    // -----------------------------------------------------------------

    #[test]
    fn metadata_only_difference_is_equivalent_with_refresh_full_scan() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("a"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-old".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        // Same content, different metadata_digest -- a `touch`, a
        // `git stash`/checkout mtime rewrite, or an index-pack import onto
        // a fresh filesystem all look like this: identical bytes, a
        // different inode/ctime/mtime.
        let observations = vec![observation("a.ts", "a", "sha256:meta-new")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(
            delta.equivalent_count, 1,
            "a content-identical uri must count as equivalent regardless of metadata_digest"
        );
        assert!(
            delta.changed.is_empty(),
            "a metadata-only difference must never land in `changed`"
        );
        assert!(delta.added.is_empty());
        assert_eq!(
            delta.metadata_refreshed,
            vec![("a.ts".to_string(), "sha256:meta-new".to_string())]
        );
    }

    #[test]
    fn identical_metadata_and_content_yields_no_refresh() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("a"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-a".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        let observations = vec![observation("a.ts", "a", "sha256:meta-a")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(delta.equivalent_count, 1);
        assert!(
            delta.metadata_refreshed.is_empty(),
            "no metadata_refreshed entry when nothing actually differs"
        );
    }

    /// Integrity guard: two observations of the SAME byte_length but
    /// DIFFERENT content must still be classified as `changed` -- the
    /// content-hash equivalence rule must never fall back to `byte_length`
    /// alone as a cheaper proxy for content equality.
    #[test]
    fn same_byte_length_different_content_stays_changed() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("aaaaaaaaaa"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-a".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        // `observation()` always reports byte_length 10 regardless of the
        // content label -- same length, different content_hash, same
        // metadata_digest (so a metadata false-positive cannot explain the
        // classification either).
        let observations = vec![observation("a.ts", "bbbbbbbbbb", "sha256:meta-a")];
        let delta = Delta::compute(&frontier, &observations);
        assert_eq!(
            delta.changed.len(),
            1,
            "same-length, different-content must still be `changed` -- integrity over byte_length shortcuts"
        );
        assert_eq!(delta.equivalent_count, 0);
        assert!(delta.metadata_refreshed.is_empty());
    }

    #[test]
    fn compute_partial_also_refreshes_metadata_for_a_present_observation() {
        let mut frontier = Frontier::empty();
        frontier
            .set_present(
                "a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash: fake_hash("a"),
                    byte_length: 10,
                    metadata_digest: "sha256:meta-old".to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        // The editor "changed" pipeline reports a-ts as Modified after a
        // save that rewrote the exact same bytes (metadata changes on
        // every `write`, content does not) -- `compute_partial` must apply
        // the SAME equivalence rule `compute` does, not a stricter one.
        let results = vec![PathObservation::Present(observation(
            "a.ts",
            "a",
            "sha256:meta-new",
        ))];
        let delta = Delta::compute_partial(&frontier, &results);
        assert_eq!(delta.equivalent_count, 1);
        assert!(
            delta.changed.is_empty(),
            "a no-content-change save must not open a new artifact_version"
        );
        assert_eq!(
            delta.metadata_refreshed,
            vec![("a.ts".to_string(), "sha256:meta-new".to_string())]
        );
    }
}
