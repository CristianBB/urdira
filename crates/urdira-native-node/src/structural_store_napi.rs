//! napi surface for `urdira-structural-store` (v4 plan P2-5): a
//! `NativeStoreBuilder` class that interns plain-text v3-shaped rows into
//! the store's ordinal dictionaries and writes a cold `base-<g>` segment
//! via `SegmentWriter::write_base`, and a `NativeStructuralStoreHandle`
//! class that serves the read side (`packages/engine/src/native-query-snapshot-port.ts`).
//!
//! This module deliberately does NOT modify `urdira-structural-store` at
//! all (per the task brief: another agent may be touching `writer.rs`).
//! Two fields the store's on-disk row shape has no text form for --
//! `facets` (a bare `u64` bitmask) and relation-record subject ids (the
//! store only keeps a `sha256` digest per subject ordinal, per plan
//! §2.2's "ordinales u32 en vez de ids textuales") -- plus the full
//! `identity_id` text (the store's `records.digests` field is a 32-byte
//! digest of it, not the text itself) are carried in a small companion
//! JSON file this module writes/reads itself, entirely outside the
//! store's own manifest/segment format (`text_sidecar.json` at the store
//! root). See `docs/evidence/2026-09-02-v4-p2-5-native-port.md` for the
//! rationale and the `role`/`evidence_class` convention this module picks
//! for synthesized `IndexedGraphEdge` rows (the structural-store `RecordRow`
//! has no dedicated fields for either).

use napi::bindgen_prelude::Uint8Array;
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use urdira_structural_store::merkle::dependency_logical_view;
use urdira_structural_store::reader::Direction;
use urdira_structural_store::row::{
    CATEGORY_RELATION, DependencyRow, Dictionaries, NONE_U16, NONE_U32, RecordRow,
};
use urdira_structural_store::{
    PENDING_SITE_KIND_CALL, PENDING_SITE_KIND_IMPLEMENTS, PENDING_SITE_KIND_INHERITS, RecordView,
    StoreReader, VisibleIter, to_prefixed_hex,
};

fn napi_err(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

fn store_err(error: urdira_structural_store::StoreError) -> Error {
    napi_err(format!("structural store error: {error}"))
}

// --- hex helpers (no external crate: this module is the only consumer) ----

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Accepts either a bare 64-char hex string or a `"<prefix>:<64 hex>"` form
/// (e.g. `"record:abcd..."`) -- takes whatever follows the LAST `:`.
fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let tail = s.rsplit(':').next().unwrap_or(s);
    let bytes = hex_decode(tail)?;
    bytes.try_into().ok()
}

fn sha256_32(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

// --- category string <-> byte (v3 `record_occurrences.category` CHECK) ----

fn category_to_byte(s: &str) -> Result<u8> {
    Ok(match s {
        "entity" => 0,
        "relation" => 1,
        "diagnostic" => 2,
        "fact" => 3,
        "evidence" => 4,
        other => return Err(napi_err(format!("unknown record category '{other}'"))),
    })
}

fn category_from_byte(b: u8) -> &'static str {
    match b {
        0 => "entity",
        1 => "relation",
        2 => "diagnostic",
        3 => "fact",
        4 => "evidence",
        _ => "entity",
    }
}

// --- interners used only while building (never persisted as such) --------

#[derive(Default)]
struct StrInterner {
    index: HashMap<String, u32>,
    values: Vec<String>,
}

impl StrInterner {
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        let i = self.values.len() as u32;
        self.index.insert(s.to_string(), i);
        self.values.push(s.to_string());
        i
    }
}

#[derive(Default)]
struct PairInterner {
    index: HashMap<(String, String), u32>,
    values: Vec<(String, String)>,
}

impl PairInterner {
    fn intern(&mut self, key: (String, String)) -> u32 {
        if let Some(&i) = self.index.get(&key) {
            return i;
        }
        let i = self.values.len() as u32;
        self.index.insert(key.clone(), i);
        self.values.push(key);
        i
    }
}

#[derive(Default)]
struct BytesInterner {
    index: HashMap<[u8; 32], u32>,
    digests: Vec<[u8; 32]>,
    texts: Vec<String>,
}

impl BytesInterner {
    fn intern(&mut self, text: &str) -> u32 {
        let digest = sha256_32(text.as_bytes());
        if let Some(&i) = self.index.get(&digest) {
            return i;
        }
        let i = self.digests.len() as u32;
        self.index.insert(digest, i);
        self.digests.push(digest);
        self.texts.push(text.to_string());
        i
    }
}

// --- text sidecar (outside the store's own format entirely) --------------

#[derive(Default, Serialize, Deserialize, Clone)]
struct TextSidecar {
    facets: Vec<String>,
    subjects: Vec<String>,
    /// `record_id` hex (no prefix) -> full v3 `identity_id` text.
    identity_ids: HashMap<String, String>,
    /// `DependencyRow.role` byte code -> text (see `add_one_dependency`).
    dep_roles: Vec<String>,
    /// `dependency_id` hex -> the v3 `record_id` hex it was attributed to
    /// (when given) -- `DependencyRow.record`'s ordinal is otherwise
    /// producer-defined and nothing in `urdira-structural-store` resolves
    /// it back to a `record_id`, so this sidecar carries the text
    /// directly rather than relying on that ordinal space.
    dep_record_ids: HashMap<String, String>,
}

fn sidecar_path(dir: &Path) -> PathBuf {
    dir.join("text_sidecar.json")
}

fn write_sidecar(dir: &Path, sidecar: &TextSidecar) -> Result<()> {
    let json =
        serde_json::to_vec(sidecar).map_err(|e| napi_err(format!("encode text sidecar: {e}")))?;
    std::fs::write(sidecar_path(dir), json)
        .map_err(|e| napi_err(format!("write text sidecar: {e}")))?;
    Ok(())
}

