//! Test-only synthetic data generator and a naive in-memory reference
//! model, shared by every integration test in this crate.

#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use urdira_structural_store::{
    CATEGORY_ENTITY, CATEGORY_RELATION, DependencyRow, Dictionaries, NONE_U16, NONE_U32,
    PENDING_SITE_KIND_CALL, PENDING_SITE_KIND_IMPLEMENTS, PENDING_SITE_KIND_INHERITS,
    PendingSiteRow, RecordRow,
};

/// Deterministic xorshift64* PRNG -- no external `rand` dependency needed
/// for reproducible fixtures (a `rand`-backed variant is used for the
/// concurrency test's timing jitter only).
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() & 0xFFFF_FFFF) as u32
    }
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 { 0 } else { self.next_u32() % n }
    }
    pub fn next_bytes32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        out
    }
}

pub fn digest_of(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn tmp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "urdira-structural-store-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn build_dictionaries(n_owners: u32, n_subjects: u32) -> Dictionaries {
    Dictionaries {
        kinds: (0..8).map(|i| format!("kind:{i}")).collect(),
        universal_kinds: (0..6).map(|i| format!("core:{i}")).collect(),
        relation_kinds: (0..5).map(|i| format!("rel:{i}")).collect(),
        names: (0..2000).map(|i| format!("name:{i}")).collect(),
        subjects: {
            let mut rng = Rng::new(0x5BEC_1EC7 ^ u64::from(n_subjects));
            (0..n_subjects).map(|_| rng.next_bytes32()).collect()
        },
        artifacts: (0..n_owners)
            .map(|i| (format!("artifact:{i}"), format!("version:{i}")))
            .collect(),
        facet_names: Vec::new(),
        subject_text: Vec::new(),
        artifact_paths: Vec::new(),
        entity_kinds: Vec::new(),
    }
}

/// `n` synthetic rows, all opened at `generation` with `valid_to = 0`.
pub fn gen_rows(n: usize, seed: u64, dicts: &Dictionaries, generation: u32) -> Vec<RecordRow> {
    let mut rng = Rng::new(seed);
    let n_owners = dicts.artifacts.len() as u32;
    let n_names = dicts.names.len() as u32;
    let n_subjects = dicts.subjects.len() as u32;
    let n_kinds = dicts.kinds.len() as u32;
    let n_ukinds = dicts.universal_kinds.len() as u32;
    let n_rkinds = dicts.relation_kinds.len() as u32;

    (0..n)
        .map(|i| {
            let is_relation = n_subjects > 0 && rng.below(100) < 25;
            let identity_key = format!("test:{i}:{}", rng.next_u64()).into_bytes();
            let body = format!("body-payload-{i}-{}", rng.next_u64()).into_bytes();
            let record_digest = digest_of(&body);
            let identity_key_digest = digest_of(&identity_key);
            let name_id = if rng.below(100) < 70 {
                rng.below(n_names)
            } else {
                NONE_U32
            };
            let (source_subject, target_subject, relation_kind_id, category) = if is_relation {
                (
                    Some(rng.below(n_subjects)),
                    Some(rng.below(n_subjects)),
                    rng.below(n_rkinds) as u16,
                    CATEGORY_RELATION,
                )
            } else {
                (None, None, NONE_U16, CATEGORY_ENTITY)
            };
            RecordRow {
                record_id: rng.next_bytes32(),
                owner_artifact: rng.below(n_owners),
                owner_version: 0,
                valid_from: generation,
                valid_to: 0,
                category,
                kind_id: rng.below(n_kinds) as u16,
                universal_kind_id: rng.below(n_ukinds) as u16,
                facets: u64::from(rng.next_u32()) & 0x3F,
                span_artifact_version: 0,
                span_start_byte: rng.below(10_000),
                span_end_byte: 0,
                span_start_line: 0,
                span_end_line: 0,
                identity_type: rng.below(3) as u8,
                assignment_kind: 0,
                name_id,
                identity_key,
                record_digest,
                body_digest: record_digest,
                identity_id: identity_key_digest,
                identity_key_digest,
                previous_record_id: [0u8; 32],
                source_subject,
                target_subject,
                relation_kind_id,
                body,
            }
        })
        .collect()
}

