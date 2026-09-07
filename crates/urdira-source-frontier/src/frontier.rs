//! In-memory source frontier: the current (`valid_to_generation IS NULL`)
//! catalog state, loaded once from SQLite and then kept live by
//! [`crate::catalog::Catalog::apply`] without ever re-scanning the table —
//! see plan §4.1/§6.2 step 1. Also owns the two `BucketedMerkleSet` trees
//! backing the v4 `source_state_digest` (plan §8.2's frame applied here per
//! the task's own recipe — see the evidence doc's "source_state_digest v4"
//! section for the exact byte layout and the "tombstone token" choice
//! documented there).

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use urdira_indexing_core::CoreError;
use urdira_indexing_core::merkle_bucket::{BucketedMerkleSet, Change};

pub type Digest32 = [u8; 32];

fn sha256_bytes(value: &str) -> Digest32 {
    Sha256::digest(value.as_bytes()).into()
}

/// Decodes a `sha256:<64 hex>` string into its raw 32 bytes. Any other
/// shape (wrong length, non-hex, missing prefix) is a catalog invariant
/// violation, not a recoverable input — this crate itself is the only
/// producer of every `content_hash`/`artifact_tombstone_id` this ever reads
/// back from SQLite.
pub fn decode_sha256_hex(value: &str) -> Result<Digest32, CoreError> {
    let hex = value
        .strip_prefix("sha256:")
        .filter(|rest| rest.len() == 64 && rest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| CoreError(format!("not a canonical sha256:<64 hex> digest: {value}")))?;
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .map_err(|error| CoreError(format!("invalid hex digest {value}: {error}")))?;
    }
    Ok(out)
}

pub fn encode_sha256_hex(bytes: &Digest32) -> String {
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Top 5 hex nibbles (20 bits) of a key, selecting its
/// `BucketedMerkleSet` bucket. Duplicated from `merkle_bucket.rs`'s private
/// `bucket_index` (that crate exposes the bucket count/depth as
/// [`urdira_indexing_core::merkle_bucket::BUCKET_PREFIX_NIBBLES`] but not
/// the indexing function itself) — this crate cannot modify
/// `urdira-indexing-core` to make it `pub`, so the three-line formula is
/// kept in sync here instead.
fn bucket_index(key: &Digest32) -> u32 {
    debug_assert_eq!(
        urdira_indexing_core::merkle_bucket::BUCKET_PREFIX_NIBBLES,
        5
    );
    (u32::from(key[0]) << 12) | (u32::from(key[1]) << 4) | (u32::from(key[2]) >> 4)
}

/// A file currently present in the workspace (plan §4.1's `FrontierEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontierEntry {
    pub artifact_id: String,
    pub artifact_version_id: String,
    pub content_hash: String,
    pub byte_length: u64,
    pub metadata_digest: String,
    pub artifact_ordinal: u32,
}

/// A file currently tombstoned (deleted/excluded) in the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TombstoneEntry {
    pub artifact_id: String,
    pub artifact_tombstone_id: String,
}

/// Domain string for the v4 source-state digest (task recipe): distinct
/// from `urdira:source-state:v3`'s `MerkleRadixSet`-based digest in
/// `packages/engine/src/source-indexer.ts` — v4 uses the bucketed tree
/// (§8.2) with a source-state-specific framing instead.
const SOURCE_STATE_DOMAIN: &[u8] = b"urdira:source-state:v4\0";

fn compute_source_state_digest(present: &BucketedMerkleSet, absent: &BucketedMerkleSet) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SOURCE_STATE_DOMAIN);
    hasher.update(present.len().to_le_bytes());
    hasher.update(present.root());
    hasher.update(absent.len().to_le_bytes());
    hasher.update(absent.root());
    encode_sha256_hex(&hasher.finalize().into())
}

type BucketIndexMap = HashMap<u32, Vec<(Digest32, Digest32)>>;

fn apply_bucket_change(
    tree: &mut BucketedMerkleSet,
    index_map: &mut BucketIndexMap,
    change: Change,
) -> Result<(), CoreError> {
    let key = match change {
        Change::Set { key, .. } => key,
        Change::Delete { key } => key,
    };
    let bucket = bucket_index(&key);
    let entries = index_map.entry(bucket).or_default();
    let pre_change_count = entries.len() as u32;
    entries.retain(|(existing_key, _)| existing_key != &key);
    if let Change::Set { logical, .. } = change {
        entries.push((key, logical));
    }
    let snapshot = entries.clone();
    // Frente E-P0c: `index_map` is rebuilt from the SAME `Frontier::load`
    // call that built `tree` (never round-tripped through `BucketedMerkleSet
    // ::write_to`/`read_from`), so `pre_change_count` here is always exact
    // -- but `BucketedMerkleSet::update` no longer trusts its own internal
    // bookkeeping for this regardless (see its own doc comment).
    tree.update(&[change], |_| (pre_change_count, snapshot.clone()))
}