fn load_sidecar(dir: &Path) -> Result<TextSidecar> {
    let path = sidecar_path(dir);
    if !path.exists() {
        return Ok(TextSidecar::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| napi_err(format!("read text sidecar: {e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| napi_err(format!("decode text sidecar: {e}")))
}

/// Reconstructs one adjacency endpoint's subject-id text (gap A1, task
/// P2-2d -- see `adjacency`'s own doc comment for the two writers'
/// differing `dicts.subjects` conventions). Three sources, in priority
/// order:
/// 1. `dicts.subject_text` (P2-2e): the store's OWN text dictionary,
///    aligned 1:1 with `dicts.subjects` by ordinal -- populated by a REAL
///    v4 scan (`urdira-indexing-worker`'s `materialize_generation`) at
///    generation time, so this is the source of truth whenever it is
///    present and covers `ordinal` (a store from before P2-2e, or one
///    whose later generations have not yet caught a given ordinal up, may
///    be shorter than `dicts.subjects` -- see `Dictionaries::subject_text`'s
///    own doc comment).
/// 2. `sidecar.subjects` (task P2-2d): the v3-conversion path
///    (`NativeStoreBuilder`) carries the real subject text verbatim in this
///    companion JSON file, keyed by ordinal, because its own
///    `dicts.subjects[ordinal]` is only a `sha256` digest of that text with
///    no way back to it. Never populated for a real v4 scan.
/// 3. Reconstruction: `dicts.subjects[ordinal]` IS the referenced entity's
///    raw `record_id` bytes on every route this module serves, so
///    `"record:{hex}"` recovers exactly the `record_id` text form every
///    other endpoint of this port (and `canonical-query-data-port.ts`'s
///    alias matching) already uses -- the same fallback `dicts.subject_text`
///    itself is built from at generation time, so this only ever fires for
///    an ordinal genuinely older than both text sources above.
fn subject_text_for(sidecar: &TextSidecar, dicts: &Dictionaries, ordinal: u32) -> String {
    if let Some(text) = dicts.subject_text.get(ordinal as usize)
        && !text.is_empty()
    {
        return text.clone();
    }
    if let Some(text) = sidecar.subjects.get(ordinal as usize)
        && !text.is_empty()
    {
        return text.clone();
    }
    match dicts.subjects.get(ordinal as usize) {
        Some(digest) => format!("record:{}", hex_encode(digest)),
        None => String::new(),
    }
}

// =========================== napi input rows ==============================

#[napi(object)]
pub struct NativeInputRecordRow {
    /// 64-char lowercase hex, no `record:` prefix (or with any `<x>:`
    /// prefix -- only the text after the last `:` is used).
    pub record_id_hex: String,
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub valid_from: u32,
    pub valid_to: u32,
    /// One of `entity` | `relation` | `fact` | `evidence` | `diagnostic`.
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub facets: Vec<String>,
    pub span_artifact_id: Option<String>,
    pub span_artifact_version_id: Option<String>,
    pub span_start_byte: Option<u32>,
    pub span_end_byte: Option<u32>,
    pub span_start_line: Option<u32>,
    pub span_end_line: Option<u32>,
    /// Full v3 `identity_id` text (e.g. `"identity:<hex>"`), carried
    /// through verbatim via the text sidecar.
    pub identity_id: Option<String>,
    /// Full v3 `identity_key` text (colon-joined path ending in the
    /// entity's name).
    pub identity_key: Option<String>,
    /// Only for category `relation` rows.
    pub relation_kind: Option<String>,
    pub source_subject: Option<String>,
    pub target_subject: Option<String>,
    pub body_payload: Uint8Array,
}

#[napi(object)]
pub struct NativeInputDependencyRow {
    /// If omitted, minted as `sha256(record_id_hex ++ dep_artifact_id ++
    /// dep_artifact_version_id ++ role)` -- stable and unique enough for
    /// the converter's own use (v3's real `dependency_entry_id` is not
    /// needed downstream by any of the 18 query operations).
    pub dependency_id_hex: Option<String>,
    pub record_id_hex: Option<String>,
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub dep_artifact_id: String,
    pub dep_artifact_version_id: String,
    pub role: String,
    pub valid_from: u32,
    pub valid_to: u32,
}

// =========================== napi output rows =============================

/// Matches `packages/engine/src/query-record-decode.ts`'s `RecordRow`
/// shape MINUS `workspace_id` (the port fills that in from `scope`) and
/// MINUS `value_rows` (the native route never needs the relational-value
/// fallback -- `body_payload` is always populated).
#[napi(object)]
pub struct NativeOutputRecordRow {
    pub record_id: String,
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub body_payload: Uint8Array,
    pub primary_source_span_artifact_version_id: Option<String>,
    pub primary_source_span_start_byte: Option<String>,
    pub primary_source_span_end_byte: Option<String>,
    pub primary_source_span_start_line: Option<String>,
    pub primary_source_span_end_line: Option<String>,
    pub identity_id: Option<String>,
    pub identity_key: Option<String>,
    pub facet_rows: Vec<String>,
    /// Additive (task: follow-up to P2-4/P2-5): `"sha256:<hex>"` form of
    /// `RecordView.record_digest()` -- the same value `iterVisibleDigests`
    /// returns as raw bytes, exposed here too because a per-row export is
    /// occasionally more convenient than a bulk iterator for a caller that
    /// already has a `NativeOutputRecordRow` in hand (e.g. spot-checking
    /// one record without a full leaf-set scan). Not consumed by
    /// `decodeRow` (`packages/engine/src/query-record-decode.ts`) or any
    /// of the 18 query operations -- purely additive.
    pub record_digest: String,
}

#[napi(object)]
pub struct NativeOutputEdgeRow {
    pub edge_id: String,
    pub source_subject_id: String,
    pub target_subject_id: String,
    pub relation_record_id: String,
    pub relation_kind: String,
    pub role: String,
    pub evidence_class: String,
}

#[napi(object)]
pub struct NativeOutputDependencyRow {
    pub record_id: Option<String>,
    pub owner_artifact_id: String,
    pub owner_artifact_version_id: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
    pub dependency_role: String,
}

/// One `pending.sites` row (`crates/urdira-structural-store`), shaped for
/// `core:get_outline`'s additive `pending_sites` stream
/// (`packages/engine/src/canonical-query-data-port.ts`,
/// `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`
/// §8). Deliberately omits `owner_artifact`/`owner_version`: every row a
/// single `pending_sites_by_owner` call returns shares the SAME owner the
/// caller already resolved to an ordinal, so the caller already knows it
/// and can attach `path` itself.
#[napi(object)]
pub struct NativeOutputPendingSiteRow {
    pub start: u32,
    pub end: u32,
    /// `"call" | "inherits" | "implements"` -- see `pending_site_kind_text`.
    pub site_kind: String,
    /// The `PendingReasonCode` name (see `pending_reason_text`).
    pub reason: String,
    /// The enclosing entity's `identity_key` text, resolved exactly like
    /// the residual pass's own `source_subject -> dicts.subjects[ordinal]
    /// -> StoreReader::get_visible -> identity_key` chain
    /// (`crates/urdira-indexing-worker/src/v4/residual.rs::collect`, read
    /// only -- not imported, since that crate depends on this one, not the
    /// other way around). `None` when the site's `source_subject` is
    /// absent or does not resolve at this generation.
    pub source_id: Option<String>,
}

#[napi(object)]
pub struct NativeArtifactPair {
    pub artifact_id: String,
    pub artifact_version_id: String,
}

#[napi(object)]
pub struct NativeDictionaries {
    pub kinds: Vec<String>,
    pub universal_kinds: Vec<String>,
    pub relation_kinds: Vec<String>,
    pub names: Vec<String>,
    pub artifacts: Vec<NativeArtifactPair>,
    pub facets: Vec<String>,
    pub subjects: Vec<String>,
}

#[napi(object)]
pub struct NativeVisibleBatch {
    pub rows: Vec<NativeOutputRecordRow>,
    pub next_cursor: Option<String>,
}

/// Raw, from-scratch leaf export for `packages/engine/src/v4-verify.ts`
/// (task: follow-up to P2-4). `keys`/`digests` are contiguous N*32-byte
/// buffers (member key, logical/content digest), member `i`'s bytes at
/// `[i*32, i*32+32)` in each -- returned as raw bytes rather than
/// `Vec<NativeOutputRecordRow>`/per-row objects because the caller only
/// ever feeds these straight into `BucketedMerkleSet.fromSortedBatches`
/// (`packages/canonical/src/merkle-bucket.ts`), and at corpus scale
/// (millions of members) one boxed napi object per row is a real
/// allocation/marshalling cost this avoids entirely. See
/// `iter_visible_digests`/`iter_visible_dependency_digests`/
/// `iter_visible_graph_digests` below for which (key, logical) pair each
/// of the three canonical sets uses -- exactly what
/// `crates/urdira-structural-store/src/merkle.rs` (records/dependency) and
/// `crates/urdira-indexing-worker/src/v4/publish.rs` (graph) already
/// compute the SAME roots from at publish time.
#[napi(object)]
pub struct NativeDigestBatch {
    pub keys: Uint8Array,
    pub digests: Uint8Array,
    pub next_cursor: Option<String>,
}

#[napi(object)]
pub struct NativeChangedEntry {
    pub record_id: String,
    pub opened: bool,
    pub row: Option<NativeOutputRecordRow>,
    pub valid_to: u32,
}

#[napi(object)]
pub struct NativeStoreBuilderSummary {
    pub row_count: u32,
    pub dependency_count: u32,
    pub generation: u32,
    pub records_root: String,
    pub dependency_root: String,
}

// =============================== builder ===================================

/// See module doc. `create` -> any number of `addRecords`/`addDependencies`
/// -> `finish`. Cold-only (mirrors `SegmentWriter::write_base`); no delta
/// support -- the converter this exists for materializes one v3 snapshot
/// into one `base-<g>` at a time.
#[derive(Default)]
#[napi]
pub struct NativeStoreBuilder {
    dir: Option<PathBuf>,
    generation: u64,
    kinds: StrInterner,
    universal_kinds: StrInterner,
    relation_kinds: StrInterner,
    names: StrInterner,
    artifacts: PairInterner,
    facets: StrInterner,
    subjects: BytesInterner,
    dep_roles: StrInterner,
    rows: Vec<RecordRow>,
    deps: Vec<DependencyRow>,
    identity_ids: HashMap<String, String>,
    dep_record_ids: HashMap<String, String>,
}

#[napi]
impl NativeStoreBuilder {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn create(&mut self, dir: String, generation: u32) -> Result<()> {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path)
            .map_err(|e| napi_err(format!("create structural store dir: {e}")))?;
        self.dir = Some(path);
        self.generation = generation as u64;
        Ok(())
    }

    #[napi]
    pub fn add_records(&mut self, rows: Vec<NativeInputRecordRow>) -> Result<()> {
        for row in rows {
            self.add_one_record(row)?;
        }
        Ok(())
    }

    #[napi]
    pub fn add_dependencies(&mut self, rows: Vec<NativeInputDependencyRow>) -> Result<()> {
        for row in rows {
            self.add_one_dependency(row)?;
        }
        Ok(())
    }

    #[napi]
    pub fn finish(&mut self) -> Result<NativeStoreBuilderSummary> {
        let dir = self
            .dir
            .clone()
            .ok_or_else(|| napi_err("NativeStoreBuilder.finish called before create"))?;
        let dicts = Dictionaries {
            kinds: self.kinds.values.clone(),
            universal_kinds: self.universal_kinds.values.clone(),
            relation_kinds: self.relation_kinds.values.clone(),
            names: self.names.values.clone(),
            subjects: self.subjects.digests.clone(),
            artifacts: self.artifacts.values.clone(),
            // P2-2e: the v3-conversion path keeps carrying this text in
            // `text_sidecar.json` (`sidecar` below), NOT in the store's own
            // `Dictionaries` -- `subject_text_for`/`facet_names()`'s own
            // fallback chain reads the sidecar whenever these are empty, so
            // leaving them empty here is deliberate, not an omission.
            facet_names: Vec::new(),
            subject_text: Vec::new(),
            // A3a-fix: this v3-conversion path has no real owner path to
            // offer (`artifacts` here is a v3 artifact id/version pair, not
            // guaranteed to follow the `"artifact:{path}"` convention the
            // real v4 pipeline uses regardless) -- every row from this
            // builder falls back to `IDENTITY_LAYOUT_RAW`, exactly the
            // pre-A3a behavior, which is correct for this path.
            // `entity_kinds` is populated entirely inside `structural-store`
            // itself at write time (see `identity_codec`'s module doc), not
            // by any caller.
            artifact_paths: Vec::new(),
            entity_kinds: Vec::new(),
        };
        let writer = urdira_structural_store::SegmentWriter::new();
        let summary = writer
            .write_base(&dir, &self.rows, &self.deps, &dicts, self.generation)
            .map_err(store_err)?;

        let sidecar = TextSidecar {
            facets: self.facets.values.clone(),
            subjects: self.subjects.texts.clone(),
            identity_ids: self.identity_ids.clone(),
            dep_roles: self.dep_roles.values.clone(),
            dep_record_ids: self.dep_record_ids.clone(),
        };
        write_sidecar(&dir, &sidecar)?;

        Ok(NativeStoreBuilderSummary {
            row_count: self.rows.len() as u32,
            dependency_count: self.deps.len() as u32,
            generation: self.generation as u32,
            records_root: to_prefixed_hex(&summary.records_root),
            dependency_root: to_prefixed_hex(&summary.dependency_root),
        })
    }

    fn add_one_record(&mut self, r: NativeInputRecordRow) -> Result<()> {
        let record_id = parse_hex32(&r.record_id_hex)
            .ok_or_else(|| napi_err(format!("bad record_id_hex '{}'", r.record_id_hex)))?;
        let category = category_to_byte(&r.category)?;
        let kind_id = self.kinds.intern(&r.kind) as u16;
        let universal_kind_id = self.universal_kinds.intern(&r.universal_kind) as u16;
        let owner_ord = self.artifacts.intern((
            r.owner_artifact_id.clone(),
            r.owner_artifact_version_id.clone(),
        ));

        let span_artifact_version = match (&r.span_artifact_id, &r.span_artifact_version_id) {
            (Some(aid), Some(vid)) => self.artifacts.intern((aid.clone(), vid.clone())),
            _ => NONE_U32,
        };
        let span_start_byte = r.span_start_byte.unwrap_or(NONE_U32);
        let span_end_byte = r.span_end_byte.unwrap_or(NONE_U32);
        let span_start_line = r.span_start_line.unwrap_or(NONE_U32);
        let span_end_line = r.span_end_line.unwrap_or(NONE_U32);

        let mut facets_mask: u64 = 0;
        for f in &r.facets {
            let bit = self.facets.intern(f);
            if bit >= 64 {
                return Err(napi_err("facet dictionary exceeded 64 distinct values"));
            }
            facets_mask |= 1u64 << bit;
        }

        let (name_id, identity_key_bytes, identity_key_digest) = match &r.identity_key {
            Some(key) => {
                let tail = key.rsplit(':').next().unwrap_or(key);
                (
                    self.names.intern(tail),
                    key.as_bytes().to_vec(),
                    sha256_32(key.as_bytes()),
                )
            }
            None => (NONE_U32, Vec::new(), [0u8; 32]),
        };

        // The store's `records.digests.identity_id` field is a bare
        // 32-byte digest (no text form) -- derived here as sha256 of the
        // v3 identity_id text purely so `by_identity`-style internal
        // bookkeeping has *a* stable key; the actual text is preserved
        // verbatim in the sidecar, keyed by record_id, and that sidecar
        // copy -- not this digest -- is what `NativeOutputRecordRow.identity_id`
        // is built from.
        let identity_id_digest = match &r.identity_id {
            Some(text) => {
                self.identity_ids
                    .insert(r.record_id_hex.clone(), text.clone());
                sha256_32(text.as_bytes())
            }
            None => [0u8; 32],
        };

        let (source_subject, target_subject) = match (&r.source_subject, &r.target_subject) {
            (Some(s), Some(t)) => (Some(self.subjects.intern(s)), Some(self.subjects.intern(t))),
            _ => (None, None),
        };
        let relation_kind_id = match &r.relation_kind {
            Some(rk) => self.relation_kinds.intern(rk) as u16,
            None => NONE_U16,
        };

        let body_payload = r.body_payload.to_vec();
        let body_digest = sha256_32(&body_payload);
        // Not read by any of the 18 query operations (decodeRow never
        // touches record_digest); kept non-zero and derived only so it is
        // never mistaken for the "absent" sentinel.
        let record_digest = sha256_32(&record_id);

        self.rows.push(RecordRow {
            record_id,
            owner_artifact: owner_ord,
            owner_version: owner_ord,
            valid_from: r.valid_from,
            valid_to: r.valid_to,
            category,
            kind_id,
            universal_kind_id,
            facets: facets_mask,
            span_artifact_version,
            span_start_byte,
            span_end_byte,
            span_start_line,
            span_end_line,
            identity_type: 0,
            assignment_kind: 0,
            name_id,
            identity_key: identity_key_bytes,
            record_digest,
            body_digest,
            identity_id: identity_id_digest,
            identity_key_digest,
            previous_record_id: [0u8; 32],
            source_subject,
            target_subject,
            relation_kind_id,
            body: body_payload,
        });
        Ok(())
    }

    fn add_one_dependency(&mut self, r: NativeInputDependencyRow) -> Result<()> {
        let owner_ord = self.artifacts.intern((
            r.owner_artifact_id.clone(),
            r.owner_artifact_version_id.clone(),
        ));
        let dep_ord = self
            .artifacts
            .intern((r.dep_artifact_id.clone(), r.dep_artifact_version_id.clone()));
        // `DependencyRow.record` is documented as "ordinal into this
        // generation's records" (row.rs) -- resolve it against
        // `record_id_hex` if given, by looking it up in the rows built so
        // far. A linear scan is acceptable here: dependency rows are far
        // fewer than record rows in every fixture this converter targets.
        let record = match &r.record_id_hex {
            Some(hex) => parse_hex32(hex).and_then(|key| {
                self.rows
                    .iter()
                    .position(|row| row.record_id == key)
                    .map(|i| i as u32)
            }),
            None => None,
        };
        let dependency_id = match &r.dependency_id_hex {
            Some(hex) => parse_hex32(hex).unwrap_or_else(|| sha256_32(hex.as_bytes())),
            None => {
                let seed = format!(
                    "{}\u{0}{}\u{0}{}\u{0}{}",
                    r.record_id_hex.as_deref().unwrap_or(""),
                    r.dep_artifact_id,
                    r.dep_artifact_version_id,
                    r.role
                );
                sha256_32(seed.as_bytes())
            }
        };
        if let Some(hex) = &r.record_id_hex {
            self.dep_record_ids
                .insert(hex_encode(&dependency_id), hex.clone());
        }
        // `DependencyRow.role` is a `u8` byte code (structural-store's own
        // shape); the text is recovered on read via `self.dep_roles`
        // (mirrors the `kinds`/`universal_kinds` string interners --
        // small, bounded cardinality, no sidecar needed since it fits the
        // existing `relation_kinds` slot in `Dictionaries` is already
        // spoken for, so this reuses a dedicated interner written into
        // the sidecar instead).
        let role_byte = {
            let ord = self.dep_roles.intern(&r.role);
            if ord > u8::MAX as u32 {
                return Err(napi_err(
                    "dependency role dictionary exceeded 256 distinct values",
                ));
            }
            ord as u8
        };
        self.deps.push(DependencyRow {
            dependency_id,
            record,
            owner_artifact: owner_ord,
            owner_version: owner_ord,
            dep_artifact: dep_ord,
            dep_version: dep_ord,
            role: role_byte,
            valid_from: r.valid_from,
            valid_to: r.valid_to,
        });
        Ok(())
    }
}

// ================================ handle ===================================

/// `role`/`evidence_class` convention for synthesized `IndexedGraphEdge`
/// rows (see module doc): `role` = the relation record's own `kind` text
/// (there is no separate structural-store field for it), `evidence_class`
/// = `"confirmed"` (this converter does not carry the relation body's
/// `classification` field through to a queryable column -- see the
/// evidence doc's deviation note).
const SYNTHESIZED_EVIDENCE_CLASS: &str = "confirmed";

#[napi]
pub struct NativeStructuralStoreHandle {
    reader: StoreReader,
    dir: PathBuf,
    sidecar: TextSidecar,
    /// Frente S-G (2026-09-08, root-cause fix for the n8n full-embed stall,
    /// `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`):
    /// a single resumable cursor slot for [`Self::iter_visible_batch`]'s
    /// sequential-drain fast path. `(generation, last_served_key_hex, iter)`
    /// -- `iter` is already positioned to yield the record AFTER
    /// `last_served_key_hex` (or the very first visible record, when
    /// `last_served_key_hex` is `None`) at exactly `generation`.
    /// `records_for_query_batches` (`native-query-snapshot-port.ts`) is the
    /// ONLY real caller, and it always drains one handle sequentially,
    /// page after page, passing each page's own last key back as the next
    /// call's `after_key_hex` -- exactly the pattern this slot recognizes.
    /// Any call that does NOT match (a different generation, a
    /// non-sequential/concurrent access pattern, or simply no cursor
    /// cached yet) transparently falls back to the ORIGINAL correct-but-
    /// O(n)-per-batch re-scan-and-skip below -- this is a pure speed
    /// optimization for the common case, never a correctness requirement,
    /// so a cache miss can never produce a wrong answer, only a slower one.
    visible_cursor: Option<(u64, Option<String>, VisibleIter)>,
}

fn artifact_text(dicts: &Dictionaries, ordinal: u32) -> (String, String) {
    if ordinal == NONE_U32 {
        return (String::new(), String::new());
    }
    dicts
        .artifacts
        .get(ordinal as usize)
        .cloned()
        .unwrap_or_default()
}

fn kind_text(dict: &[String], id: u16) -> String {
    dict.get(id as usize).cloned().unwrap_or_default()
}

fn opt_u32_text(v: u32) -> Option<String> {
    (v != NONE_U32).then(|| v.to_string())
}

/// `pending.sites.site_kind` as query-facing text. Mirrors
/// `urdira_structural_store::{PENDING_SITE_KIND_CALL,PENDING_SITE_KIND_INHERITS,PENDING_SITE_KIND_IMPLEMENTS}`,
/// the on-disk contract those constants already own -- this just names them.
fn pending_site_kind_text(kind: u8) -> &'static str {
    match kind {
        PENDING_SITE_KIND_CALL => "call",
        PENDING_SITE_KIND_INHERITS => "inherits",
        PENDING_SITE_KIND_IMPLEMENTS => "implements",
        _ => "unspecified",
    }
}

/// `pending.sites.reason` as query-facing text. SOURCE OF TRUTH:
/// `PendingReasonCode` in `crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`
/// (that crate is owned by another agent this session and this crate does
/// not depend on it, so the table is copied here rather than imported --
/// see `docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md`
/// §2.2 for the append-only on-disk contract: codes never change meaning,
/// only grow). Keep in sync by hand if that enum ever grows.
fn pending_reason_text(reason: u8) -> &'static str {
    match reason {
        0 => "unspecified",
        1 => "call_deferred_to_e3",
        2 => "call_target_uncertain",
        3 => "overload_ambiguous",
        4 => "union_ambiguous",
        5 => "target_not_interned",
        6 => "heritage_unresolved",
        7 => "heritage_deferred_to_e3",
        8 => "heritage_target_uncertain",
        9 => "heritage_clause_partially_pending",
        _ => "unspecified",
    }
}

#[napi]
impl NativeStructuralStoreHandle {
    #[napi(factory)]
    pub fn open(dir: String) -> Result<Self> {
        let path = PathBuf::from(dir);
        let reader = StoreReader::open(&path).map_err(store_err)?;
        let sidecar = load_sidecar(&path)?;
        Ok(NativeStructuralStoreHandle {
            reader,
            dir: path,
            sidecar,
            visible_cursor: None,
        })
    }

    #[napi]
    pub fn reopen_if_changed(&mut self) -> Result<bool> {
        let changed = self.reader.reopen_if_changed().map_err(store_err)?;
        if changed {
            self.sidecar = load_sidecar(&self.dir)?;
            // The cached cursor's own `Arc<StoreInner>` snapshot would stay
            // perfectly valid to keep draining (it owns its generation's
            // segments independently of `self.reader`'s own reopen), but a
            // reopen means a NEWER generation just became current -- keeping
            // an old-generation cursor alive only pins its snapshot's memory
            // for a stream essentially nothing will resume. Pure hygiene,
            // never a correctness requirement (see `visible_cursor`'s own
            // doc comment).
            self.visible_cursor = None;
        }
        Ok(changed)
    }

    #[napi]
    pub fn current_generation(&self) -> u32 {
        self.reader.generation() as u32
    }

    #[napi]
    pub fn dictionaries(&self) -> NativeDictionaries {
        let dicts = self.reader.dictionaries();
        NativeDictionaries {
            kinds: dicts.kinds.clone(),
            universal_kinds: dicts.universal_kinds.clone(),
            relation_kinds: dicts.relation_kinds.clone(),
            names: dicts.names.clone(),
            artifacts: dicts
                .artifacts
                .iter()
                .map(|(a, v)| NativeArtifactPair {
                    artifact_id: a.clone(),
                    artifact_version_id: v.clone(),
                })
                .collect(),
            facets: if dicts.facet_names.is_empty() {
                self.sidecar.facets.clone()
            } else {
                dicts.facet_names.clone()
            },
            subjects: if dicts.subject_text.is_empty() {
                self.sidecar.subjects.clone()
            } else {
                dicts.subject_text.clone()
            },
        }
    }

    /// P2-2e: the facet name table, indexed by BIT INDEX (see
    /// `Dictionaries::facet_names`'s doc comment) -- prefers the store's
    /// own dictionary (a real v4 scan) and falls back to the v3-conversion
    /// text sidecar (which never populates `dicts.facet_names`). Exposed
    /// as its own method (distinct from `dictionaries()`, which already
    /// surfaces the same list under `NativeDictionaries::facets` for
    /// backward compatibility) purely to match this task's own contract
    /// naming (`facetNames()`).
    #[napi]
    pub fn facet_names(&self) -> Vec<String> {
        let dicts = self.reader.dictionaries();
        if dicts.facet_names.is_empty() {
            self.sidecar.facets.clone()
        } else {
            dicts.facet_names.clone()
        }
    }

    /// P2-2e: one subject ordinal's human-readable text -- see
    /// `subject_text_for`'s own doc comment for the three-source priority
    /// (store `dicts.subject_text`, then the v3-conversion sidecar, then
    /// `"record:<hex>"` reconstruction). Empty string for an out-of-range
    /// ordinal (mirrors `subject_text_for`'s own `None` branch).
    #[napi]
    pub fn subject_text(&self, ordinal: u32) -> String {
        let dicts = self.reader.dictionaries();
        subject_text_for(&self.sidecar, &dicts, ordinal)
    }

    fn to_output(&self, view: &RecordView, dicts: &Dictionaries) -> NativeOutputRecordRow {
        let record_id_hex = hex_encode(&view.record_id());
        let (owner_artifact_id, owner_artifact_version_id) =
            artifact_text(dicts, view.owner_artifact());
        let has_span = view.span_artifact_version() != NONE_U32;
        let (_span_artifact_id, span_artifact_version_id) = if has_span {
            artifact_text(dicts, view.span_artifact_version())
        } else {
            (String::new(), String::new())
        };
        let identity_key = if view.identity_key().is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&view.identity_key()).into_owned())
        };
        // Gap A2 (task P2-2d): the v3-conversion path (`NativeStoreBuilder`)
        // carries a v3-authored `identity_id` text verbatim through the
        // sidecar (see `TextSidecar`'s doc comment) because it hardcodes
        // `identity_type: 0` for every input row regardless of category, so
        // it cannot reconstruct the real prefix word from the store's own
        // `identity_type` byte. The v4 Rust cold-scan pipeline
        // (`crates/urdira-indexing-worker/src/v4/materialize.rs`) never
        // writes a sidecar at all, but it DOES persist a real, correctly
        // bucketed `identity_type` byte (0/1/2, the same numbering
        // `category_from_byte` already gives entity/relation/diagnostic)
        // alongside the raw `identity_id` digest -- `record.identity_id ==
        // "{identity_type}:{sha256(identity_key)-hex}"` by construction
        // (`urdira-native-core`'s `structural_kernel_batch_parts`), so the
        // exact same text is reconstructable here without the sidecar.
        // Prefer the sidecar (the v3-conversion path's only source of
        // truth) when present, and fall back to this reconstruction --
        // rather than `None` -- for every native-pipeline-produced store.
        let identity_id = self
            .sidecar
            .identity_ids
            .get(&record_id_hex)
            .cloned()
            .or_else(|| {
                let digest = view.identity_id();
                (digest != [0u8; 32]).then(|| {
                    format!(
                        "{}:{}",
                        category_from_byte(view.identity_type()),
                        hex_encode(&digest)
                    )
                })
            });
        // P2-2e: prefer the store's OWN `dicts.facet_names` (populated by a
        // real v4 scan, indexed by bit position -- see `Dictionaries::
        // facet_names`'s doc comment) and fall back to the v3-conversion
        // sidecar for a converted store, which never populates
        // `dicts.facet_names`. Before this task, a real v4 store had NO
        // source for this at all (`self.sidecar.facets` is always empty
        // for a native-pipeline-produced store), so `facet_rows` silently
        // came back empty for every real v4 record -- this is the fix.
        let facet_rows: Vec<String> = {
            let mask = view.facets();
            (0..64u32)
                .filter(|bit| (mask & (1u64 << bit)) != 0)
                .filter_map(|bit| {
                    dicts
                        .facet_names
                        .get(bit as usize)
                        .filter(|name| !name.is_empty())
                        .or_else(|| self.sidecar.facets.get(bit as usize))
                        .cloned()
                })
                .collect()
        };
        NativeOutputRecordRow {
            record_id: format!("record:{record_id_hex}"),
            category: category_from_byte(view.category()).to_string(),
            kind: kind_text(&dicts.kinds, view.kind_id()),
            universal_kind: kind_text(&dicts.universal_kinds, view.universal_kind_id()),
            owner_artifact_id,
            owner_artifact_version_id,
            body_payload: Uint8Array::new(view.body().to_vec()),
            primary_source_span_artifact_version_id: has_span.then_some(span_artifact_version_id),
            primary_source_span_start_byte: opt_u32_text(view.span_start_byte()),
            primary_source_span_end_byte: opt_u32_text(view.span_end_byte()),
            primary_source_span_start_line: opt_u32_text(view.span_start_line()),
            primary_source_span_end_line: opt_u32_text(view.span_end_line()),
            identity_id,
            identity_key,
            facet_rows,
            record_digest: format!("sha256:{}", hex_encode(&view.record_digest())),
        }
    }

    #[napi]
    pub fn records_by_ids(
        &self,
        keys_hex: Vec<String>,
        generation: u32,
    ) -> Result<Vec<NativeOutputRecordRow>> {
        let dicts = self.reader.dictionaries();
        let mut out = Vec::with_capacity(keys_hex.len());
        for hex in keys_hex {
            let Some(key) = parse_hex32(&hex) else {
                continue;
            };
            if let Some(view) = self.reader.get_visible(&key, generation as u64) {
                out.push(self.to_output(&view, &dicts));
            }
        }
        Ok(out)
    }

    #[napi]
    pub fn records_by_name(
        &self,
        name: String,
        generation: u32,
    ) -> Result<Vec<NativeOutputRecordRow>> {
        let dicts = self.reader.dictionaries();
        let Some(name_id) = dicts.names.iter().position(|n| n == &name) else {
            return Ok(Vec::new());
        };
        let views = self.reader.by_name(name_id as u32, generation as u64);
        Ok(views.iter().map(|v| self.to_output(v, &dicts)).collect())
    }

    /// One exact `(universal_kind, category, kind)` triple -- see
    /// `NativeCanonicalQuerySnapshotPort.records_by_selector` (TS side)
    /// for how a `RecordColumnSelector` with array-valued/omitted
    /// dimensions is decomposed into a bounded set of calls to this.
    #[napi]
    pub fn records_by_kind_exact(
        &self,
        universal_kind: String,
        category: String,
        kind: String,
        generation: u32,
        limit: u32,
        after_key_hex: Option<String>,
    ) -> Result<Vec<NativeOutputRecordRow>> {
        let dicts = self.reader.dictionaries();
        let Some(universal_kind_id) = dicts
            .universal_kinds
            .iter()
            .position(|k| k == &universal_kind)
        else {
            return Ok(Vec::new());
        };
        let Some(kind_id) = dicts.kinds.iter().position(|k| k == &kind) else {
            return Ok(Vec::new());
        };
        let category_byte = category_to_byte(&category)?;
        let after_key = after_key_hex.as_deref().and_then(parse_hex32);
        let views = self.reader.by_kind(
            universal_kind_id as u16,
            category_byte,
            kind_id as u16,
            generation as u64,
            limit as usize,
            after_key,
        );
        Ok(views.iter().map(|v| self.to_output(v, &dicts)).collect())
    }

    /// Ordinal directly into the store's `artifacts` dictionary (see
    /// `dictionaries()`); TS resolves the ordinal by scanning the small
    /// returned dictionary rather than this crate exposing a text-keyed
    /// lookup itself.
    #[napi]
    pub fn records_by_owner_ordinal(
        &self,
        owner_artifact_ordinal: u32,
        generation: u32,
    ) -> Result<Vec<NativeOutputRecordRow>> {
        let dicts = self.reader.dictionaries();
        let views = self
            .reader
            .by_owner(owner_artifact_ordinal, generation as u64);
        Ok(views.iter().map(|v| self.to_output(v, &dicts)).collect())
    }

    #[napi]
    pub fn adjacency(
        &self,
        subject_ids: Vec<String>,
        direction: String,
        generation: u32,
    ) -> Result<Vec<NativeOutputEdgeRow>> {
        let dir = match direction.as_str() {
            "outbound" => Direction::Out,
            "inbound" => Direction::In,
            other => return Err(napi_err(format!("unknown adjacency direction '{other}'"))),
        };
        let dicts = self.reader.dictionaries();
        let mut out: Vec<NativeOutputEdgeRow> = Vec::new();
        let mut seen: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
        // Gap A1 (task P2-2d): `dicts.subjects[ordinal]` (a raw 32-byte
        // digest, `urdira_structural_store::row::Dictionaries`) means two
        // different things depending on which writer produced this store:
        // the v3-conversion path (`NativeStoreBuilder::add_one_record`,
        // above) interns `sha256(subject_text)` for whatever subject-id
        // text the converter supplied, matching this method's ORIGINAL
        // (and still-needed, for that path) `sha256_32(subject_text)`
        // lookup key; the v4 Rust cold-scan pipeline
        // (`crates/urdira-indexing-worker/src/v4/materialize.rs`'s
        // `resolve_subject_key`) instead interns the referenced entity's
        // RAW `record_id` bytes directly, un-hashed. A caller (`packages/
        // engine/src/canonical-query-data-port.ts`'s `indexedGraphRecords`)
        // always tries a record's `record_id`/`identity_id`/`identity_key`
        // text forms as candidate subject ids, so for a v4-native store the
        // `record_id` form's hex payload -- decoded directly, not hashed --
        // IS the correct lookup key. Trying both candidate keys per input
        // string is safe (an exact `HashMap` key match either hits the
        // real ordinal or it doesn't; there is no way to introduce a false
        // positive), and fixes `core:find_references`/`core:get_outline`/
        // `core:expand_relations`/`core:find_paths`, which silently
        // returned zero edges for every v4 workspace before this fix
        // (verified live via `tests/v4-daemon-e2e.test.ts`: relation
        // records ARE materialized and DO carry the right endpoints, but
        // no adjacency lookup ever found them).
        for subject_text in &subject_ids {
            let mut candidate_keys: Vec<[u8; 32]> = vec![sha256_32(subject_text.as_bytes())];
            if let Some(raw) = parse_hex32(subject_text)
                && raw != candidate_keys[0]
            {
                candidate_keys.push(raw);
            }
            for subject_key in candidate_keys {
                for view in self.reader.adjacency(&subject_key, dir, generation as u64) {
                    let record_id = view.record_id();
                    if !seen.insert(record_id) {
                        continue;
                    }
                    let Some(source_ord) = view.source_subject() else {
                        continue;
                    };
                    let Some(target_ord) = view.target_subject() else {
                        continue;
                    };
                    let source_text = subject_text_for(&self.sidecar, &dicts, source_ord);
                    let target_text = subject_text_for(&self.sidecar, &dicts, target_ord);
                    let relation_kind = view
                        .relation_kind_id()
                        .map(|id| kind_text(&dicts.relation_kinds, id))
                        .unwrap_or_default();
                    let record_id_hex = hex_encode(&record_id);
                    out.push(NativeOutputEdgeRow {
                        edge_id: format!("edge:{record_id_hex}"),
                        source_subject_id: source_text,
                        target_subject_id: target_text,
                        relation_record_id: format!("record:{record_id_hex}"),
                        relation_kind: relation_kind.clone(),
                        role: relation_kind,
                        evidence_class: SYNTHESIZED_EVIDENCE_CLASS.to_string(),
                    });
                }
            }
        }
        Ok(out)
    }

    #[napi]
    pub fn changed_between(&self, g1: u32, g2: u32) -> Result<Vec<NativeChangedEntry>> {
        let dicts = self.reader.dictionaries();
        let entries = self.reader.changed_between(g1 as u64, g2 as u64);
        Ok(entries
            .into_iter()
            .map(|entry| match entry {
                urdira_structural_store::ChangeEntry::Opened(view) => NativeChangedEntry {
                    record_id: format!("record:{}", hex_encode(&view.record_id())),
                    opened: true,
                    row: Some(self.to_output(&view, &dicts)),
                    valid_to: 0,
                },
                urdira_structural_store::ChangeEntry::Closed {
                    record_id,
                    valid_to,
                } => NativeChangedEntry {
                    record_id: format!("record:{}", hex_encode(&record_id)),
                    opened: false,
                    row: None,
                    valid_to,
                },
            })
            .collect())
    }

    #[napi]
    pub fn visible_count(&self, generation: u32) -> u32 {
        self.reader
            .visible_count(generation as u64)
            .min(u32::MAX as u64) as u32
    }

    /// Frente S-G (2026-09-08) root-cause fix, confirmed the dominant
    /// contributor to the n8n full-embed stall
    /// (`docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`):
    /// this USED TO unconditionally re-run the k-way merge from the start
    /// and skip forward past `after_key_hex` on every single call -- O(n)
    /// per batch, so draining the WHOLE visible corpus via repeated calls
    /// (`records_for_query_batches`'s own sequential loop,
    /// `native-query-snapshot-port.ts`) cost O(n^2 / batch_size) total,
    /// independent of worker/shard count (every shard pays its OWN full
    /// O(n^2) enumeration). `visible_cursor` (see its own doc comment)
    /// now recognizes the SEQUENTIAL-DRAIN pattern that is this method's
    /// only real production call shape -- `after_key_hex` equal to the
    /// PREVIOUS call's own last-returned key, same `generation` -- and
    /// resumes the SAME live `VisibleIter` instead of re-scanning, making
    /// a full sequential drain O(n) total. Any call that does not match
    /// that pattern (first call, a different generation, a retried or
    /// non-sequential `after_key_hex`) falls back to the ORIGINAL
    /// re-scan-and-skip behavior below, byte-for-byte -- so this can only
    /// ever be a latency win, never a correctness change: the returned
    /// `rows`/`next_cursor` for a given `(generation, after_key_hex,
    /// batch_size)` are identical whichever path served them.
    #[napi]
    pub fn iter_visible_batch(
        &mut self,
        generation: u32,
        batch_size: u32,
        after_key_hex: Option<String>,
    ) -> Result<NativeVisibleBatch> {
        let (views, next_cursor) = drain_visible_batch(
            &self.reader,
            &mut self.visible_cursor,
            generation as u64,
            batch_size,
            after_key_hex,
        );
        let dicts = self.reader.dictionaries();
        let rows = views
            .iter()
            .map(|view| self.to_output(view, &dicts))
            .collect();
        Ok(NativeVisibleBatch { rows, next_cursor })
    }

    /// Raw `(record_id, record_digest)` leaves, visible-filtered, in
    /// ascending key order -- exactly the entries
    /// `crates/urdira-structural-store/src/merkle.rs`'s `record_entries`
    /// feeds `BucketedMerkleSet::from_sorted` with to build the `records`
    /// set root at publish time. Same O(n)-per-batch cursor shape as
    /// [`Self::iter_visible_batch`] (see that method's doc comment for why
    /// that tradeoff is acceptable at this store's scale); returns raw
    /// bytes rather than decoded rows (see [`NativeDigestBatch`]).
    #[napi]
    pub fn iter_visible_digests(
        &self,
        generation: u32,
        batch_size: u32,
        after_key_hex: Option<String>,
    ) -> Result<NativeDigestBatch> {
        let after_key = after_key_hex.as_deref().and_then(parse_hex32);
        let mut keys = Vec::with_capacity(batch_size as usize * 32);
        let mut digests = Vec::with_capacity(batch_size as usize * 32);
        let mut next_cursor = None;
        let mut skipping = after_key.is_some();
        let mut count = 0u32;
        for view in self.reader.iter_visible(generation as u64) {
            if skipping {
                if view.record_id() == after_key.unwrap() {
                    skipping = false;
                }
                continue;
            }
            if count >= batch_size {
                break;
            }
            let key = view.record_id();
            let digest = view.record_digest();
            keys.extend_from_slice(&key);
            digests.extend_from_slice(&digest);
            next_cursor = Some(hex_encode(&key));
            count += 1;
        }
        if count < batch_size {
            next_cursor = None;
        }
        Ok(NativeDigestBatch {
            keys: Uint8Array::new(keys),
            digests: Uint8Array::new(digests),
            next_cursor,
        })
    }

    /// Same as [`Self::iter_visible_digests`] but restricted to
    /// category-`relation` records -- the `graph` set's own members
    /// (`crates/urdira-indexing-worker/src/v4/publish.rs`'s
    /// `publish_cold` builds its `graph_entries` from exactly this filter
    /// over the same `(record_id, record_digest)` pair). Still a plain
    /// `iter_visible` scan under the hood (this store keeps no separate
    /// relation-only index), so an all-entity generation costs the same
    /// full pass as `iter_visible_digests` -- acceptable here since
    /// `verifyV4Workspace` (the only caller) already pays for one full
    /// `iter_visible_digests` pass per verify run.
    #[napi]
    pub fn iter_visible_graph_digests(
        &self,
        generation: u32,
        batch_size: u32,
        after_key_hex: Option<String>,
    ) -> Result<NativeDigestBatch> {
        let after_key = after_key_hex.as_deref().and_then(parse_hex32);
        let mut keys = Vec::with_capacity(batch_size as usize * 32);
        let mut digests = Vec::with_capacity(batch_size as usize * 32);
        let mut next_cursor = None;
        let mut skipping = after_key.is_some();
        let mut count = 0u32;
        for view in self.reader.iter_visible(generation as u64) {
            if view.category() != CATEGORY_RELATION {
                continue;
            }
            if skipping {
                if view.record_id() == after_key.unwrap() {
                    skipping = false;
                }
                continue;
            }
            if count >= batch_size {
                break;
            }
            let key = view.record_id();
            let digest = view.record_digest();
            keys.extend_from_slice(&key);
            digests.extend_from_slice(&digest);
            next_cursor = Some(hex_encode(&key));
            count += 1;
        }
        if count < batch_size {
            next_cursor = None;
        }
        Ok(NativeDigestBatch {
            keys: Uint8Array::new(keys),
            digests: Uint8Array::new(digests),
            next_cursor,
        })
    }

    /// Raw `(dependency_id, dependency_logical)` leaves, visible-filtered,
    /// in ascending key order -- `dependency_logical` is
    /// `urdira_structural_store::merkle::dependency_logical_view`, the SAME
    /// content-digest recipe `merkle.rs`'s `dependency_entries` uses to
    /// build the `dependency` set root at publish time (there is no
    /// separate `dependency_digest` field in `DependencyRow`/`DependencyView`
    /// -- see that function's own doc comment). `StoreReader::iter_visible_deps`
    /// returns segments concatenated, NOT globally merged by key (unlike
    /// `iter_visible`'s k-way merge over records), so this method sorts
    /// once per call before paging -- acceptable at this store's scale
    /// (dependency counts run far below record counts in every workspace
    /// this port targets; same "O(n) per batch, not O(1)" tradeoff already
    /// documented on [`Self::iter_visible_batch`]).
    #[napi]
    pub fn iter_visible_dependency_digests(
        &self,
        generation: u32,
        batch_size: u32,
        after_key_hex: Option<String>,
    ) -> Result<NativeDigestBatch> {
        let after_key = after_key_hex.as_deref().and_then(parse_hex32);
        let mut entries: Vec<([u8; 32], [u8; 32])> = self
            .reader
            .iter_visible_deps(generation as u64)
            .iter()
            .map(|view| (view.dependency_id(), dependency_logical_view(view)))
            .collect();
        entries.sort_unstable_by_key(|(key, _)| *key);

        let mut keys = Vec::with_capacity(batch_size as usize * 32);
        let mut digests = Vec::with_capacity(batch_size as usize * 32);
        let mut next_cursor = None;
        let mut skipping = after_key.is_some();
        let mut count = 0u32;
        for (key, digest) in entries {
            if skipping {
                if key == after_key.unwrap() {
                    skipping = false;
                }
                continue;
            }
            if count >= batch_size {
                break;
            }
            keys.extend_from_slice(&key);
            digests.extend_from_slice(&digest);
            next_cursor = Some(hex_encode(&key));
            count += 1;
        }
        if count < batch_size {
            next_cursor = None;
        }
        Ok(NativeDigestBatch {
            keys: Uint8Array::new(keys),
            digests: Uint8Array::new(digests),
            next_cursor,
        })
    }

    fn to_dep_output(
        &self,
        view: &urdira_structural_store::DependencyView,
        dicts: &Dictionaries,
    ) -> NativeOutputDependencyRow {
        let (owner_artifact_id, owner_artifact_version_id) =
            artifact_text(dicts, view.owner_artifact());
        let (dep_artifact_id, dep_artifact_version_id) = artifact_text(dicts, view.dep_artifact());
        let dependency_role = self
            .sidecar
            .dep_roles
            .get(view.role() as usize)
            .cloned()
            .unwrap_or_default();
        let dependency_id_hex = hex_encode(&view.dependency_id());
        NativeOutputDependencyRow {
            record_id: self
                .sidecar
                .dep_record_ids
                .get(&dependency_id_hex)
                .map(|hex| format!("record:{hex}")),
            owner_artifact_id,
            owner_artifact_version_id,
            dependency_artifact_id: dep_artifact_id,
            dependency_artifact_version_id: dep_artifact_version_id,
            dependency_role,
        }
    }

    #[napi]
    pub fn deps_by_owner(
        &self,
        owner_artifact_ordinal: u32,
        generation: u32,
    ) -> Result<Vec<NativeOutputDependencyRow>> {
        let dicts = self.reader.dictionaries();
        Ok(self
            .reader
            .deps_by_owner(owner_artifact_ordinal, generation as u64)
            .iter()
            .map(|v| self.to_dep_output(v, &dicts))
            .collect())
    }

    #[napi]
    pub fn deps_reverse(
        &self,
        dep_artifact_ordinal: u32,
        generation: u32,
    ) -> Result<Vec<NativeOutputDependencyRow>> {
        let dicts = self.reader.dictionaries();
        Ok(self
            .reader
            .deps_reverse(dep_artifact_ordinal, generation as u64)
            .iter()
            .map(|v| self.to_dep_output(v, &dicts))
            .collect())
    }

    /// Every visible `pending.sites` row owned by `owner_artifact_ordinal`
    /// at `generation` (`StoreReader::pending_sites_by_owner`), for
    /// `core:get_outline`'s additive `pending_sites` stream. Mirrors
    /// `deps_by_owner`'s ordinal-in/rows-out shape exactly: the caller
    /// (`packages/engine/src/native-query-snapshot-port.ts`) resolves an
    /// artifact id/version to an ordinal via `dictionaries().artifacts`
    /// first (same `findArtifactOrdinal` pattern `container_records_by_artifact_references`
    /// already uses), then calls this. The actual row-mapping logic lives
    /// in the plain (non-napi-`Result`) `pending_site_rows_for_owner`
    /// below purely so it can be exercised by a `#[cfg(test)]` unit test
    /// without linking the N-API host runtime -- see that function's doc
    /// comment.
    #[napi]
    pub fn pending_sites_by_owner(
        &self,
        owner_artifact_ordinal: u32,
        generation: u32,
    ) -> Result<Vec<NativeOutputPendingSiteRow>> {
        Ok(pending_site_rows_for_owner(
            &self.reader,
            owner_artifact_ordinal,
            generation as u64,
        ))
    }
}