pub fn gen_deps(n: usize, seed: u64, n_owners: u32) -> Vec<DependencyRow> {
    let mut rng = Rng::new(seed);
    (0..n)
        .map(|_| DependencyRow {
            dependency_id: rng.next_bytes32(),
            record: None,
            owner_artifact: rng.below(n_owners),
            owner_version: 0,
            dep_artifact: rng.below(n_owners),
            dep_version: 0,
            role: rng.below(3) as u8,
            valid_from: 1,
            valid_to: 0,
        })
        .collect()
}

/// `n` synthetic pending-site rows, all opened at `generation`, with
/// globally-unique `(owner_artifact, start, end, site_kind)` keys --
/// `start` strictly increases with `i`, offset by `key_base`, so two
/// separate calls (e.g. a base batch and a later delta's batch) never
/// collide by accident, while `owner_artifact`/`site_kind` still vary
/// randomly across the batch.
pub fn gen_pending_sites(
    n: usize,
    seed: u64,
    n_owners: u32,
    generation: u32,
    key_base: u32,
) -> Vec<PendingSiteRow> {
    let mut rng = Rng::new(seed);
    (0..n)
        .map(|i| {
            let start = key_base + (i as u32) * 100;
            let site_kind = match i % 3 {
                0 => PENDING_SITE_KIND_CALL,
                1 => PENDING_SITE_KIND_INHERITS,
                _ => PENDING_SITE_KIND_IMPLEMENTS,
            };
            PendingSiteRow {
                owner_artifact: rng.below(n_owners),
                owner_version: 0,
                valid_from: generation,
                valid_to: 0,
                start,
                end: start + 40,
                start_line: rng.below(500),
                end_line: rng.below(500),
                site_kind,
                reason: rng.below(5) as u8,
                source_subject: if rng.below(100) < 50 {
                    Some(rng.below(10))
                } else {
                    None
                },
            }
        })
        .collect()
}

/// Naive, O(n)-per-query reference model over the same rows the store
/// was built from -- ground truth for every integration test.
#[derive(Clone)]
pub struct RefModel {
    pub rows: Vec<RecordRow>,
    pub deps: Vec<DependencyRow>,
}

impl RefModel {
    pub fn visible(valid_from: u32, valid_to: u32, g: u64) -> bool {
        (valid_from as u64) <= g && (valid_to == 0 || (valid_to as u64) > g)
    }

    pub fn close(&mut self, key: &[u8; 32], valid_to: u32) {
        if let Some(r) = self.rows.iter_mut().find(|r| &r.record_id == key) {
            r.valid_to = valid_to;
        }
    }

    pub fn close_dep(&mut self, key: &[u8; 32], valid_to: u32) {
        if let Some(r) = self.deps.iter_mut().find(|r| &r.dependency_id == key) {
            r.valid_to = valid_to;
        }
    }

    pub fn visible_ids_by_owner(&self, owner: u32, g: u64) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| r.owner_artifact == owner && Self::visible(r.valid_from, r.valid_to, g))
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }

    pub fn visible_ids_by_name(&self, name_id: u32, g: u64) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| r.name_id == name_id && Self::visible(r.valid_from, r.valid_to, g))
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }

    pub fn visible_ids_by_kind(
        &self,
        universal_kind_id: u16,
        category: u8,
        kind_id: u16,
        g: u64,
    ) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| {
                r.universal_kind_id == universal_kind_id
                    && r.category == category
                    && r.kind_id == kind_id
                    && Self::visible(r.valid_from, r.valid_to, g)
            })
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }

    pub fn visible_ids_adjacency_out(&self, subject_ord: u32, g: u64) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| {
                r.source_subject == Some(subject_ord) && Self::visible(r.valid_from, r.valid_to, g)
            })
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }

    pub fn visible_ids_adjacency_in(&self, subject_ord: u32, g: u64) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| {
                r.target_subject == Some(subject_ord) && Self::visible(r.valid_from, r.valid_to, g)
            })
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }

    pub fn visible_count(&self, g: u64) -> u64 {
        self.rows
            .iter()
            .filter(|r| Self::visible(r.valid_from, r.valid_to, g))
            .count() as u64
    }

    pub fn deps_visible_count(&self, g: u64) -> u64 {
        self.deps
            .iter()
            .filter(|r| Self::visible(r.valid_from, r.valid_to, g))
            .count() as u64
    }

    pub fn all_visible_ids(&self, g: u64) -> Vec<[u8; 32]> {
        let mut v: Vec<[u8; 32]> = self
            .rows
            .iter()
            .filter(|r| Self::visible(r.valid_from, r.valid_to, g))
            .map(|r| r.record_id)
            .collect();
        v.sort();
        v
    }
}