fn build_bucket_index(entries: &[(Digest32, Digest32)]) -> BucketIndexMap {
    let mut map: BucketIndexMap = HashMap::new();
    for &(key, logical) in entries {
        map.entry(bucket_index(&key))
            .or_default()
            .push((key, logical));
    }
    map
}

/// The live in-memory source frontier for one workspace.
pub struct Frontier {
    pub present: HashMap<String, FrontierEntry>,
    pub absent: HashMap<String, TombstoneEntry>,
    present_tree: BucketedMerkleSet,
    absent_tree: BucketedMerkleSet,
    present_bucket_index: BucketIndexMap,
    absent_bucket_index: BucketIndexMap,
    next_ordinal: u32,
}

impl Frontier {
    /// `Frontier::load`: one query for live `artifact_versions` joined with
    /// `source_artifacts`, one for live `artifact_tombstones`, then a
    /// single parallel `BucketedMerkleSet::from_sorted` pass per tree (see
    /// the evidence doc for the measured wall time on a 14k-row catalog).
    pub fn load(conn: &Connection, workspace_id: &str) -> Result<Self, CoreError> {
        let mut present: HashMap<String, FrontierEntry> = HashMap::new();
        let mut next_ordinal: u32 = 0;
        {
            let mut statement = conn
                .prepare(
                    "SELECT sa.normalized_uri, sa.artifact_id, av.artifact_version_id, av.content_hash, av.byte_length, av.analysis_metadata_digest \
                     FROM artifact_versions av \
                     JOIN source_artifacts sa ON sa.workspace_id = av.workspace_id AND sa.artifact_id = av.artifact_id \
                     WHERE av.workspace_id = ?1 AND av.valid_to_generation IS NULL",
                )
                .map_err(sql_error)?;
            let rows = statement
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .map_err(sql_error)?;
            for row in rows {
                let (
                    normalized_uri,
                    artifact_id,
                    artifact_version_id,
                    content_hash,
                    byte_length,
                    metadata_digest,
                ) = row.map_err(sql_error)?;
                let ordinal = next_ordinal;
                next_ordinal += 1;
                present.insert(
                    normalized_uri,
                    FrontierEntry {
                        artifact_id,
                        artifact_version_id,
                        content_hash,
                        byte_length: byte_length.max(0) as u64,
                        metadata_digest,
                        artifact_ordinal: ordinal,
                    },
                );
            }
        }

        let mut absent: HashMap<String, TombstoneEntry> = HashMap::new();
        {
            let mut statement = conn
                .prepare(
                    "SELECT sa.normalized_uri, sa.artifact_id, t.artifact_tombstone_id \
                     FROM artifact_tombstones t \
                     JOIN source_artifacts sa ON sa.workspace_id = t.workspace_id AND sa.artifact_id = t.artifact_id \
                     WHERE t.workspace_id = ?1 AND t.valid_to_generation IS NULL",
                )
                .map_err(sql_error)?;
            let rows = statement
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(sql_error)?;
            for row in rows {
                let (normalized_uri, artifact_id, artifact_tombstone_id) =
                    row.map_err(sql_error)?;
                absent.insert(
                    normalized_uri,
                    TombstoneEntry {
                        artifact_id,
                        artifact_tombstone_id,
                    },
                );
            }
        }

        let present_entries: Vec<(Digest32, Digest32)> = present
            .iter()
            .map(|(uri, entry)| -> Result<(Digest32, Digest32), CoreError> {
                Ok((sha256_bytes(uri), decode_sha256_hex(&entry.content_hash)?))
            })
            .collect::<Result<_, _>>()?;
        let absent_entries: Vec<(Digest32, Digest32)> = absent
            .iter()
            .map(|(uri, tombstone)| {
                (
                    sha256_bytes(uri),
                    sha256_bytes(&tombstone.artifact_tombstone_id),
                )
            })
            .collect();

        let present_bucket_index = build_bucket_index(&present_entries);
        let absent_bucket_index = build_bucket_index(&absent_entries);
        let present_tree = BucketedMerkleSet::from_sorted(&present_entries)?;
        let absent_tree = BucketedMerkleSet::from_sorted(&absent_entries)?;

        Ok(Self {
            present,
            absent,
            present_tree,
            absent_tree,
            present_bucket_index,
            absent_bucket_index,
            next_ordinal,
        })
    }

    pub fn empty() -> Self {
        Self {
            present: HashMap::new(),
            absent: HashMap::new(),
            present_tree: BucketedMerkleSet::empty(),
            absent_tree: BucketedMerkleSet::empty(),
            present_bucket_index: HashMap::new(),
            absent_bucket_index: HashMap::new(),
            next_ordinal: 0,
        }
    }

    pub fn next_ordinal(&mut self) -> u32 {
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        ordinal
    }