/// Frente S-G (2026-09-08) root-cause fix: the cursor-reuse core of
/// [`NativeStructuralStoreHandle::iter_visible_batch`], factored out as a
/// plain function (same `napi::Result`-avoidance rationale as
/// `pending_site_rows_for_owner`'s own doc comment below -- this lets a
/// `#[cfg(test)]` unit test exercise it directly, without a `#[napi]`
/// method's `Result<T>` requiring host glue to link). Takes the SAME
/// `(generation, last_served_key_hex, iterator)` cursor slot the napi
/// method stores on `self`, so the two are byte-for-byte the same logic --
/// this is not a reimplementation the method wraps, it IS the method's own
/// body. See `NativeStructuralStoreHandle::visible_cursor`'s own doc
/// comment for the full O(n^2)-per-drain problem this closes and why a
/// cache MISS can only ever be slower, never wrong.
fn drain_visible_batch(
    reader: &StoreReader,
    cursor_slot: &mut Option<(u64, Option<String>, VisibleIter)>,
    generation: u64,
    batch_size: u32,
    after_key_hex: Option<String>,
) -> (Vec<RecordView>, Option<String>) {
    let cached = cursor_slot.take();
    let mut iter = match cached {
        Some((cached_gen, cached_after, cached_iter))
            if cached_gen == generation && cached_after == after_key_hex =>
        {
            cached_iter
        }
        _ => {
            // Fallback: the ORIGINAL correct-but-O(n)-per-batch shape -- a
            // fresh k-way merge, skipped forward to `after_key_hex`. Taken
            // on the first call, a generation change, or any non-sequential
            // access pattern -- always correct, only ever slower than the
            // cache hit above.
            let after_key = after_key_hex.as_deref().and_then(parse_hex32);
            let mut fresh = reader.iter_visible(generation);
            if let Some(target) = after_key {
                for view in fresh.by_ref() {
                    if view.record_id() == target {
                        break;
                    }
                }
            }
            fresh
        }
    };
    let mut rows = Vec::with_capacity(batch_size as usize);
    let mut last_key_hex = after_key_hex;
    for _ in 0..batch_size {
        match iter.next() {
            Some(view) => {
                last_key_hex = Some(hex_encode(&view.record_id()));
                rows.push(view);
            }
            None => break,
        }
    }
    let exhausted = rows.len() < batch_size as usize;
    let next_cursor = if exhausted {
        None
    } else {
        last_key_hex.clone()
    };
    if !exhausted {
        *cursor_slot = Some((generation, last_key_hex, iter));
    }
    (rows, next_cursor)
}

