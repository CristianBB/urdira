//! Diffs a batch of [`crate::walker::Observation`]s against a
//! [`crate::frontier::Frontier`], applying the same equivalence rule as
//! `isEquivalentObservation` (`packages/engine/src/source-indexer.ts:342`):
//! content hash AND metadata digest both equal the frontier's current entry
//! means nothing changed, so no new `artifact_versions` row is opened.

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
    /// current state: a different content/metadata digest than the live
    /// `Frontier::present` entry, or a uri that was tombstoned
    /// (recreated/reincluded — its prior tombstone must be closed).
    pub changed: Vec<Observation>,
    /// Uris previously present (per `Frontier::present`) that this batch no
    /// longer observes.
    pub deleted: Vec<String>,
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
        Some(entry)
            if entry.content_hash == observation.content_hash
                && entry.metadata_digest == observation.metadata_digest =>
        {
            delta.equivalent_count += 1;
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
}