    /// `source_state_digest` (task recipe): `sha256("urdira:source-state:v4\0"
    /// || u64le(present_count) || present_root || u64le(absent_count) ||
    /// absent_root)`.
    pub fn source_state_digest(&self) -> String {
        compute_source_state_digest(&self.present_tree, &self.absent_tree)
    }

    /// Rebuilds both trees from scratch from `self.present`/`self.absent`
    /// and returns the digest that produces — used by tests (and available
    /// to a future `lifecycle.verify`) to prove the incrementally
    /// maintained digest never drifts from a from-scratch recomputation.
    pub fn from_scratch_digest(&self) -> Result<String, CoreError> {
        let present_entries: Vec<(Digest32, Digest32)> = self
            .present
            .iter()
            .map(|(uri, entry)| -> Result<(Digest32, Digest32), CoreError> {
                Ok((sha256_bytes(uri), decode_sha256_hex(&entry.content_hash)?))
            })
            .collect::<Result<_, _>>()?;
        let absent_entries: Vec<(Digest32, Digest32)> = self
            .absent
            .iter()
            .map(|(uri, tombstone)| {
                (
                    sha256_bytes(uri),
                    sha256_bytes(&tombstone.artifact_tombstone_id),
                )
            })
            .collect();
        let present_tree = BucketedMerkleSet::from_sorted(&present_entries)?;
        let absent_tree = BucketedMerkleSet::from_sorted(&absent_entries)?;
        Ok(compute_source_state_digest(&present_tree, &absent_tree))
    }

    /// Records `uri` as present with `entry`, closing any prior tombstone
    /// for the same uri. Updates both bucketed trees incrementally (one
    /// bucket touched per tree, plus 5 ancestor digests each).
    pub fn set_present(&mut self, uri: &str, entry: FrontierEntry) -> Result<(), CoreError> {
        let key = sha256_bytes(uri);
        let logical = decode_sha256_hex(&entry.content_hash)?;
        self.present.insert(uri.to_string(), entry);
        apply_bucket_change(
            &mut self.present_tree,
            &mut self.present_bucket_index,
            Change::Set { key, logical },
        )?;
        if self.absent.remove(uri).is_some() {
            apply_bucket_change(
                &mut self.absent_tree,
                &mut self.absent_bucket_index,
                Change::Delete { key },
            )?;
        }
        Ok(())
    }

    /// Records `uri` as absent (tombstoned), closing any prior present
    /// entry for the same uri.
    pub fn set_absent(&mut self, uri: &str, tombstone: TombstoneEntry) -> Result<(), CoreError> {
        let key = sha256_bytes(uri);
        let logical = sha256_bytes(&tombstone.artifact_tombstone_id);
        self.absent.insert(uri.to_string(), tombstone);
        apply_bucket_change(
            &mut self.absent_tree,
            &mut self.absent_bucket_index,
            Change::Set { key, logical },
        )?;
        if self.present.remove(uri).is_some() {
            apply_bucket_change(
                &mut self.present_tree,
                &mut self.present_bucket_index,
                Change::Delete { key },
            )?;
        }
        Ok(())
    }
}

fn sql_error(error: rusqlite::Error) -> CoreError {
    CoreError(format!("source frontier SQL error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_encode_sha256_hex_round_trips() {
        let hash = "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        let bytes = decode_sha256_hex(hash).unwrap();
        assert_eq!(encode_sha256_hex(&bytes), hash);
    }

    #[test]
    fn empty_frontier_digest_is_deterministic_and_matches_from_scratch() {
        let frontier = Frontier::empty();
        let digest = frontier.source_state_digest();
        assert_eq!(digest, frontier.from_scratch_digest().unwrap());
        assert!(digest.starts_with("sha256:"));
    }

    #[test]
    fn set_present_then_absent_updates_digest_and_matches_from_scratch() {
        let mut frontier = Frontier::empty();
        let empty_digest = frontier.source_state_digest();
        frontier
            .set_present(
                "src/a.ts",
                FrontierEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_version_id: "artifact-version:a".to_string(),
                    content_hash:
                        "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3"
                            .to_string(),
                    byte_length: 20,
                    metadata_digest:
                        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_string(),
                    artifact_ordinal: 0,
                },
            )
            .unwrap();
        let present_digest = frontier.source_state_digest();
        assert_ne!(present_digest, empty_digest);
        assert_eq!(present_digest, frontier.from_scratch_digest().unwrap());

        frontier
            .set_absent(
                "src/a.ts",
                TombstoneEntry {
                    artifact_id: "artifact:a".to_string(),
                    artifact_tombstone_id: "artifact-tombstone:a".to_string(),
                },
            )
            .unwrap();
        assert!(!frontier.present.contains_key("src/a.ts"));
        assert!(frontier.absent.contains_key("src/a.ts"));
        let absent_digest = frontier.source_state_digest();
        assert_ne!(absent_digest, present_digest);
        assert_eq!(absent_digest, frontier.from_scratch_digest().unwrap());
    }
}