/// The row-mapping logic `pending_sites_by_owner` exposes over napi,
/// factored out as a plain function returning a normal `Vec` (no
/// `napi::Result`/`napi::Error` in its signature) so `#[cfg(test)]` unit
/// tests below can call it directly: this crate has no `[lib]` target
/// (`crate-type = ["cdylib"]` only, built for loading into a running
/// Node.js process), and a standalone Rust test binary that instantiates
/// `napi::Result<T>`'s `Drop`/error-reference glue fails to link (no
/// `_napi_*` host symbols to resolve outside Node) even though the
/// SUCCESS path never touches them at runtime -- the linker still has to
/// resolve every symbol the compiled code statically references. Calling
/// this function instead of `NativeStructuralStoreHandle::pending_sites_by_owner`
/// (or `NativeStructuralStoreHandle::open`, whose own `Result<Self>` has
/// the same problem) avoids ever instantiating that glue.
fn pending_site_rows_for_owner(
    reader: &StoreReader,
    owner_artifact_ordinal: u32,
    generation: u64,
) -> Vec<NativeOutputPendingSiteRow> {
    let dicts = reader.dictionaries();
    reader
        .pending_sites_by_owner(owner_artifact_ordinal, generation)
        .iter()
        .map(|view| {
            let source_id = view.source_subject().and_then(|ordinal| {
                dicts
                    .subjects
                    .get(ordinal as usize)
                    .and_then(|record_id| reader.get_visible(record_id, generation))
                    .map(|source_view| {
                        String::from_utf8_lossy(&source_view.identity_key()).into_owned()
                    })
            });
            NativeOutputPendingSiteRow {
                start: view.start(),
                end: view.end(),
                site_kind: pending_site_kind_text(view.site_kind()).to_string(),
                reason: pending_reason_text(view.reason()).to_string(),
                source_id,
            }
        })
        .collect()
}

/// Napi-level `pending_sites_by_owner` coverage: ordinal-scoped filtering,
/// `site_kind`/`reason` text mapping, and the `source_subject ->
/// dicts.subjects[ordinal] -> get_visible -> identity_key` resolution
/// chain (including "no source" and "wrong owner excluded"). Built with
/// `urdira_structural_store`'s own public write API directly (this crate
/// has no `[lib]` target -- `crate-type = ["cdylib"]` only -- so these are
/// `#[cfg(test)]` unit tests in this module, not a separate `tests/*.rs`
/// integration binary, which could not link against it).
#[cfg(test)]
mod pending_sites_by_owner_tests {
    use super::{
        Dictionaries, NONE_U16, NONE_U32, NativeOutputPendingSiteRow, RecordRow,
        pending_site_rows_for_owner,
    };
    use sha2::{Digest, Sha256};
    use urdira_structural_store::{
        CATEGORY_ENTITY, PENDING_SITE_KIND_CALL, PENDING_SITE_KIND_IMPLEMENTS,
        PENDING_SITE_KIND_INHERITS, PendingSiteRow, SegmentWriter, StoreReader,
    };

    fn digest_of(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "urdira-native-node-pending-sites-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rows_by_start(rows: &mut [NativeOutputPendingSiteRow]) {
        rows.sort_by_key(|row| row.start);
    }

    /// Builds a tiny two-artifact store with one confirmed "source" entity
    /// and three pending sites (two owned by artifact ordinal 0, one by
    /// ordinal 1), then verifies the full napi-level chain end to end.
    #[test]
    fn pending_sites_by_owner_resolves_source_identity_and_filters_by_owner() {
        let dir = tmp_dir("pending-sites");
        let generation: u32 = 1;
        let source_record_id = digest_of(b"jsts:method:src/a.ts:10:foo");
        let identity_key = b"jsts:method:src/a.ts:10:foo".to_vec();
        let body = b"{}".to_vec();
        let record_digest = digest_of(&body);
        let identity_key_digest = digest_of(&identity_key);

        let dicts = Dictionaries {
            kinds: vec!["jsts:entity_declaration".to_string()],
            universal_kinds: vec!["core:declaration".to_string()],
            relation_kinds: vec!["call".to_string()],
            names: vec!["foo".to_string()],
            subjects: vec![source_record_id],
            artifacts: vec![
                ("artifact:a".to_string(), "artifact-version:a".to_string()),
                ("artifact:b".to_string(), "artifact-version:b".to_string()),
            ],
            facet_names: Vec::new(),
            subject_text: Vec::new(),
            artifact_paths: Vec::new(),
            entity_kinds: Vec::new(),
        };

        let source_row = RecordRow {
            record_id: source_record_id,
            owner_artifact: 0,
            owner_version: 0,
            valid_from: generation,
            valid_to: 0,
            category: CATEGORY_ENTITY,
            kind_id: 0,
            universal_kind_id: 0,
            facets: 0,
            span_artifact_version: 0,
            span_start_byte: 0,
            span_end_byte: 0,
            // A4 (line numbers task): this synthetic test row carries no
            // real span, so "no line known" (`NONE_U32`) is the correct
            // sentinel -- matches what napi's `opt_u32_text` treats as
            // `None` (see that function's own doc comment).
            span_start_line: NONE_U32,
            span_end_line: NONE_U32,
            identity_type: 0,
            assignment_kind: 0,
            name_id: 0,
            identity_key,
            record_digest,
            body_digest: record_digest,
            identity_id: identity_key_digest,
            identity_key_digest,
            previous_record_id: [0u8; 32],
            source_subject: None,
            target_subject: None,
            relation_kind_id: NONE_U16,
            body,
        };

        let pending_sites = vec![
            PendingSiteRow {
                owner_artifact: 0,
                owner_version: 0,
                valid_from: generation,
                valid_to: 0,
                start: 100,
                end: 140,
                start_line: 4,
                end_line: 4,
                site_kind: PENDING_SITE_KIND_CALL,
                reason: 1, // call_deferred_to_e3
                source_subject: Some(0),
            },
            PendingSiteRow {
                owner_artifact: 0,
                owner_version: 0,
                valid_from: generation,
                valid_to: 0,
                start: 200,
                end: 230,
                start_line: 9,
                end_line: 9,
                site_kind: PENDING_SITE_KIND_INHERITS,
                reason: 6, // heritage_unresolved
                source_subject: None,
            },
            PendingSiteRow {
                owner_artifact: 1,
                owner_version: 0,
                valid_from: generation,
                valid_to: 0,
                start: 5,
                end: 9,
                start_line: 0,
                end_line: 0,
                site_kind: PENDING_SITE_KIND_IMPLEMENTS,
                reason: 8, // heritage_target_uncertain
                source_subject: None,
            },
        ];

        SegmentWriter::new()
            .write_base_with_pending(
                &dir,
                &[source_row],
                &[],
                &dicts,
                generation as u64,
                &pending_sites,
            )
            .expect("write_base_with_pending");

        // `StoreReader::open` directly (not `NativeStructuralStoreHandle::open`)
        // and `pending_site_rows_for_owner` directly (not the `#[napi]`
        // `pending_sites_by_owner` method that wraps it in `napi::Result`)
        // -- see `pending_site_rows_for_owner`'s doc comment for why: this
        // crate has no `[lib]` target, and a standalone test binary that
        // instantiates `napi::Result`/`napi::Error` fails to link outside
        // a running Node.js host.
        let reader = StoreReader::open(&dir).expect("open");

        // Artifact id/version -> ordinal, the same `dictionaries().artifacts`
        // scan the TS caller (`findArtifactOrdinal`,
        // `native-query-snapshot-port.ts`) performs before calling
        // `pending_sites_by_owner`.
        let dicts_out = reader.dictionaries();
        let ordinal = dicts_out
            .artifacts
            .iter()
            .position(|pair| pair.0 == "artifact:a" && pair.1 == "artifact-version:a")
            .expect("artifact ordinal") as u32;
        assert_eq!(ordinal, 0);

        let mut rows: Vec<NativeOutputPendingSiteRow> =
            pending_site_rows_for_owner(&reader, ordinal, generation as u64);
        rows_by_start(&mut rows);
        assert_eq!(
            rows.len(),
            2,
            "only artifact 0's two sites, not artifact 1's"
        );

        assert_eq!(rows[0].start, 100);
        assert_eq!(rows[0].end, 140);
        assert_eq!(rows[0].site_kind, "call");
        assert_eq!(rows[0].reason, "call_deferred_to_e3");
        assert_eq!(
            rows[0].source_id.as_deref(),
            Some("jsts:method:src/a.ts:10:foo")
        );

        assert_eq!(rows[1].start, 200);
        assert_eq!(rows[1].site_kind, "inherits");
        assert_eq!(rows[1].reason, "heritage_unresolved");
        assert_eq!(rows[1].source_id, None);

        let other = pending_site_rows_for_owner(&reader, 1, generation as u64);
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].site_kind, "implements");
        assert_eq!(other[0].reason, "heritage_target_uncertain");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Frente S-G (2026-09-08): coverage for `drain_visible_batch`'s cursor-
/// reuse fast path AND its fallback -- the fix for the confirmed n8n
/// full-embed stall root cause (a full O(n) re-scan-and-skip on EVERY
/// page, `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`).
/// Same `napi::Result`-avoidance rationale as `pending_sites_by_owner_tests`
/// (this crate has no `[lib]` target) -- built directly against
/// `urdira_structural_store`'s own public write API and `StoreReader::open`,
/// never `NativeStructuralStoreHandle`.
#[cfg(test)]
mod drain_visible_batch_tests {
    use super::{Dictionaries, NONE_U16, NONE_U32, VisibleIter, drain_visible_batch};
    use sha2::{Digest, Sha256};
    use urdira_structural_store::{CATEGORY_ENTITY, RecordRow, SegmentWriter, StoreReader};

    fn digest_of(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "urdira-native-node-visible-batch-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_record(identity_key: &[u8], generation: u32) -> RecordRow {
        let record_id = digest_of(identity_key);
        let record_digest = digest_of(b"body");
        let identity_key_digest = digest_of(identity_key);
        RecordRow {
            record_id,
            owner_artifact: 0,
            owner_version: 0,
            valid_from: generation,
            valid_to: 0,
            category: CATEGORY_ENTITY,
            kind_id: 0,
            universal_kind_id: 0,
            facets: 0,
            span_artifact_version: 0,
            span_start_byte: 0,
            span_end_byte: 0,
            span_start_line: NONE_U32,
            span_end_line: NONE_U32,
            identity_type: 0,
            assignment_kind: 0,
            name_id: 0,
            identity_key: identity_key.to_vec(),
            record_digest,
            body_digest: record_digest,
            identity_id: identity_key_digest,
            identity_key_digest,
            previous_record_id: [0u8; 32],
            source_subject: None,
            target_subject: None,
            relation_kind_id: NONE_U16,
            body: b"{}".to_vec(),
        }
    }

    /// Builds a 5-record store and drains it two rows at a time via
    /// `drain_visible_batch`, always passing the PREVIOUS call's own
    /// `next_cursor` back in -- exactly `records_for_query_batches`'s own
    /// real sequential-drain call shape. Every record must be returned,
    /// in ascending key order, with no duplicates -- correct whichever
    /// internal path (cache hit or fallback) actually served each call.
    #[test]
    fn sequential_drain_with_chained_cursor_returns_every_record_once_in_order() {
        let dir = tmp_dir("sequential");
        let generation: u32 = 1;
        let records: Vec<RecordRow> = (0..5)
            .map(|index| make_record(format!("entity-{index}").as_bytes(), generation))
            .collect();
        let dicts = Dictionaries {
            kinds: vec!["jsts:entity_declaration".to_string()],
            universal_kinds: vec!["core:declaration".to_string()],
            relation_kinds: Vec::new(),
            names: Vec::new(),
            subjects: Vec::new(),
            artifacts: vec![("artifact:a".to_string(), "artifact-version:a".to_string())],
            facet_names: Vec::new(),
            subject_text: Vec::new(),
            artifact_paths: Vec::new(),
            entity_kinds: Vec::new(),
        };
        SegmentWriter::new()
            .write_base_with_pending(&dir, &records, &[], &dicts, generation as u64, &[])
            .expect("write_base_with_pending");
        let reader = StoreReader::open(&dir).expect("open");

        let mut cursor: Option<(u64, Option<String>, VisibleIter)> = None;
        let mut after_key: Option<String> = None;
        let mut collected: Vec<[u8; 32]> = Vec::new();
        loop {
            let (views, next_cursor) = drain_visible_batch(
                &reader,
                &mut cursor,
                generation as u64,
                2,
                after_key.clone(),
            );
            if views.is_empty() {
                break;
            }
            collected.extend(views.iter().map(|view| view.record_id()));
            if next_cursor.is_none() {
                break;
            }
            after_key = next_cursor;
        }

        assert_eq!(collected.len(), 5, "every record returned exactly once");
        let mut expected: Vec<[u8; 32]> = records.iter().map(|row| row.record_id).collect();
        expected.sort();
        let mut actual = collected.clone();
        actual.sort();
        assert_eq!(actual, expected, "same record set, order-independent check");
        // Ascending key order (the k-way merge's own documented contract),
        // preserved across the cache-hit AND fallback paths alike.
        let mut sorted_collected = collected.clone();
        sorted_collected.sort();
        assert_eq!(
            collected, sorted_collected,
            "records arrive in ascending key order"
        );
    }

    /// A call whose `after_key_hex` does NOT match the cached cursor's own
    /// position (a different generation here) must fall back to a fresh
    /// scan rather than silently resuming from the wrong place or
    /// returning a cache-stale answer -- the whole safety property that
    /// makes the cache-hit fast path a pure optimization, never a
    /// correctness requirement.
    #[test]
    fn a_cursor_mismatch_falls_back_to_a_correct_fresh_scan_instead_of_reusing_the_wrong_state() {
        let dir = tmp_dir("mismatch");
        let generation: u32 = 1;
        let records: Vec<RecordRow> = (0..3)
            .map(|index| make_record(format!("entity-{index}").as_bytes(), generation))
            .collect();
        let dicts = Dictionaries {
            kinds: vec!["jsts:entity_declaration".to_string()],
            universal_kinds: vec!["core:declaration".to_string()],
            relation_kinds: Vec::new(),
            names: Vec::new(),
            subjects: Vec::new(),
            artifacts: vec![("artifact:a".to_string(), "artifact-version:a".to_string())],
            facet_names: Vec::new(),
            subject_text: Vec::new(),
            artifact_paths: Vec::new(),
            entity_kinds: Vec::new(),
        };
        SegmentWriter::new()
            .write_base_with_pending(&dir, &records, &[], &dicts, generation as u64, &[])
            .expect("write_base_with_pending");
        let reader = StoreReader::open(&dir).expect("open");

        let mut cursor: Option<(u64, Option<String>, VisibleIter)> = None;
        // Prime the cache with a partial drain (1 of 3 rows) at generation 1.
        let (first_views, first_cursor) =
            drain_visible_batch(&reader, &mut cursor, generation as u64, 1, None);
        assert_eq!(first_views.len(), 1);
        assert!(cursor.is_some(), "a non-exhausted drain caches its cursor");

        // A call whose `after_key_hex` does NOT match the cached cursor's
        // own last-served key (a genuinely bogus key here, standing in for
        // "some other, non-sequential caller") is a cache MISS -- the
        // cached iterator, already positioned past record 1, must be
        // DISCARDED rather than reused for this different request. No
        // record's key is all-zero, so the ORIGINAL "skip forward to
        // after_key_hex" semantics (preserved byte-for-byte in the
        // fallback branch: a key that is never found means "skip
        // everything") correctly yield ZERO rows here -- the SAME answer
        // the pre-fix implementation always gave for a never-matching
        // `after_key_hex`, never a wrong resume from the stale cached
        // position and never a panic.
        let bogus_after = Some(format!("{:064x}", 0u8));
        let (mismatched_views, _) =
            drain_visible_batch(&reader, &mut cursor, generation as u64, 10, bogus_after);
        assert_eq!(
            mismatched_views.len(),
            0,
            "cache miss falls back to the ORIGINAL skip-to-after_key semantics, not a reuse of the stale cached position"
        );

        // The mismatched call above exhausted its own fresh scan, clearing
        // the cache slot entirely -- continuing the ORIGINAL sequential
        // chain from `first_cursor` afterward still returns the correct
        // remaining rows: the earlier mismatch left no corrupted or stale
        // state behind for a later, properly-chained call to trip over.
        let (resumed_views, resumed_cursor) =
            drain_visible_batch(&reader, &mut cursor, generation as u64, 10, first_cursor);
        assert_eq!(
            resumed_views.len(),
            2,
            "the original chain still yields the correct remaining rows"
        );
        assert!(resumed_cursor.is_none());
    }
}
