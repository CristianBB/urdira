#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fmt::{self, Write as _};

pub const MAX_BATCH_RECORDS: usize = 4_096;
pub const MAX_BATCH_FRAMED_BYTES: usize = 4 * 1024 * 1024;
const MAX_LOGICAL_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralKernelRecord {
    pub proposal_record_key: String,
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub facets: String,
    pub schema_version: u32,
    pub source_span: String,
    pub identity_key: String,
    pub body: Value,
    pub evidence_references: String,
}

/// P2-2g item 3: a borrowed view over exactly the fields the kernel's
/// digest/canonicalization pass reads (`structural_record_digest_hash`,
/// `canonical_nested_record_fields`, `structural_kernel_row`) -- same field
/// set as [`StructuralKernelRecord`], `&str`/`&Value` instead of owned
/// `String`/`Value`. Exists so a caller that already owns these fields
/// inside a larger structure (`urdira-indexing-worker`'s v4 materialize
/// pass, holding `ProposedRecord`s) can feed the kernel directly, without
/// first cloning every field into a temporary owned `StructuralKernelRecord`
/// per record. `StructuralKernelRecord::as_ref` below produces one of these
/// trivially, and every existing owned-input entrypoint
/// (`structural_kernel_rows`, `structural_kernel_batch_parts`, ...) is
/// rewritten in terms of the ref-based core functions so there is exactly
/// one digest/canonicalization implementation, never two that could drift.
///
/// A3b coste 2: no longer `Copy` -- [`BodyRef`] gained an owned
/// (`EncodedOwned`) variant, so this struct can no longer be `Copy` either
/// (a `Vec<u8>` inside is never `Copy`). Every existing borrowed-body caller
/// (`BodyRef::Value`/`Encoded`, both still plain references) still gets a
/// trivially cheap `.clone()` wherever the old `Copy` derive used to supply
/// an implicit copy -- see `structural_kernel_rows_ref`/`_typed`'s own hot
/// loops, which now `.clone()` once per record instead of relying on
/// pattern-match-copy.
#[derive(Debug, Clone)]
pub struct StructuralKernelRecordRef<'a> {
    pub proposal_record_key: &'a str,
    pub category: &'a str,
    pub kind: &'a str,
    pub universal_kind: &'a str,
    pub facets: &'a str,
    pub schema_version: u32,
    pub source_span: &'a str,
    pub identity_key: &'a str,
    pub body: BodyRef<'a>,
    pub evidence_references: &'a str,
}

/// A3b: a borrowed view over a record's body that lets
/// [`structural_kernel_row`] take either the original `serde_json::Value`
/// tree (`Value`, the v3/legacy shape and every not-yet-migrated producer's
/// shape) or an already-[`BodyEncoder`]-built [`EncodedBody`] (`Encoded`,
/// the v4 hot-path producers' shape) without cloning or converting between
/// them. For `Value`, the kernel still walks the tree via [`fused_body_pass`]
/// exactly as before this task. For `Encoded`, the kernel skips that walk
/// entirely: the payload bytes, `body_digest`, and `body_byte_length` were
/// already produced, once, by the producer itself, and the whole-record
/// digest is fed the identical byte sequence via `record_hash.update(&
/// encoded.payload)` -- byte-identical to what feeding the same bytes
/// through `fused_body_pass` node-by-node would have produced, since
/// `Sha256::update` is purely sequential. See `encoded_body_matches_value_
/// body_oracle` (this crate's tests) for the equivalence proof.
///
/// A3b coste 2: a third variant, `EncodedOwned`, holds an `EncodedBody` BY
/// VALUE rather than by reference -- for a caller that owns its
/// `ProposedRecord`s outright (`urdira-indexing-worker`'s v4
/// `canonicalize_owner`) and can therefore MOVE an `Encoded` body's payload
/// straight into `StructuralKernelRow.body` (`structural_kernel_row`'s
/// `EncodedOwned` arm) instead of paying `encoded.payload.clone()` the way
/// the borrowed `Encoded` arm must. This is the reason `BodyRef` (and, by
/// extension, `StructuralKernelRecordRef`) can no longer derive `Copy`: a
/// `Vec<u8>`-holding variant is never `Copy`. Produced only by
/// `structural_kernel_rows_owned_typed`'s caller -- `StructuralKernelRecord::
/// as_ref` and every other existing constructor still only ever builds
/// `Value`/`Encoded`.
#[derive(Debug, Clone)]
pub enum BodyRef<'a> {
    Value(&'a Value),
    Encoded(&'a EncodedBody),
    EncodedOwned(EncodedBody),
}

impl StructuralKernelRecord {
    /// Borrows every field this record owns into a [`StructuralKernelRecordRef`].
    pub fn as_ref(&self) -> StructuralKernelRecordRef<'_> {
        StructuralKernelRecordRef {
            proposal_record_key: &self.proposal_record_key,
            category: &self.category,
            kind: &self.kind,
            universal_kind: &self.universal_kind,
            facets: &self.facets,
            schema_version: self.schema_version,
            source_span: &self.source_span,
            identity_key: &self.identity_key,
            body: BodyRef::Value(&self.body),
            evidence_references: &self.evidence_references,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralKernelDependency {
    pub proposed_dependency_id: String,
    pub proposal_record_key: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
    pub dependency_role: String,
    pub dependency_basis: String,
    pub source_reference: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralKernelBatch {
    pub records: Vec<StructuralKernelRecord>,
    pub dependencies: Vec<StructuralKernelDependency>,
}

/// Core-side representation of a producer-sealed structural batch. The host
/// keeps these rows opaque: Rust parses, rejects non-canonical bytes and then
/// runs the identical typed kernel used by the ordinary object entrypoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralKernelCanonicalBatch {
    pub canonical_records: Vec<String>,
    pub canonical_dependencies: Vec<String>,
    pub record_definitions: Vec<StructuralRecordDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralRecordDefinition {
    pub kind: String,
    pub category: String,
    pub universal_kind: String,
    pub schema_version: u32,
    pub allowed_facets: Vec<String>,
    #[serde(default)]
    pub required_facets: Vec<String>,
    #[serde(default)]
    pub body_schema: Option<StructuralPayloadSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuralPayloadSchema {
    #[serde(rename = "type")]
    pub value_type: String,
    #[serde(default, rename = "additionalProperties")]
    pub additional_properties: Option<bool>,
    pub properties: HashMap<String, StructuralPayloadProperty>,
    pub required: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuralPayloadProperty {
    #[serde(rename = "type")]
    pub value_type: String,
    #[serde(default)]
    pub r#enum: Option<Vec<String>>,
    #[serde(default)]
    pub items: Option<Box<StructuralPayloadProperty>>,
    #[serde(default)]
    pub properties: Option<HashMap<String, StructuralPayloadProperty>>,
    #[serde(default)]
    pub required: Option<Vec<String>>,
    #[serde(default)]
    pub minimum: Option<i64>,
    #[serde(default)]
    pub maximum: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralAcceptedRecord {
    pub proposal_record_key: String,
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub schema_version: u32,
    pub identity_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuralKernelCanonicalResult {
    pub kernel: StructuralKernelResult,
    pub records: Vec<StructuralAcceptedRecord>,
    pub dependencies: Vec<StructuralKernelDependency>,
    pub record_schema_attestations: Vec<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralKernelResult {
    pub canonical_records: Vec<String>,
    pub canonical_dependencies: Vec<String>,
    pub record_facets: Vec<Option<Vec<String>>>,
    pub record_structural_attestations: Vec<bool>,
    pub record_digests: Vec<String>,
    pub record_ids: Vec<String>,
    pub publication_records: Vec<StructuralPublicationRecord>,
    pub record_body_payload_hexes: Vec<String>,
    pub publication_descriptor: StructuralPublicationDescriptor,
    pub records_digest: String,
    pub dependencies_digest: String,
    pub canonical_byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralKernelSealResult {
    pub canonical_records: Vec<String>,
    pub canonical_dependencies: Vec<String>,
    pub canonical_byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralPublicationRecord {
    pub record_id: String,
    pub record_digest: String,
    pub body_digest: String,
    pub body_byte_length: usize,
    pub schema_version: u32,
    pub facets: Vec<String>,
    pub primary_source_span: Option<Value>,
    pub identity_type: String,
    pub identity_key: String,
    pub identity_id: String,
    pub identity_key_digest: String,
    pub identity_assignment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralPublicationDescriptor {
    pub record_count: usize,
    pub body_byte_length: usize,
    pub first_record_id: Option<String>,
    pub last_record_id: Option<String>,
    pub sequence_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCoreError {
    message: String,
}

impl NativeCoreError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for NativeCoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for NativeCoreError {}

pub type NativeCoreResult<T> = Result<T, NativeCoreError>;

fn update_varint(hash: &mut Sha256, mut value: usize) {
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        hash.update([byte]);
        if value == 0 {
            break;
        }
    }
}

fn update_uce_text(hash: &mut Sha256, value: &str) {
    hash.update([3]);
    update_varint(hash, value.len());
    hash.update(value.as_bytes());
}

/// P2-2l item 3: depth bound unified to [`MAX_LOGICAL_DEPTH`] (64), matching
/// [`encode_publication_body`]'s own limit -- this function used to allow
/// twice the depth (128). P2-2k found and documented that divergence as a
/// blocker to fusing this traversal with `encode_publication_body`'s own
/// walk of the SAME `record.body` tree: for a value nested to depth 65-128,
/// `structural_record_digest_hash` (via this function) would previously
/// succeed while `encode_publication_body` already failed, so a record at
/// that depth was rejected EITHER WAY (by `structural_kernel_row`'s call to
/// `encode_publication_body`, downstream of a digest that had already
/// succeeded) -- the only actual divergence was which function's error
/// MESSAGE reached the caller, never whether the record was ultimately
/// accepted. No real `ProposedRecord` this pipeline's producers emit
/// nests anywhere near depth 64 (confirmed live: every n8n cold scan
/// processes 2.83M records with zero depth-related rejections), so
/// tightening this bound has no observed effect on any real input --
/// verified directly (not just argued) by `depth_boundary_*` in this
/// module's own test suite, which checks both functions agree at depths
/// 63/64/65/128/129. This is a prerequisite for [`fused_body_pass`]: with
/// both traversals sharing one depth threshold, a single fused pass can
/// check depth once per node instead of needing to reconcile two
/// different limits.
fn update_uce_value(hash: &mut Sha256, value: &Value, depth: usize) -> NativeCoreResult<()> {
    if depth > MAX_LOGICAL_DEPTH {
        return Err(NativeCoreError::new(
            "Structural kernel UCE value exceeds the maximum depth.",
        ));
    }
    match value {
        Value::Null => hash.update([0]),
        Value::Bool(false) => hash.update([1]),
        Value::Bool(true) => hash.update([2]),
        Value::String(value) => update_uce_text(hash, value),
        Value::Number(value) => {
            let number = value.as_f64().ok_or_else(|| {
                NativeCoreError::new("Structural kernel UCE number is not finite.")
            })?;
            if !number.is_finite() {
                return Err(NativeCoreError::new(
                    "Structural kernel UCE number is not finite.",
                ));
            }
            hash.update([7]);
            hash.update(if number == 0.0 {
                0.0f64.to_be_bytes()
            } else {
                number.to_be_bytes()
            });
        }
        Value::Array(values) => {
            hash.update([5]);
            update_varint(hash, values.len());
            for value in values {
                update_uce_value(hash, value, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            // P2-2k: `Value::Object` is a `serde_json::Map` backed by
            // `BTreeMap<String, Value>` in this build (the workspace never
            // enables serde_json's `preserve_order` feature -- confirmed
            // both by `Cargo.lock` carrying a single unified `serde_json`
            // entry with no `preserve_order` anywhere, and live via
            // profiling the n8n cold scan: leaf samples resolve straight
            // into `alloc::collections::btree::map::Iter::next`). A
            // `BTreeMap`'s `iter()` already yields entries in ascending
            // key order via `Ord for str`, which compares the UTF-8 byte
            // sequence directly -- byte-for-byte identical to the
            // `sort_by(|l, r| l.as_bytes().cmp(r.as_bytes()))` this used to
            // do explicitly. Iterating `fields` directly skips a
            // `Vec<&String>` allocation + a redundant sort + a second
            // `fields.get(key)` lookup per JSON object, for every nested
            // object in every record's body -- this profiled as one of
            // Pass 1's largest single costs (see P2-2k's evidence entry).
            hash.update([6]);
            update_varint(hash, fields.len());
            for (key, value) in fields {
                update_uce_text(hash, key);
                update_uce_value(hash, value, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn sha256_text(hash: Sha256) -> String {
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in hash.finalize() {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

/// P2-2f bytes-native counterpart of [`sha256_text`]: finalizes into
/// `[u8; 32]` directly, with no `sha256:`-prefixed hex `String` ever built.
fn sha256_bytes(hash: Sha256) -> [u8; 32] {
    hash.finalize().into()
}

fn update_uce_key_value_text(hash: &mut Sha256, key: &str, value: &str) {
    update_uce_text(hash, key);
    update_uce_text(hash, value);
}

/// Shared hash-building step behind [`structural_record_digest`] (text
/// output, used by the v3/N-API JSON kernel path). P2-2l item 3: the
/// bytes-native v4 hot path (`structural_kernel_rows`/`_typed`) no longer
/// calls this at all -- `structural_kernel_row` now builds its own
/// equivalent hash inline, sharing ONE traversal of `record.body` with
/// body-payload encoding via `fused_body_pass` instead of calling this
/// function (which walks `record.body` via `update_uce_value`) separately
/// beforehand. The former `structural_record_digest_bytes` bytes-native
/// wrapper around this function was deleted as dead code once its one
/// caller (`structural_kernel_rows_ref`) switched to the fused path.
fn structural_record_digest_hash(
    record: StructuralKernelRecordRef<'_>,
) -> NativeCoreResult<Sha256> {
    // Same byte ordering as UCE over serde_json::to_value(record), without
    // allocating and walking a second generic object graph.
    let mut hash = Sha256::new();
    hash.update([6]);
    update_varint(&mut hash, 10);
    update_uce_text(&mut hash, "body");
    match record.body {
        BodyRef::Value(value) => update_uce_value(&mut hash, value, 1)?,
        // `StructuralKernelRecord::as_ref` (this function's only caller,
        // via `structural_record_digest`) always produces `BodyRef::Value`
        // -- `StructuralKernelRecord.body` is still a plain `Value` field,
        // untouched by this task (the v3/N-API path this function serves).
        BodyRef::Encoded(_) | BodyRef::EncodedOwned(_) => {
            return Err(NativeCoreError::new(
                "structural_record_digest_hash does not support an already-encoded body.",
            ));
        }
    }
    update_uce_key_value_text(&mut hash, "category", record.category);
    update_uce_key_value_text(&mut hash, "evidence_references", record.evidence_references);
    update_uce_key_value_text(&mut hash, "facets", record.facets);
    update_uce_key_value_text(&mut hash, "identity_key", record.identity_key);
    update_uce_key_value_text(&mut hash, "kind", record.kind);
    update_uce_key_value_text(&mut hash, "proposal_record_key", record.proposal_record_key);
    update_uce_text(&mut hash, "schema_version");
    hash.update([7]);
    hash.update((record.schema_version as f64).to_be_bytes());
    update_uce_key_value_text(&mut hash, "source_span", record.source_span);
    update_uce_key_value_text(&mut hash, "universal_kind", record.universal_kind);
    Ok(hash)
}

fn structural_record_digest(record: &StructuralKernelRecord) -> NativeCoreResult<String> {
    Ok(sha256_text(structural_record_digest_hash(record.as_ref())?))
}

fn uce_text_digest(value: &str) -> String {
    let mut hash = Sha256::new();
    update_uce_text(&mut hash, value);
    sha256_text(hash)
}

/// P2-2f bytes-native counterpart of [`uce_text_digest`].
fn uce_text_digest_bytes(value: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    update_uce_text(&mut hash, value);
    sha256_bytes(hash)
}

fn uce_text_object_digest(fields: &[(&str, &str)]) -> String {
    let mut hash = Sha256::new();
    hash.update([6]);
    update_varint(&mut hash, fields.len());
    for (key, value) in fields {
        update_uce_key_value_text(&mut hash, key, value);
    }
    sha256_text(hash)
}

/// P2-2f bytes-native counterpart of [`uce_text_object_digest`].
fn uce_text_object_digest_bytes(fields: &[(&str, &str)]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update([6]);
    update_varint(&mut hash, fields.len());
    for (key, value) in fields {
        update_uce_key_value_text(&mut hash, key, value);
    }
    sha256_bytes(hash)
}

fn append_varint(output: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        output.push(byte);
        if value == 0 {
            break;
        }
    }
}

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// P2-2k lever (d): lookup-table hex encoder. The former implementation
/// ran `write!(&mut output, "{byte:02x}")` per byte -- one `core::fmt`
/// formatting call (with `LowerHex`'s own padding/width machinery) for
/// every one of a digest's 32 bytes, on the hot `structural_kernel_row`
/// path that builds `record_id_text` for every one of n8n's 2.83M
/// records. A direct table lookup into ASCII hex digit bytes produces the
/// exact same characters without ever going through `fmt::Write`.
/// Appends `bytes` as lowercase hex directly onto `output`, so a caller
/// that needs a prefixed hex string (e.g. `structural_kernel_row`'s
/// `"record:"`-prefixed `record_id_text`) can push the prefix and the hex
/// digits into ONE `String` instead of allocating the hex text separately
/// and then `format!`-concatenating it onto the prefix.
fn push_hex_bytes(output: &mut String, bytes: &[u8]) {
    for byte in bytes {
        output.push(HEX_DIGITS[(byte >> 4) as usize] as char);
        output.push(HEX_DIGITS[(byte & 0x0f) as usize] as char);
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    push_hex_bytes(&mut output, bytes);
    output
}

fn encode_publication_body(
    value: &Value,
    logical: &mut LogicalDigestWriter,
    payload: &mut Vec<u8>,
    depth: usize,
) -> NativeCoreResult<()> {
    if depth > MAX_LOGICAL_DEPTH {
        return Err(NativeCoreError::new(
            "Structural publication body exceeds the maximum depth.",
        ));
    }
    match value {
        Value::Null => {
            logical.tag(3);
            payload.push(0);
        }
        Value::Bool(value) => {
            logical.boolean(*value);
            payload.push(if *value { 2 } else { 1 });
        }
        Value::String(value) => {
            logical.text(value);
            payload.push(3);
            append_varint(payload, value.len());
            payload.extend_from_slice(value.as_bytes());
        }
        Value::Number(value) => {
            let real = value.as_f64().ok_or_else(|| {
                NativeCoreError::new("Structural publication body contains an invalid number.")
            })?;
            if !real.is_finite() {
                return Err(NativeCoreError::new(
                    "Structural publication body contains an invalid number.",
                ));
            }
            if let Some(integer) = value.as_i64() {
                logical.tag(5);
                logical.text(&integer.to_string());
            } else {
                if real.to_bits() == (-0.0_f64).to_bits() {
                    return Err(NativeCoreError::new(
                        "Logical digest real values must not be negative zero.",
                    ));
                }
                logical.tag(6);
                logical.raw(&real.to_be_bytes());
            }
            payload.push(7);
            payload.extend_from_slice(&(if real == 0.0 { 0.0 } else { real }).to_be_bytes());
        }
        Value::Array(values) => {
            validate_collection_length(values.len())?;
            logical.tag(9);
            logical.length(values.len());
            payload.push(5);
            append_varint(payload, values.len());
            for value in values {
                encode_publication_body(value, logical, payload, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            validate_collection_length(fields.len())?;
            // P2-2k: same BTreeMap-already-sorted argument as
            // `update_uce_value`'s Object arm above -- iterate directly,
            // no `Vec<&String>` collect + sort + second lookup.
            logical.tag(10);
            logical.length(fields.len());
            payload.push(6);
            append_varint(payload, fields.len());
            for (key, value) in fields {
                logical.text(key);
                logical.boolean(true);
                payload.push(3);
                append_varint(payload, key.len());
                payload.extend_from_slice(key.as_bytes());
                encode_publication_body(value, logical, payload, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// P2-2l item 3: fuses [`update_uce_value`]'s traversal (feeds the WHOLE-
/// record digest hasher) with [`encode_publication_body`]'s traversal
/// (produces `body_digest`/the UCE body payload bytes) into ONE walk of
/// `record.body`, used only by the v4 bytes-native hot path
/// (`structural_kernel_row`, below -- the ONLY caller). The two ORIGINAL
/// functions stay exactly as they were and remain the v3/N-API path's own
/// implementation (`structural_record_digest_hash`/`publication_record`,
/// unchanged, still used by `structural_kernel_batch_parts_with_
/// canonical`): fusing them for that lower-volume path was never this
/// task's ask, and duplicating the logic here (rather than trying to
/// share it) keeps the v3 path's own byte-for-byte contract untouched by
/// construction.
///
/// Safe because, with item 3's own depth-limit unification directly
/// above, `encode_publication_body`'s checks are now a STRICT SUPERSET of
/// `update_uce_value`'s: identical depth bound (both [`MAX_LOGICAL_
/// DEPTH`]), identical finite-number requirement, PLUS two checks
/// `update_uce_value` never had at all (`validate_collection_length` on
/// every array/object, and negative-zero rejection for non-integer
/// numbers). So whenever this fused walk reaches a leaf/branch
/// successfully, both original functions would ALSO have accepted it
/// there (there is no `update_uce_value`-only rejection this walk could
/// silently skip), and whenever it errors, so would `structural_kernel_
/// row`'s ORIGINAL two-call sequence have -- `encode_publication_body`
/// unconditionally ran and could reject the row even when `update_uce_
/// value` (called first, by `structural_record_digest_bytes`) had already
/// succeeded, which is exactly the "record rejected either way" case item
/// 3's own doc comment on `update_uce_value` traces through.
///
/// For every value that DOES succeed, the hash bytes pushed here into
/// `hash` are byte-for-byte the same sequence `update_uce_value` would
/// have pushed for the identical `Value` (same match arms, same tag
/// bytes, same varint/text encoding, same `real == 0.0` zero
/// normalization for the shared numeric case) -- `hash` is a live,
/// already-partially-fed `Sha256` (the caller has already hashed the
/// record's fixed preamble up to and including the `"body"` key text), so
/// feeding it the identical byte sequence a standalone `update_uce_value`
/// call would have fed it produces the identical final digest, regardless
/// of what was hashed into it before or is hashed into it after --
/// verified directly, not just argued, by `native_core_rows_match_
/// batch_parts_oracle`/`typed_rows_match_untyped_rows_oracle` (this
/// module's own oracle tests, comparing this fused path's output against
/// the UNCHANGED two-traversal v3 path's own digest/body-byte output field
/// by field) and by live n8n root reproduction (this task's evidence
/// entry).
fn fused_body_pass(
    value: &Value,
    hash: &mut Sha256,
    logical: &mut LogicalDigestWriter,
    payload: &mut Vec<u8>,
    depth: usize,
) -> NativeCoreResult<()> {
    if depth > MAX_LOGICAL_DEPTH {
        return Err(NativeCoreError::new(
            "Structural publication body exceeds the maximum depth.",
        ));
    }
    match value {
        Value::Null => {
            hash.update([0]);
            logical.tag(3);
            payload.push(0);
        }
        Value::Bool(value) => {
            hash.update([if *value { 2 } else { 1 }]);
            logical.boolean(*value);
            payload.push(if *value { 2 } else { 1 });
        }
        Value::String(value) => {
            update_uce_text(hash, value);
            logical.text(value);
            payload.push(3);
            append_varint(payload, value.len());
            payload.extend_from_slice(value.as_bytes());
        }
        Value::Number(value) => {
            let real = value.as_f64().ok_or_else(|| {
                NativeCoreError::new("Structural publication body contains an invalid number.")
            })?;
            if !real.is_finite() {
                return Err(NativeCoreError::new(
                    "Structural publication body contains an invalid number.",
                ));
            }
            if let Some(integer) = value.as_i64() {
                logical.tag(5);
                logical.text(&integer.to_string());
            } else {
                if real.to_bits() == (-0.0_f64).to_bits() {
                    return Err(NativeCoreError::new(
                        "Logical digest real values must not be negative zero.",
                    ));
                }
                logical.tag(6);
                logical.raw(&real.to_be_bytes());
            }
            let normalized = if real == 0.0 { 0.0 } else { real };
            hash.update([7]);
            hash.update(normalized.to_be_bytes());
            payload.push(7);
            payload.extend_from_slice(&normalized.to_be_bytes());
        }
        Value::Array(values) => {
            validate_collection_length(values.len())?;
            hash.update([5]);
            update_varint(hash, values.len());
            logical.tag(9);
            logical.length(values.len());
            payload.push(5);
            append_varint(payload, values.len());
            for value in values {
                fused_body_pass(value, hash, logical, payload, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            validate_collection_length(fields.len())?;
            hash.update([6]);
            update_varint(hash, fields.len());
            logical.tag(10);
            logical.length(fields.len());
            payload.push(6);
            append_varint(payload, fields.len());
            for (key, value) in fields {
                update_uce_text(hash, key);
                logical.text(key);
                logical.boolean(true);
                payload.push(3);
                append_varint(payload, key.len());
                payload.extend_from_slice(key.as_bytes());
                fused_body_pass(value, hash, logical, payload, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// A3b: result of [`BodyEncoder::finish`] -- everything [`structural_kernel_
/// row`] needs from a producer-built body without ever walking a
/// `serde_json::Value` tree for it. `payload` is byte-identical to what
/// [`encode_publication_body`]/[`fused_body_pass`] would have produced for
/// the equivalent `Value` tree (tag 0 null, 1/2 bool, `3 + varint(len) +
/// bytes` string, `5 + varint(n)` array, `6 + varint(n)` object with each
/// key encoded the same way as a string, `7 + f64_be` number); `body_digest`/
/// `body_byte_length` are the `LogicalDigestWriter` (`urdira:relational-
/// value:v3`) results [`encode_publication_body`] would also have produced.
/// `record_hash.update(&payload)` at the point [`structural_kernel_row`]
/// used to call `fused_body_pass` reproduces the identical `record_digest`
/// -- see [`BodyRef`]'s own doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedBody {
    pub payload: Vec<u8>,
    pub body_digest: [u8; 32],
    pub body_byte_length: usize,
}

/// A3b: one open object/array frame on [`BodyEncoder`]'s stack --
/// `remaining` counts down the number of children [`BodyEncoder::begin_
/// object`]/[`BodyEncoder::begin_array`] declared still to come, `last_key`
/// tracks the most recent object key written (`None` for an array frame, or
/// an object frame that has not yet had its first key written) so
/// [`BodyEncoder::key`] can enforce strict lexicographic order.
type BodyEncoderFrame = (usize, Option<String>);

/// A3b: a streaming, allocation-light replacement for building a
/// `serde_json::Value` tree with a producer's own inserts/pushes and then
/// feeding it through [`fused_body_pass`]/[`encode_publication_body`].
/// Every producer that migrates to this encoder must emit exactly the same
/// keys/values [`fused_body_pass`] would see for the equivalent `Value`
/// tree, in strictly increasing (byte-lexicographic) key order per object
/// -- the same order `serde_json::Map` (a `BTreeMap` in this workspace,
/// which never enables the `preserve_order` feature -- see this task's own
/// evidence entry) always iterates in regardless of insertion order.
///
/// Nesting is tracked with a small stack of `(remaining_children, last_key)`
/// frames (`pending_keys`) instead of explicit `end_object`/`end_array`
/// calls: `begin_object(n)`/`begin_array(n)` push a frame expecting exactly
/// `n` children (or, for `n == 0`, close immediately); every leaf write
/// (`null`/`bool`/`string`/`int`/`uint`/`real`) and every container close
/// counts as ONE child consumed from the current top frame, decrementing
/// its `remaining`; when a frame's `remaining` reaches zero it is popped
/// and that pop itself counts as one child consumed from whatever frame is
/// now on top (cascading all the way to the root, where there is no parent
/// frame left to notify). [`BodyEncoder::finish`] panics if any frame is
/// still open -- a mismatched child count is a producer bug, not a
/// data-dependent error, so it is caught loudly rather than silently
/// truncating/padding the payload.
///
/// `depth` mirrors the `depth` parameter [`fused_body_pass`]/[`encode_
/// publication_body`] thread through their recursion (starting at `1` for
/// the body's own top-level value, incrementing by one per nesting level),
/// checked against [`MAX_LOGICAL_DEPTH`] on every value write -- the exact
/// same bound those two functions enforce.
pub struct BodyEncoder {
    payload: Vec<u8>,
    logical: LogicalDigestWriter,
    depth: usize,
    pending_keys: Vec<BodyEncoderFrame>,
}

impl Default for BodyEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl BodyEncoder {
    pub fn new() -> Self {
        Self {
            payload: Vec::new(),
            logical: LogicalDigestWriter::new("urdira:relational-value:v3"),
            depth: 1,
            pending_keys: Vec::new(),
        }
    }

    fn check_depth(&self) -> NativeCoreResult<()> {
        if self.depth > MAX_LOGICAL_DEPTH {
            return Err(NativeCoreError::new(
                "Structural publication body exceeds the maximum depth.",
            ));
        }
        Ok(())
    }

    /// Called exactly once after every value (leaf or closed container) is
    /// fully written, to decrement the current top frame's remaining-child
    /// count and cascade the close of any frame(s) that reach zero as a
    /// result -- see this struct's own doc comment.
    fn record_child_and_cascade(&mut self) {
        while let Some(frame) = self.pending_keys.last_mut() {
            frame.0 -= 1;
            if frame.0 == 0 {
                self.pending_keys.pop();
                self.depth -= 1;
                continue;
            }
            break;
        }
    }

    /// Opens an object expecting exactly `n` key/value children. Emits the
    /// same `[6] varint(n)` payload preamble and `logical.tag(10); logical.
    /// length(n)` [`encode_publication_body`]'s `Value::Object` arm emits.
    pub fn begin_object(&mut self, n: usize) -> NativeCoreResult<()> {
        validate_collection_length(n)?;
        self.check_depth()?;
        self.logical.tag(10);
        self.logical.length(n);
        self.payload.push(6);
        append_varint(&mut self.payload, n);
        if n == 0 {
            self.record_child_and_cascade();
        } else {
            self.depth += 1;
            self.pending_keys.push((n, None));
        }
        Ok(())
    }

    /// Opens an array expecting exactly `n` value children. Emits the same
    /// `[5] varint(n)` payload preamble and `logical.tag(9); logical.
    /// length(n)` [`encode_publication_body`]'s `Value::Array` arm emits.
    pub fn begin_array(&mut self, n: usize) -> NativeCoreResult<()> {
        validate_collection_length(n)?;
        self.check_depth()?;
        self.logical.tag(9);
        self.logical.length(n);
        self.payload.push(5);
        append_varint(&mut self.payload, n);
        if n == 0 {
            self.record_child_and_cascade();
        } else {
            self.depth += 1;
            self.pending_keys.push((n, None));
        }
        Ok(())
    }

    /// Writes one object key. Requires an object frame to be open (the top
    /// of `pending_keys`) and the key to sort strictly after the previous
    /// key written for THAT object (`serde_json::Map`'s own `BTreeMap`
    /// iteration order, without `preserve_order`) -- violating this is a
    /// producer bug (it means the producer's field order does not match
    /// what iterating the equivalent `Value::Object` would have produced),
    /// so it is rejected rather than silently accepted out of order. Does
    /// NOT itself count as a child write -- the value written immediately
    /// after this call does.
    pub fn key(&mut self, key: &str) -> NativeCoreResult<()> {
        let frame = self
            .pending_keys
            .last_mut()
            .ok_or_else(|| NativeCoreError::new("BodyEncoder::key called with no open object."))?;
        if let Some(last_key) = &frame.1
            && key.as_bytes() <= last_key.as_bytes()
        {
            return Err(NativeCoreError::new(format!(
                "BodyEncoder object keys must be strictly increasing: '{key}' after '{last_key}'."
            )));
        }
        frame.1 = Some(key.to_owned());
        self.logical.text(key);
        self.logical.boolean(true);
        self.payload.push(3);
        append_varint(&mut self.payload, key.len());
        self.payload.extend_from_slice(key.as_bytes());
        Ok(())
    }

    pub fn null(&mut self) -> NativeCoreResult<()> {
        self.check_depth()?;
        self.logical.tag(3);
        self.payload.push(0);
        self.record_child_and_cascade();
        Ok(())
    }

    pub fn bool(&mut self, value: bool) -> NativeCoreResult<()> {
        self.check_depth()?;
        self.logical.boolean(value);
        self.payload.push(if value { 2 } else { 1 });
        self.record_child_and_cascade();
        Ok(())
    }

    pub fn string(&mut self, value: &str) -> NativeCoreResult<()> {
        self.check_depth()?;
        self.logical.text(value);
        self.payload.push(3);
        append_varint(&mut self.payload, value.len());
        self.payload.extend_from_slice(value.as_bytes());
        self.record_child_and_cascade();
        Ok(())
    }

    /// A signed integer. Always takes `fused_body_pass`'s `value.as_i64()
    /// == Some(_)` branch (any real `i64` is trivially representable as
    /// `i64`): `logical.tag(5)` + the exact decimal text, payload `[7] +
    /// (value as f64).to_be_bytes()` -- matching `Value::Number`'s handling
    /// of a JSON number that was itself constructed from a Rust integer.
    pub fn int(&mut self, value: i64) -> NativeCoreResult<()> {
        self.check_depth()?;
        self.logical.tag(5);
        self.logical.text(&value.to_string());
        self.payload.push(7);
        self.payload
            .extend_from_slice(&(value as f64).to_be_bytes());
        self.record_child_and_cascade();
        Ok(())
    }

    /// An unsigned integer. Mirrors `serde_json::Number::as_i64`: a value
    /// that fits in `i64` (`<= i64::MAX`) takes the integer branch exactly
    /// like [`Self::int`]; a value too large for `i64` falls into the SAME
    /// "real" branch `fused_body_pass`'s `Value::Number` arm falls into for
    /// such a number (`logical.tag(6)` + raw `f64` bytes -- unreachable for
    /// the negative-zero rejection, since an unsigned value is never
    /// negative), matching what `Value::from(huge_u64)`'s `as_i64()`
    /// returning `None` would have produced. Payload is `[7] + (value as
    /// f64).to_be_bytes()` either way, exactly like [`Self::int`].
    pub fn uint(&mut self, value: u64) -> NativeCoreResult<()> {
        self.check_depth()?;
        if value <= i64::MAX as u64 {
            self.logical.tag(5);
            self.logical.text(&value.to_string());
        } else {
            self.logical.tag(6);
            self.logical.raw(&(value as f64).to_be_bytes());
        }
        self.payload.push(7);
        self.payload
            .extend_from_slice(&(value as f64).to_be_bytes());
        self.record_child_and_cascade();
        Ok(())
    }

    /// A floating-point number that is not itself a Rust integer type --
    /// matches `fused_body_pass`'s `Value::Number` "else" (non-`as_i64`)
    /// branch: rejects non-finite values and negative zero exactly like
    /// that branch, `logical.tag(6)` + raw `f64` bytes, payload `[7] +`
    /// the zero-normalized `f64` bytes (`-0.0` is rejected above, so the
    /// only zero that reaches the payload write is already `+0.0`).
    pub fn real(&mut self, value: f64) -> NativeCoreResult<()> {
        self.check_depth()?;
        if !value.is_finite() {
            return Err(NativeCoreError::new(
                "Structural publication body contains an invalid number.",
            ));
        }
        if value.to_bits() == (-0.0_f64).to_bits() {
            return Err(NativeCoreError::new(
                "Logical digest real values must not be negative zero.",
            ));
        }
        self.logical.tag(6);
        self.logical.raw(&value.to_be_bytes());
        let normalized = if value == 0.0 { 0.0 } else { value };
        self.payload.push(7);
        self.payload.extend_from_slice(&normalized.to_be_bytes());
        self.record_child_and_cascade();
        Ok(())
    }

    /// Finishes the body. Panics if any `begin_object`/`begin_array` frame
    /// is still open -- i.e. the producer declared a child count that its
    /// own subsequent calls did not match -- a programmer error in this
    /// encoder's caller, not a data-dependent one.
    pub fn finish(self) -> EncodedBody {
        assert!(
            self.pending_keys.is_empty(),
            "BodyEncoder::finish called with an unterminated object/array (declared child count did not match the number of values written)."
        );
        let (body_digest, body_byte_length) = self.logical.finish_bytes();
        EncodedBody {
            payload: self.payload,
            body_digest,
            body_byte_length,
        }
    }
}

/// A3b: exact inverse of the payload format [`encode_publication_body`]/
/// [`fused_body_pass`]/[`BodyEncoder`] produce (tag `0` null, `1`/`2` bool,
/// `3 + varint(len) + bytes` string, `5 + varint(n)` array, `6 + varint(n)`
/// object with `n` `(string-key, value)` pairs, `7 + f64_be` number).
/// Needed only by callers that still hold a payload but need the equivalent
/// `serde_json::Value` back -- the v3/legacy `run_jsts_generation` path
/// (`urdira-indexing-worker::main`) mutates a record's body as a `Value`
/// object, and `ProposedRecord`'s `Serialize` impl for `RecordBody::Encoded`
/// decodes to `Value` so the IPC/`AnalysisResponse` JSON shape is unchanged.
pub fn decode_body(payload: &[u8]) -> NativeCoreResult<Value> {
    let mut cursor = 0usize;
    let value = decode_body_value(payload, &mut cursor)?;
    if cursor != payload.len() {
        return Err(NativeCoreError::new(
            "Structural publication body payload has trailing bytes.",
        ));
    }
    Ok(value)
}

fn read_byte(payload: &[u8], cursor: &mut usize) -> NativeCoreResult<u8> {
    let byte = *payload
        .get(*cursor)
        .ok_or_else(|| NativeCoreError::new("Structural publication body payload is truncated."))?;
    *cursor += 1;
    Ok(byte)
}

fn read_bytes<'a>(payload: &'a [u8], cursor: &mut usize, len: usize) -> NativeCoreResult<&'a [u8]> {
    let end = cursor
        .checked_add(len)
        .ok_or_else(|| NativeCoreError::new("Structural publication body payload overflowed."))?;
    let slice = payload
        .get(*cursor..end)
        .ok_or_else(|| NativeCoreError::new("Structural publication body payload is truncated."))?;
    *cursor = end;
    Ok(slice)
}

fn read_varint(payload: &[u8], cursor: &mut usize) -> NativeCoreResult<usize> {
    let mut result: usize = 0;
    let mut shift: u32 = 0;
    loop {
        let byte = read_byte(payload, cursor)?;
        result |= usize::from(byte & 0x7f).checked_shl(shift).ok_or_else(|| {
            NativeCoreError::new("Structural publication body varint overflowed.")
        })?;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Ok(result)
}

fn decode_body_value(payload: &[u8], cursor: &mut usize) -> NativeCoreResult<Value> {
    let tag = read_byte(payload, cursor)?;
    match tag {
        0 => Ok(Value::Null),
        1 => Ok(Value::Bool(false)),
        2 => Ok(Value::Bool(true)),
        3 => {
            let len = read_varint(payload, cursor)?;
            let bytes = read_bytes(payload, cursor, len)?;
            let text = std::str::from_utf8(bytes).map_err(|_| {
                NativeCoreError::new("Structural publication body string is not valid UTF-8.")
            })?;
            Ok(Value::String(text.to_owned()))
        }
        5 => {
            let len = read_varint(payload, cursor)?;
            let mut values = Vec::with_capacity(len);
            for _ in 0..len {
                values.push(decode_body_value(payload, cursor)?);
            }
            Ok(Value::Array(values))
        }
        6 => {
            let len = read_varint(payload, cursor)?;
            let mut map = serde_json::Map::with_capacity(len);
            for _ in 0..len {
                let key_tag = read_byte(payload, cursor)?;
                if key_tag != 3 {
                    return Err(NativeCoreError::new(
                        "Structural publication body object key is not a string.",
                    ));
                }
                let key_len = read_varint(payload, cursor)?;
                let key_bytes = read_bytes(payload, cursor, key_len)?;
                let key = std::str::from_utf8(key_bytes)
                    .map_err(|_| {
                        NativeCoreError::new("Structural publication body key is not valid UTF-8.")
                    })?
                    .to_owned();
                let value = decode_body_value(payload, cursor)?;
                map.insert(key, value);
            }
            Ok(Value::Object(map))
        }
        7 => {
            let bytes = read_bytes(payload, cursor, 8)?;
            let real = f64::from_be_bytes(bytes.try_into().expect("checked 8-byte slice"));
            // The payload tag alone cannot distinguish "encoded via `int`/
            // `uint`" from "encoded via `real` with a whole-number value" --
            // both produce the identical `[7] + f64_be` bytes (see
            // `BodyEncoder::int`/`uint`/`real`). Every real producer in this
            // pipeline only ever puts actual integers (spans, counts, line
            // numbers) into a body, never a literal whole-number float, so
            // normalizing any exactly-integral, safely-representable value
            // back to `serde_json`'s integer `Number` variant on decode
            // matches what every real caller originally encoded -- and
            // matches JSON's own semantics, where `5` and `5.0` are the same
            // number. A genuinely fractional value decodes as a float
            // either way.
            if real.fract() == 0.0 && real.abs() <= MAX_SAFE_INTEGER as f64 {
                Ok(Value::from(real as i64))
            } else {
                Ok(Value::from(real))
            }
        }
        other => Err(NativeCoreError::new(format!(
            "Structural publication body payload has an unknown tag byte {other}."
        ))),
    }
}

fn payload_cursor_read_byte(payload: &[u8], cursor: &Cell<usize>) -> NativeCoreResult<u8> {
    let mut pos = cursor.get();
    let byte = read_byte(payload, &mut pos)?;
    cursor.set(pos);
    Ok(byte)
}

fn payload_cursor_read_bytes<'a>(
    payload: &'a [u8],
    cursor: &Cell<usize>,
    len: usize,
) -> NativeCoreResult<&'a [u8]> {
    let mut pos = cursor.get();
    let bytes = read_bytes(payload, &mut pos, len)?;
    cursor.set(pos);
    Ok(bytes)
}

fn payload_cursor_read_varint(payload: &[u8], cursor: &Cell<usize>) -> NativeCoreResult<usize> {
    let mut pos = cursor.get();
    let value = read_varint(payload, &mut pos)?;
    cursor.set(pos);
    Ok(value)
}

fn payload_cursor_read_str<'a>(
    payload: &'a [u8],
    cursor: &Cell<usize>,
) -> NativeCoreResult<&'a str> {
    let len = payload_cursor_read_varint(payload, cursor)?;
    let bytes = payload_cursor_read_bytes(payload, cursor, len)?;
    std::str::from_utf8(bytes)
        .map_err(|_| NativeCoreError::new("Structural publication body string is not valid UTF-8."))
}

/// Maps a [`NativeCoreError`] (this module's own malformed-payload errors)
/// into whatever error type the caller's [`serde::Serializer`] uses --
/// [`serialize_payload`]/[`serialize_payload_value`]'s error channel is
/// generic over `S::Error`, not this crate's own `NativeCoreResult`.
fn payload_ser_err<E: serde::ser::Error>(error: NativeCoreError) -> E {
    E::custom(error.to_string())
}

/// A3b coste 1: one `serde::Serialize`-able view over the payload VALUE
/// starting at `cursor`'s current position -- exists only so
/// [`serialize_payload_value`]'s array/object arms can hand
/// `SerializeSeq::serialize_element`/`SerializeMap::serialize_entry` a `&dyn
/// Serialize` for each child without first decoding that child into a
/// `serde_json::Value` (the whole point of this task: skip the `Value` tree
/// entirely). `cursor` is a shared `&Cell<usize>` rather than `&mut usize`
/// because `serde::Serialize::serialize` takes `&self`, so nothing here can
/// hold a `&mut` cursor across the trait boundary -- `Cell` gives every
/// sibling element in a sequence/map the same "read current position,
/// advance it" capability a `&mut usize` would, just through get/set instead
/// of direct mutation.
struct PayloadElement<'a> {
    payload: &'a [u8],
    cursor: &'a Cell<usize>,
}

impl Serialize for PayloadElement<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serialize_payload_value(self.payload, self.cursor, serializer)
    }
}

/// A3b coste 1: streaming counterpart of [`decode_body`]/[`decode_body_
/// value`] -- walks a [`BodyEncoder`]-built payload directly into a
/// `serde::Serializer`, emitting `serialize_unit`/`serialize_bool`/
/// `serialize_str`/`serialize_seq`/`serialize_map`/`serialize_i64`/
/// `serialize_f64` calls as it goes, WITHOUT ever building an intermediate
/// `serde_json::Value` tree the way `RecordBody`'s old `Serialize` impl
/// (`decode_body` then `value.serialize(serializer)`) did. Exists because
/// `SyntaxWorkerState::analyze`'s `max_output_bytes` budget check
/// (`serde_json::to_vec(&response)`, `urdira-jsts-syntax-worker::lib`) walks
/// every `ProposedRecord` in the response, and on the v4 hot path EVERY
/// record's body is `RecordBody::Encoded` -- decoding 2.17M bodies to
/// `Value` purely to re-serialize them was pure waste this function removes.
///
/// Tag handling is the EXACT inverse of [`decode_body_value`], including
/// tag `7`'s int-vs-float normalization: `decode_body_value` always
/// reconstructs a whole-number, safely-representable payload float as
/// `Value::from(real as i64)` (never a `u64` branch -- read that function's
/// own doc comment), and `serde_json`'s own `Number::serialize` for such a
/// `Value` prints the same plain decimal text a direct `serializer.
/// serialize_i64` call does, so this function calls `serialize_i64` for
/// that exact case (never `serialize_u64`) to match `decode_body_value`'s
/// rule byte for byte, and `serialize_f64` for every other (genuinely
/// fractional, or out-of-range) numeric payload. See `encoded_body_
/// serializes_identically_to_a_plain_value_body`/this crate's own streaming-
/// serializer tests for the byte-for-byte proof against `serde_json::to_
/// string(&Value)`.
pub fn serialize_payload<S>(payload: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let cursor = Cell::new(0usize);
    let result = serialize_payload_value(payload, &cursor, serializer)?;
    if cursor.get() != payload.len() {
        return Err(serde::ser::Error::custom(
            "Structural publication body payload has trailing bytes.",
        ));
    }
    Ok(result)
}

fn serialize_payload_value<S>(
    payload: &[u8],
    cursor: &Cell<usize>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    use serde::ser::{SerializeMap, SerializeSeq};

    let tag = payload_cursor_read_byte(payload, cursor).map_err(payload_ser_err)?;
    match tag {
        0 => serializer.serialize_unit(),
        1 => serializer.serialize_bool(false),
        2 => serializer.serialize_bool(true),
        3 => {
            let text = payload_cursor_read_str(payload, cursor).map_err(payload_ser_err)?;
            serializer.serialize_str(text)
        }
        5 => {
            let len = payload_cursor_read_varint(payload, cursor).map_err(payload_ser_err)?;
            let mut seq = serializer.serialize_seq(Some(len))?;
            for _ in 0..len {
                seq.serialize_element(&PayloadElement { payload, cursor })?;
            }
            seq.end()
        }
        6 => {
            let len = payload_cursor_read_varint(payload, cursor).map_err(payload_ser_err)?;
            let mut map = serializer.serialize_map(Some(len))?;
            for _ in 0..len {
                let key_tag = payload_cursor_read_byte(payload, cursor).map_err(payload_ser_err)?;
                if key_tag != 3 {
                    return Err(serde::ser::Error::custom(
                        "Structural publication body object key is not a string.",
                    ));
                }
                let key = payload_cursor_read_str(payload, cursor).map_err(payload_ser_err)?;
                map.serialize_entry(key, &PayloadElement { payload, cursor })?;
            }
            map.end()
        }
        7 => {
            let bytes = payload_cursor_read_bytes(payload, cursor, 8).map_err(payload_ser_err)?;
            let real = f64::from_be_bytes(bytes.try_into().expect("checked 8-byte slice"));
            // Byte-for-byte mirror of `decode_body_value`'s tag-`7` arm --
            // see that arm's own doc comment for why this normalization is
            // safe/correct for every real producer in this pipeline.
            if real.fract() == 0.0 && real.abs() <= MAX_SAFE_INTEGER as f64 {
                serializer.serialize_i64(real as i64)
            } else {
                serializer.serialize_f64(real)
            }
        }
        other => Err(serde::ser::Error::custom(format!(
            "Structural publication body payload has an unknown tag byte {other}."
        ))),
    }
}

fn publication_record(
    record: &StructuralKernelRecord,
    facets: &[String],
    record_id: &str,
    record_digest: &str,
) -> NativeCoreResult<(StructuralPublicationRecord, String)> {
    let mut body_writer = LogicalDigestWriter::new("urdira:relational-value:v3");
    let mut body_payload = Vec::new();
    encode_publication_body(&record.body, &mut body_writer, &mut body_payload, 1)?;
    let body_result = body_writer.finish();
    let identity_type = match record.category.as_str() {
        "relation" => "relation",
        "diagnostic" => "diagnostic",
        _ => "entity",
    }
    .to_owned();
    let identity_key_digest = uce_text_digest(&record.identity_key);
    let identity_id_digest = uce_text_object_digest(&[("identity_key", &record.identity_key)]);
    let identity_assignment_id = uce_text_object_digest(&[
        ("identity_key", &record.identity_key),
        ("record_id", record_id),
    ]);
    let primary_source_span = serde_json::from_str::<Value>(&record.source_span).ok();
    Ok((
        StructuralPublicationRecord {
            record_id: record_id.to_owned(),
            record_digest: record_digest.to_owned(),
            body_digest: body_result.digest,
            body_byte_length: body_result.byte_length,
            schema_version: record.schema_version,
            facets: facets.to_vec(),
            primary_source_span,
            identity_type: identity_type.clone(),
            identity_key: record.identity_key.clone(),
            identity_id: format!(
                "{identity_type}:{}",
                identity_id_digest.trim_start_matches("sha256:")
            ),
            identity_key_digest,
            identity_assignment_id,
        },
        hex_bytes(&body_payload),
    ))
}

fn canonical_json_into(value: &Value, output: &mut String, depth: usize) -> NativeCoreResult<()> {
    if depth > MAX_LOGICAL_DEPTH {
        return Err(NativeCoreError::new(
            "Structural kernel JSON exceeds the maximum depth.",
        ));
    }
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            let integer = value.as_i64().ok_or_else(|| {
                NativeCoreError::new("Structural kernel JSON numbers must be safe integers.")
            })?;
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer) {
                return Err(NativeCoreError::new(
                    "Structural kernel JSON integer exceeds the safe range.",
                ));
            }
            write!(output, "{integer}").expect("writing to String cannot fail");
        }
        Value::String(value) => {
            output.push_str(&serde_json::to_string(value).map_err(|error| {
                NativeCoreError::new(format!(
                    "Structural kernel could not encode JSON text: {error}"
                ))
            })?)
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json_into(value, output, depth + 1)?;
            }
            output.push(']');
        }
        Value::Object(fields) => {
            // P2-2k: same BTreeMap-already-sorted argument as
            // `update_uce_value`'s Object arm -- iterate directly. The
            // dropped `.then_with(|| left.cmp(right))` tie-break was
            // already dead code: a `BTreeMap` never holds two equal keys,
            // so `left.as_bytes().cmp(right.as_bytes())` (used as the
            // ordering key everywhere else in this file) never actually
            // ties here.
            output.push('{');
            for (index, (key, value)) in fields.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|error| {
                    NativeCoreError::new(format!(
                        "Structural kernel could not encode a JSON key: {error}"
                    ))
                })?);
                output.push(':');
                canonical_json_into(value, output, depth + 1)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn canonical_json(value: &Value) -> NativeCoreResult<String> {
    let mut output = String::new();
    canonical_json_into(value, &mut output, 0)?;
    Ok(output)
}

fn push_json_string(output: &mut String, value: &str) -> NativeCoreResult<()> {
    output.push_str(&serde_json::to_string(value).map_err(|error| {
        NativeCoreError::new(format!(
            "Structural kernel could not encode JSON text: {error}"
        ))
    })?);
    Ok(())
}

fn push_json_text_field(
    output: &mut String,
    first: &mut bool,
    key: &str,
    value: &str,
) -> NativeCoreResult<()> {
    if !*first {
        output.push(',');
    }
    *first = false;
    push_json_string(output, key)?;
    output.push(':');
    push_json_string(output, value)
}

fn structural_record_canonical(record: &StructuralKernelRecord) -> NativeCoreResult<String> {
    let mut output = String::new();
    let mut first = true;
    output.push('{');
    if !first {
        output.push(',');
    }
    first = false;
    push_json_string(&mut output, "body")?;
    output.push(':');
    canonical_json_into(&record.body, &mut output, 1)?;
    push_json_text_field(&mut output, &mut first, "category", &record.category)?;
    push_json_text_field(
        &mut output,
        &mut first,
        "evidence_references",
        &record.evidence_references,
    )?;
    push_json_text_field(&mut output, &mut first, "facets", &record.facets)?;
    push_json_text_field(
        &mut output,
        &mut first,
        "identity_key",
        &record.identity_key,
    )?;
    push_json_text_field(&mut output, &mut first, "kind", &record.kind)?;
    push_json_text_field(
        &mut output,
        &mut first,
        "proposal_record_key",
        &record.proposal_record_key,
    )?;
    output.push(',');
    push_json_string(&mut output, "schema_version")?;
    output.push(':');
    write!(&mut output, "{}", record.schema_version).expect("writing to String cannot fail");
    push_json_text_field(&mut output, &mut first, "source_span", &record.source_span)?;
    push_json_text_field(
        &mut output,
        &mut first,
        "universal_kind",
        &record.universal_kind,
    )?;
    output.push('}');
    Ok(output)
}

fn structural_dependency_canonical(
    dependency: &StructuralKernelDependency,
) -> NativeCoreResult<String> {
    let mut output = String::new();
    let mut first = true;
    output.push('{');
    push_json_text_field(
        &mut output,
        &mut first,
        "dependency_artifact_id",
        &dependency.dependency_artifact_id,
    )?;
    push_json_text_field(
        &mut output,
        &mut first,
        "dependency_artifact_version_id",
        &dependency.dependency_artifact_version_id,
    )?;
    push_json_text_field(
        &mut output,
        &mut first,
        "dependency_basis",
        &dependency.dependency_basis,
    )?;
    push_json_text_field(
        &mut output,
        &mut first,
        "dependency_role",
        &dependency.dependency_role,
    )?;
    push_json_text_field(
        &mut output,
        &mut first,
        "proposal_record_key",
        &dependency.proposal_record_key,
    )?;
    push_json_text_field(
        &mut output,
        &mut first,
        "proposed_dependency_id",
        &dependency.proposed_dependency_id,
    )?;
    output.push(',');
    push_json_string(&mut output, "source_reference")?;
    output.push(':');
    canonical_json_into(&dependency.source_reference, &mut output, 1)?;
    output.push('}');
    Ok(output)
}

fn canonical_array_digest(values: &[String]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            hash.update(b",");
        }
        hash.update(value.as_bytes());
    }
    hash.update(b"]");
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in hash.finalize() {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn canonical_nested_record_fields(record: StructuralKernelRecordRef<'_>) -> Option<Vec<String>> {
    let facets = serde_json::from_str::<Value>(record.facets).ok()?;
    if canonical_json(&facets).ok()? != record.facets {
        return None;
    }
    let facets = facets.as_array()?;
    let mut facet_values = Vec::with_capacity(facets.len());
    let mut unique = HashSet::with_capacity(facets.len());
    for facet in facets {
        let facet = facet.as_str()?.to_owned();
        if !unique.insert(facet.clone()) {
            return None;
        }
        facet_values.push(facet);
    }
    if !record.source_span.is_empty() {
        let source_span = serde_json::from_str::<Value>(record.source_span).ok()?;
        if canonical_json(&source_span).ok()? != record.source_span {
            return None;
        }
    }
    let evidence = serde_json::from_str::<Value>(record.evidence_references).ok()?;
    if canonical_json(&evidence).ok()? != record.evidence_references {
        return None;
    }
    Some(facet_values)
}

/// P2-2k: fused sibling of [`canonical_nested_record_fields`] and (the
/// former) `source_span_bytes_from_text`, used only by
/// [`structural_kernel_rows_ref`]'s hot loop. Those two functions used to
/// each parse `record.source_span` independently -- one purely to check
/// its canonical form (discarding the parsed tree immediately after), the
/// other purely to pull `start`/`end` back out -- so every record with a
/// non-empty `source_span` paid for two full `serde_json::Value` parses of
/// the same text. Profiling the n8n cold scan (P2-2k's evidence entry)
/// found `serde_json`'s `Value` deserializer among Pass 1's largest leaf
/// costs, so this parses `source_span` at most ONCE and serves both needs
/// from that one parse.
///
/// Returns the exact same `Option<Vec<String>>` as
/// `canonical_nested_record_fields` would for this record (byte-for-byte:
/// same `None`/`Some` conditions, same values), plus `(span_start,
/// span_end)` populated the exact same way the former
/// `source_span_bytes_from_text` populated it -- from the parsed JSON
/// whenever it parses at all, independent of whether the text also turns
/// out to be exactly canonical (a non-canonical-but-parseable span, e.g.
/// extra whitespace, still yields real `start`/`end` values here, exactly
/// as it did when the two checks were separate calls).
/// P2-2k lever (e): compares `value`'s canonical JSON rendering against
/// `expected` by rendering into a caller-owned, reused `scratch` buffer
/// (cleared, capacity kept) instead of `canonical_json`'s fresh
/// `String::new()` per call. `structural_kernel_rows_ref`'s hot loop calls
/// this up to three times per record (facets/source_span/
/// evidence_references), each on a short-lived comparison result that is
/// immediately discarded -- reusing one buffer across every record in a
/// batch turns those into a handful of one-time allocations instead of
/// millions of them.
fn canonical_json_matches(
    value: &Value,
    expected: &str,
    scratch: &mut String,
) -> NativeCoreResult<bool> {
    scratch.clear();
    canonical_json_into(value, scratch, 0)?;
    Ok(scratch == expected)
}

/// Parses `source_span` into a `Value` only when non-empty (matching every
/// call site's own pre-existing "empty means no span" convention) --
/// factored out so [`canonical_nested_record_fields_and_span`] and the
/// P2-2l typed hot path ([`parse_span_start_end`]) share one parse
/// implementation rather than drifting.
fn parse_span_value(source_span: &str) -> Option<Value> {
    if source_span.is_empty() {
        None
    } else {
        serde_json::from_str::<Value>(source_span).ok()
    }
}

/// P2-2l item 2: span-only counterpart of [`parse_span_value`] +
/// [`span_start_end`], used by [`structural_kernel_rows_typed`]'s hot loop,
/// which (unlike [`canonical_nested_record_fields_and_span`]) never needs
/// the parsed `Value` for anything beyond `start`/`end` extraction -- its
/// caller already trusts `facets`/`evidence_references` are canonical by
/// construction (see that function's own doc comment), so there is nothing
/// left to validate `source_span`'s parsed tree against.
fn parse_span_start_end(source_span: &str) -> (u32, u32) {
    parse_span_value(source_span)
        .as_ref()
        .map_or((0, 0), span_start_end)
}

/// A3b coste 2: takes `record` BY REFERENCE (not by value) -- this function
/// never reads `record.body` at all (only `.facets`/`.source_span`/
/// `.evidence_references`, all plain `&str`), so a reference is enough, and
/// keeping it a reference lets `structural_kernel_rows_ref`/`_owned_typed`'s
/// hot loop still have `record` available, UNCONSUMED, for the
/// `structural_kernel_row(record, ...)` call immediately after -- the one
/// call that DOES need to consume `record.body` by value (to move an
/// `EncodedOwned` payload out without cloning it). Before this change this
/// function took `record` by value and relied on `StructuralKernelRecordRef`
/// being `Copy` to leave the caller's own `record` binding usable afterward;
/// `BodyRef::EncodedOwned` (coste 2) removed that `Copy` impl, so this is
/// the replacement.
fn canonical_nested_record_fields_and_span(
    record: &StructuralKernelRecordRef<'_>,
    scratch: &mut String,
    unique: &mut HashSet<String>,
) -> (Option<Vec<String>>, (u32, u32)) {
    let span_value = parse_span_value(record.source_span);
    let span_bytes = span_value.as_ref().map_or((0, 0), span_start_end);
    let facets = (|| {
        let facets = serde_json::from_str::<Value>(record.facets).ok()?;
        if !canonical_json_matches(&facets, record.facets, scratch).ok()? {
            return None;
        }
        let facets = facets.as_array()?;
        let mut facet_values = Vec::with_capacity(facets.len());
        unique.clear();
        for facet in facets {
            let facet = facet.as_str()?.to_owned();
            if !unique.insert(facet.clone()) {
                return None;
            }
            facet_values.push(facet);
        }
        if !record.source_span.is_empty()
            && !canonical_json_matches(span_value.as_ref()?, record.source_span, scratch).ok()?
        {
            return None;
        }
        let evidence = serde_json::from_str::<Value>(record.evidence_references).ok()?;
        if !canonical_json_matches(&evidence, record.evidence_references, scratch).ok()? {
            return None;
        }
        Some(facet_values)
    })();
    (facets, span_bytes)
}

/// Producer-side physical seal. This deliberately does not compute record
/// identities, UCE body payloads, publication rows or descriptors: the
/// independent receiving core owns those authoritative derivations.
pub fn structural_kernel_seal_batch(
    batch: &StructuralKernelBatch,
) -> NativeCoreResult<StructuralKernelSealResult> {
    let row_count = batch
        .records
        .len()
        .checked_add(batch.dependencies.len())
        .ok_or_else(|| NativeCoreError::new("Structural kernel row count overflowed."))?;
    if row_count > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let canonical_records = batch
        .records
        .iter()
        .map(structural_record_canonical)
        .collect::<NativeCoreResult<Vec<_>>>()?;
    let canonical_dependencies = batch
        .dependencies
        .iter()
        .map(structural_dependency_canonical)
        .collect::<NativeCoreResult<Vec<_>>>()?;
    let canonical_byte_length = canonical_records
        .iter()
        .chain(&canonical_dependencies)
        .try_fold(0usize, |total, row| total.checked_add(row.len()))
        .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
    if canonical_byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }
    Ok(StructuralKernelSealResult {
        canonical_records,
        canonical_dependencies,
        canonical_byte_length,
    })
}

/// Validates the closed physical row contract and performs the hot canonical
/// encoding and digest pass once for a bounded group. Registry- and
/// workspace-dependent checks remain with the engine and are evaluated over
/// these same owner rows before durable acceptance.
pub fn structural_kernel_batch(
    batch: &StructuralKernelBatch,
) -> NativeCoreResult<StructuralKernelResult> {
    structural_kernel_batch_parts(&batch.records, &batch.dependencies)
}

/// Borrowed-row variant used by the indexing core's owned engine boundary.
/// The kernel only reads structural rows while deriving canonical text,
/// digests, IDs, and publication scalars, so accepting slices avoids cloning
/// every record/dependency into a temporary `StructuralKernelBatch`.
pub fn structural_kernel_batch_parts(
    records: &[StructuralKernelRecord],
    dependencies: &[StructuralKernelDependency],
) -> NativeCoreResult<StructuralKernelResult> {
    structural_kernel_batch_parts_with_canonical(records, dependencies, None, None)
}

/// Shared implementation for raw and already-canonical rows. When canonical
/// slices are supplied they have already passed exact-form validation, so the
/// hot publication pass can reuse them without serializing every row a second
/// time.
fn structural_kernel_batch_parts_with_canonical(
    records: &[StructuralKernelRecord],
    dependencies: &[StructuralKernelDependency],
    supplied_canonical_records: Option<&[String]>,
    supplied_canonical_dependencies: Option<&[String]>,
) -> NativeCoreResult<StructuralKernelResult> {
    if supplied_canonical_records.is_some_and(|values| values.len() != records.len())
        || supplied_canonical_dependencies.is_some_and(|values| values.len() != dependencies.len())
    {
        return Err(NativeCoreError::new(
            "Structural canonical rows do not match decoded row counts.",
        ));
    }
    let row_count = records
        .len()
        .checked_add(dependencies.len())
        .ok_or_else(|| NativeCoreError::new("Structural kernel row count overflowed."))?;
    if row_count > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let mut canonical_records = Vec::with_capacity(records.len());
    let mut record_digests = Vec::with_capacity(records.len());
    let mut record_ids = Vec::with_capacity(records.len());
    let mut record_facets = Vec::with_capacity(records.len());
    let mut record_structural_attestations = Vec::with_capacity(records.len());
    let mut publication_records = Vec::with_capacity(records.len());
    let mut record_body_payload_hexes = Vec::with_capacity(records.len());
    let mut publication_body_byte_length = 0usize;
    let mut canonical_byte_length = 0usize;
    for (index, record) in records.iter().enumerate() {
        let facets = canonical_nested_record_fields(record.as_ref());
        record_structural_attestations.push(facets.is_some());
        let canonical = supplied_canonical_records
            .map(|values| values[index].clone())
            .map_or_else(|| structural_record_canonical(record), Ok)?;
        canonical_byte_length = canonical_byte_length
            .checked_add(canonical.len())
            .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
        let digest = structural_record_digest(record)?;
        let record_id = format!("record:{}", digest.trim_start_matches("sha256:"));
        let publication = publication_record(
            record,
            facets.as_deref().unwrap_or(&[]),
            &record_id,
            &digest,
        )?;
        publication_body_byte_length = publication_body_byte_length
            .checked_add(publication.0.body_byte_length)
            .ok_or_else(|| {
                NativeCoreError::new("Structural publication byte length overflowed.")
            })?;
        publication_records.push(publication.0);
        record_body_payload_hexes.push(publication.1);
        record_ids.push(record_id);
        record_digests.push(digest);
        canonical_records.push(canonical);
        record_facets.push(facets);
    }
    let mut canonical_dependencies = Vec::with_capacity(dependencies.len());
    for (index, dependency) in dependencies.iter().enumerate() {
        let canonical = supplied_canonical_dependencies
            .map(|values| values[index].clone())
            .map_or_else(|| structural_dependency_canonical(dependency), Ok)?;
        canonical_byte_length = canonical_byte_length
            .checked_add(canonical.len())
            .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
        canonical_dependencies.push(canonical);
    }
    if canonical_byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }
    let publication_descriptor = StructuralPublicationDescriptor {
        record_count: record_ids.len(),
        body_byte_length: publication_body_byte_length,
        first_record_id: record_ids.first().cloned(),
        last_record_id: record_ids.last().cloned(),
        sequence_digest: canonical_array_digest(&record_digests),
    };
    Ok(StructuralKernelResult {
        records_digest: canonical_array_digest(&canonical_records),
        dependencies_digest: canonical_array_digest(&canonical_dependencies),
        canonical_records,
        canonical_dependencies,
        record_facets,
        record_structural_attestations,
        record_digests,
        record_ids,
        publication_records,
        record_body_payload_hexes,
        publication_descriptor,
        canonical_byte_length,
    })
}

/// P2-2f bytes-native per-record output: the same digests/ids/body/span
/// scalars as one `StructuralPublicationRecord` +
/// `record_body_payload_hexes[i]`, but `[u8; 32]`/raw `Vec<u8>` instead of
/// `sha256:`/`record:`-prefixed hex `String`s and a hex-encoded body, and
/// with `primary_source_span` collapsed to the two integers a caller
/// actually reads instead of kept around as a `serde_json::Value` tree.
///
/// Built for callers (`urdira-indexing-worker`'s v4 materialize pass) that
/// only need ids/digests/body bytes, never the canonical JSON text or the
/// N-API/JSON-shaped `StructuralPublicationRecord` -- see this crate's
/// evidence trail (P2-2f) for the allocation counts this removes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralKernelRow {
    pub record_id: [u8; 32],
    pub record_digest: [u8; 32],
    pub body_digest: [u8; 32],
    pub body_byte_length: usize,
    pub body: Vec<u8>,
    pub facets: Vec<String>,
    pub structural_attestation: bool,
    pub span_start: u32,
    pub span_end: u32,
    pub identity_type: &'static str,
    pub identity_key: String,
    pub identity_id: [u8; 32],
    pub identity_key_digest: [u8; 32],
    pub identity_assignment_id: [u8; 32],
}

/// Result of [`structural_kernel_rows`]: rows plus the summed
/// `body_byte_length`, which callers use the same way the N-API path uses
/// `StructuralKernelResult::canonical_byte_length` -- as the signal to
/// bisect a batch that is too large to process/hold in one shot.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StructuralKernelRows {
    pub rows: Vec<StructuralKernelRow>,
    pub byte_length: usize,
}

/// Pulls `start`/`end` out of an already-parsed `source_span` (always a
/// producer-emitted `{"path", "start", "end"}` JSON text -- see
/// `materialize.rs`'s module doc), without ever storing the parsed
/// `serde_json::Value` tree anywhere beyond this call: the tree is a
/// function-local temporary owned by the caller, never carried in a
/// per-record `Vec` the way `StructuralPublicationRecord::
/// primary_source_span` was. P2-2k: split out of the former
/// `source_span_bytes_from_text` so [`canonical_nested_record_fields_and_
/// span`] can call this on a `Value` it already parsed once, instead of
/// parsing `source_span` a second time.
fn span_start_end(span: &Value) -> (u32, u32) {
    let start = span
        .get("start")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let end = span
        .get("end")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    (start, end)
}

/// One record's [`StructuralKernelRow`]. `record_id` is literally the same
/// 32 bytes as `record_digest` (matching `structural_kernel_batch_parts_
/// with_canonical`'s `record_id = format!("record:{}", digest...)`: a
/// re-labeled copy of the digest, not a second hash -- see this function's
/// own body for the one place that distinction (the `record:`-prefixed
/// text form) still matters, as an input to `identity_assignment_id`'s
/// hash).
///
/// P2-2l item 3: `record_digest` is no longer a parameter -- this function
/// now computes it ITSELF, via [`fused_body_pass`], as part of the SAME
/// single walk of `record.body` that also produces `body_digest`/the body
/// payload bytes. Before this task, the caller computed `record_digest`
/// separately (via `structural_record_digest_bytes`, itself calling
/// `update_uce_value` over `record.body`) and handed it in as a plain
/// `[u8; 32]`, so `record.body` was walked TWICE per record: once for the
/// digest, once here for the body payload. See `fused_body_pass`'s own doc
/// comment for why merging the two walks into one is safe (item 3's own
/// depth-limit unification directly above makes `encode_publication_
/// body`'s checks a strict superset of `update_uce_value`'s, so nothing
/// this fused walk accepts/rejects differs from what the two original,
/// separately-called functions would have accepted/rejected together).
fn structural_kernel_row(
    record: StructuralKernelRecordRef<'_>,
    facets: Vec<String>,
    structural_attestation: bool,
    span: (u32, u32),
) -> NativeCoreResult<StructuralKernelRow> {
    // Same fixed field/hash sequence as `structural_record_digest_hash`
    // (unchanged, still used by the v3/N-API path), with `record.body`'s
    // own subtree fed through `fused_body_pass` -- which ALSO builds
    // `body_digest`/the body payload bytes in this same call -- instead of
    // a separate `update_uce_value` call. `Sha256::update` is purely
    // sequential (Merkle-Damgard), so feeding this hasher the identical
    // byte sequence `update_uce_value` would have fed it for `record.body`
    // produces the identical final digest, regardless of what is hashed
    // into it immediately before (the `[6]`/varint/`"body"` preamble
    // below) or after (the flat field hashes following this block).
    let mut record_hash = Sha256::new();
    record_hash.update([6]);
    update_varint(&mut record_hash, 10);
    update_uce_text(&mut record_hash, "body");

    // A3b: `Value` still walks the tree via `fused_body_pass` exactly as
    // before this task -- unchanged for every not-yet-migrated producer.
    // `Encoded` skips that walk entirely: the producer already ran the
    // equivalent traversal, once, through `BodyEncoder`, so the whole-record
    // hasher is fed the identical byte sequence directly
    // (`record_hash.update(&encoded.payload)` -- `Sha256::update` is purely
    // sequential, so this reproduces the identical `record_digest`), and
    // `body_digest`/`body_byte_length` are read straight off the already-
    // computed `EncodedBody`. See `BodyRef`'s own doc comment and the
    // `encoded_body_matches_value_body_oracle` test for the equivalence
    // proof.
    let (body_digest, body_byte_length, body) = match record.body {
        BodyRef::Value(value) => {
            let mut body_writer = LogicalDigestWriter::new("urdira:relational-value:v3");
            let mut body = Vec::new();
            fused_body_pass(value, &mut record_hash, &mut body_writer, &mut body, 1)?;
            let (body_digest, body_byte_length) = body_writer.finish_bytes();
            (body_digest, body_byte_length, body)
        }
        BodyRef::Encoded(encoded) => {
            record_hash.update(&encoded.payload);
            (
                encoded.body_digest,
                encoded.body_byte_length,
                encoded.payload.clone(),
            )
        }
        // A3b coste 2: identical to the `Encoded` arm above, except `record`
        // (taken by value into this function) already OWNS `encoded`, so
        // its `payload` can be moved straight into `StructuralKernelRow.
        // body` -- no `.clone()`. Byte-identical output to the `Encoded`
        // arm for the same bytes (`Sha256::update`/`body_digest`/
        // `body_byte_length` don't care whether the payload was borrowed or
        // owned), verified by this crate's `owned_encoded_body_matches_
        // borrowed_encoded_body` test.
        BodyRef::EncodedOwned(encoded) => {
            record_hash.update(&encoded.payload);
            (
                encoded.body_digest,
                encoded.body_byte_length,
                encoded.payload,
            )
        }
    };

    update_uce_key_value_text(&mut record_hash, "category", record.category);
    update_uce_key_value_text(
        &mut record_hash,
        "evidence_references",
        record.evidence_references,
    );
    update_uce_key_value_text(&mut record_hash, "facets", record.facets);
    update_uce_key_value_text(&mut record_hash, "identity_key", record.identity_key);
    update_uce_key_value_text(&mut record_hash, "kind", record.kind);
    update_uce_key_value_text(
        &mut record_hash,
        "proposal_record_key",
        record.proposal_record_key,
    );
    update_uce_text(&mut record_hash, "schema_version");
    record_hash.update([7]);
    record_hash.update((record.schema_version as f64).to_be_bytes());
    update_uce_key_value_text(&mut record_hash, "source_span", record.source_span);
    update_uce_key_value_text(&mut record_hash, "universal_kind", record.universal_kind);

    let record_digest = sha256_bytes(record_hash);
    let identity_type: &'static str = match record.category {
        "relation" => "relation",
        "diagnostic" => "diagnostic",
        _ => "entity",
    };
    // The one place this function still needs a text form of `record_id`:
    // `identity_assignment_id`'s hash input is `("record_id", "record:
    // <hex>")`, matching `publication_record`'s `uce_text_object_digest`
    // call byte for byte. Cheap (one ~71-byte allocation), unlike the
    // canonical-JSON/hex-body text this function otherwise avoids.
    let mut record_id_text = String::with_capacity(7 + record_digest.len() * 2);
    record_id_text.push_str("record:");
    push_hex_bytes(&mut record_id_text, &record_digest);
    let identity_key_digest = uce_text_digest_bytes(record.identity_key);
    let identity_id = uce_text_object_digest_bytes(&[("identity_key", record.identity_key)]);
    let identity_assignment_id = uce_text_object_digest_bytes(&[
        ("identity_key", record.identity_key),
        ("record_id", &record_id_text),
    ]);
    let (span_start, span_end) = span;
    Ok(StructuralKernelRow {
        record_id: record_digest,
        record_digest,
        body_digest,
        body_byte_length,
        body,
        facets,
        structural_attestation,
        span_start,
        span_end,
        identity_type,
        identity_key: record.identity_key.to_owned(),
        identity_id,
        identity_key_digest,
        identity_assignment_id,
    })
}

/// Bytes-native counterpart of [`structural_kernel_batch_parts`], scoped to
/// records only (P2-2f): `urdira-indexing-worker`'s v4 materialize pass
/// never reads `StructuralKernelResult`'s dependency-canonicalization
/// output (`canonical_dependencies`/`dependencies_digest`) or its
/// record-side canonical-JSON/text fields (`canonical_records`,
/// `records_digest`, `record_ids`, `record_digests`,
/// `record_structural_attestations`, `record_facets`,
/// `publication_descriptor`) at all -- it only ever reads
/// `publication_records` and `record_body_payload_hexes`. This function
/// computes exactly that subset, through the SAME digest/canonicalization
/// primitives (`structural_record_digest_hash`, `canonical_nested_record_
/// fields`, `encode_publication_body`, the `uce_text_*` recipes) so every
/// id/digest/body byte is byte-identical to what
/// `structural_kernel_batch_parts` would have produced for the same input
/// -- verified by the `native_core_rows_match_batch_parts_oracle` test.
///
/// The row-count bound (`MAX_BATCH_RECORDS`) and a byte-length bound
/// (`MAX_BATCH_FRAMED_BYTES`, applied to summed body bytes rather than
/// summed canonical-JSON-text bytes -- there is no canonical JSON text on
/// this path, and nothing downstream of this function ever crosses an
/// N-API/JSON boundary with it) are both still enforced, so a caller that
/// bisects on this function's `Err` retains the same safety valve against
/// unbounded per-call memory.
pub fn structural_kernel_rows(
    records: &[StructuralKernelRecord],
) -> NativeCoreResult<StructuralKernelRows> {
    let refs: Vec<StructuralKernelRecordRef<'_>> =
        records.iter().map(StructuralKernelRecord::as_ref).collect();
    structural_kernel_rows_ref(&refs)
}

/// P2-2g item 3: borrowed-input sibling of [`structural_kernel_rows`] --
/// same output, same digest/canonicalization primitives, but takes
/// [`StructuralKernelRecordRef`] directly instead of an owned
/// `StructuralKernelRecord`. Lets a caller that already holds these fields
/// inside a larger owned structure (`urdira-indexing-worker`'s v4
/// `materialize.rs`, holding `ProposedRecord`s) skip cloning every
/// `String`/`Value` field into a temporary `StructuralKernelRecord` per
/// record purely to call the kernel -- on n8n's 1.5M records that clone was
/// 7 `String`s + 1 `body: Value` tree per record (see this task's evidence
/// doc). `structural_kernel_rows` above is now a thin wrapper over this
/// function, so both entrypoints stay byte-identical by construction.
pub fn structural_kernel_rows_ref(
    records: &[StructuralKernelRecordRef<'_>],
) -> NativeCoreResult<StructuralKernelRows> {
    if records.len() > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let mut rows = Vec::with_capacity(records.len());
    let mut byte_length = 0usize;
    // P2-2k lever (e): one reused canonical-JSON scratch buffer and one
    // reused facet-dedup set for the whole batch, instead of allocating a
    // fresh `String`/`HashSet` per record purely to throw them away after
    // one comparison -- see `canonical_json_matches`'s doc comment.
    let mut canonical_scratch = String::new();
    let mut facet_dedup = HashSet::new();
    for record in records {
        let (facets, span) = canonical_nested_record_fields_and_span(
            record,
            &mut canonical_scratch,
            &mut facet_dedup,
        );
        let structural_attestation = facets.is_some();
        // A3b coste 2: `.clone()` here (not a `Copy` deref any more --
        // `BodyRef::EncodedOwned` cost `StructuralKernelRecordRef` its
        // `Copy` impl) -- every record this borrowed-slice entrypoint ever
        // sees carries `BodyRef::Value`/`Encoded` (a plain reference, never
        // `EncodedOwned`), so this clone is exactly as cheap as the old
        // implicit `Copy` was: no owned payload bytes are ever duplicated
        // here. `structural_kernel_rows_owned_typed` (below) is the
        // zero-clone sibling for a caller that owns `EncodedOwned` bodies.
        let row = structural_kernel_row(
            record.clone(),
            facets.unwrap_or_default(),
            structural_attestation,
            span,
        )?;
        byte_length = byte_length
            .checked_add(row.body_byte_length)
            .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
        rows.push(row);
    }
    if byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }
    Ok(StructuralKernelRows { rows, byte_length })
}

/// P2-2l item 2: typed-facets sibling of [`structural_kernel_rows_ref`],
/// additive (does NOT change [`StructuralKernelRecordRef`] itself, so
/// every existing caller of that struct/of `structural_kernel_rows_ref` --
/// including `urdira-indexing-worker`'s own residual pass, out of this
/// task's crate-ownership scope -- keeps compiling and behaving
/// identically). `structural_kernel_rows_ref`'s hot loop calls
/// `canonical_nested_record_fields_and_span`, which parses `record.facets`/
/// `.evidence_references` back out of their own canonical-JSON TEXT into a
/// generic `serde_json::Value` tree purely to re-verify canonical form and
/// pull the facet list back out -- P2-2k's own profiling found this among
/// Pass 1's largest remaining costs on n8n (`Index::index_into` +
/// `Value::deserialize` + `skip_to_escape` + `format_escaped_str` ~13% of
/// leaf samples). For `urdira-indexing-worker`'s v4 hot path this
/// round-trip is PROVABLY a no-op: every `ProposedRecord` producer that
/// feeds it (`urdira-jsts-syntax-worker`'s `lib.rs`/`semantic_sites.rs`,
/// confirmed by reading every one of their 9 construction sites this task
/// audited) builds `facets`/`source_span`/`evidence_references` via
/// `canonical_json`/`canonical_span`/`canonical_evidence` -- the SAME
/// function this crate's own canonical-form check compares against -- so
/// the text is canonical by construction and the check can never fail for
/// it. This entrypoint accepts the typed facet list
/// (`ProposedRecord::facets_list`, populated by every one of those
/// producers alongside the text) directly, per record, skips the generic
/// `Value` parse+validate for `facets`/`evidence_references` entirely
/// (`evidence_references`'s parsed tree was NEVER read for anything beyond
/// that validation -- confirmed by reading `canonical_nested_record_
/// fields`/`_and_span` directly: no field of `StructuralKernelRow` is ever
/// populated from it), and unconditionally sets `structural_attestation =
/// true` (matching what the untyped path would ALSO compute for this
/// input, per the argument above). `source_span` is still parsed (its
/// `start`/`end` ARE read, by `structural_kernel_row`), just without the
/// no-op canonical-form comparison. Every other step -- `structural_
/// record_digest_hash` (same `record.facets`/`.evidence_references` TEXT,
/// unchanged), `structural_kernel_row`'s body encoding -- is IDENTICAL to
/// the untyped path, so output is byte-for-byte identical whenever the
/// typed facet list matches what parsing `record.facets` would have
/// produced -- verified by `typed_rows_match_untyped_rows_oracle`, below,
/// and by live n8n root reproduction (this task's evidence entry).
pub fn structural_kernel_rows_typed(
    records: &[StructuralKernelRecordRef<'_>],
    typed_facets: &[&[String]],
) -> NativeCoreResult<StructuralKernelRows> {
    if records.len() != typed_facets.len() {
        return Err(NativeCoreError::new(
            "Structural kernel typed facets length does not match record count.",
        ));
    }
    if records.len() > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let mut rows = Vec::with_capacity(records.len());
    let mut byte_length = 0usize;
    // A3b coste 2: `.clone()`, same rationale as `structural_kernel_rows_
    // ref`'s loop above -- every caller of this borrowed-slice entrypoint
    // only ever supplies `BodyRef::Value`/`Encoded`, so this is exactly as
    // cheap as the `Copy` deref it replaces.
    for (record, &facets) in records.iter().zip(typed_facets.iter()) {
        let span = parse_span_start_end(record.source_span);
        let row = structural_kernel_row(record.clone(), facets.to_vec(), true, span)?;
        byte_length = byte_length
            .checked_add(row.body_byte_length)
            .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
        rows.push(row);
    }
    if byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }
    Ok(StructuralKernelRows { rows, byte_length })
}

/// A3b coste 2: owned-input sibling of [`structural_kernel_rows_typed`] --
/// identical bounds/behavior, but takes `records` as an OWNED `Vec` (not
/// `&[...]`) and consumes it with `into_iter()` instead of `.iter().cloned()`.
/// This is the entrypoint a caller whose records carry `BodyRef::
/// EncodedOwned` bodies (an owned `EncodedBody`, not merely a borrow of one)
/// must use to actually realize the saving that variant exists for: moving
/// each record out of `records` moves its `EncodedOwned` payload straight
/// into `structural_kernel_row`, with no `encoded.payload.clone()` anywhere
/// on this path (contrast `structural_kernel_rows_typed`'s `record.clone()`,
/// which -- for a hypothetical `EncodedOwned` record -- would clone the
/// payload right back). Used by `urdira-indexing-worker`'s v4
/// `canonicalize_owner`, the only place in this pipeline that both owns its
/// `ProposedRecord`s outright and materializes them through the typed-facets
/// path. `typed_facets` stays a borrowed slice: it is never consumed, only
/// read, so there is nothing to move out of it.
pub fn structural_kernel_rows_owned_typed(
    records: Vec<StructuralKernelRecordRef<'_>>,
    typed_facets: &[&[String]],
) -> NativeCoreResult<StructuralKernelRows> {
    if records.len() != typed_facets.len() {
        return Err(NativeCoreError::new(
            "Structural kernel typed facets length does not match record count.",
        ));
    }
    if records.len() > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let mut rows = Vec::with_capacity(records.len());
    let mut byte_length = 0usize;
    for (record, &facets) in records.into_iter().zip(typed_facets.iter()) {
        let span = parse_span_start_end(record.source_span);
        let row = structural_kernel_row(record, facets.to_vec(), true, span)?;
        byte_length = byte_length
            .checked_add(row.body_byte_length)
            .ok_or_else(|| NativeCoreError::new("Structural kernel byte length overflowed."))?;
        rows.push(row);
    }
    if byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural kernel batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }
    Ok(StructuralKernelRows { rows, byte_length })
}

/// Revalidates canonical producer rows without first rebuilding their nested
/// JavaScript object graphs. This is deliberately an independent core pass:
/// producer-side preseal is an optimization, never acceptance authority.
fn structural_payload_property_matches(
    value: &Value,
    property: &StructuralPayloadProperty,
) -> bool {
    if let Some(values) = &property.r#enum
        && value
            .as_str()
            .is_none_or(|candidate| !values.iter().any(|entry| entry == candidate))
    {
        return false;
    }
    match property.value_type.as_str() {
        "string" => value.is_string(),
        "integer" => value.as_i64().is_some_and(|candidate| {
            candidate.unsigned_abs() <= MAX_SAFE_INTEGER as u64
                && property.minimum.is_none_or(|minimum| candidate >= minimum)
                && property.maximum.is_none_or(|maximum| candidate <= maximum)
        }),
        "boolean" => value.is_boolean(),
        "array" => value.as_array().is_some_and(|entries| {
            property.items.as_ref().is_none_or(|items| {
                entries
                    .iter()
                    .all(|entry| structural_payload_property_matches(entry, items))
            })
        }),
        "object" => {
            value.as_object().is_some_and(|object| {
                if let Some(properties) = &property.properties {
                    if object.keys().any(|key| !properties.contains_key(key)) {
                        return false;
                    }
                    if property.required.as_ref().is_some_and(|required| {
                        required.iter().any(|key| !object.contains_key(key))
                    }) {
                        return false;
                    }
                    properties.iter().all(|(key, child)| {
                        object
                            .get(key)
                            .is_none_or(|entry| structural_payload_property_matches(entry, child))
                    })
                } else {
                    true
                }
            })
        }
        _ => false,
    }
}

fn structural_record_matches_definition(
    record: &StructuralKernelRecord,
    facets: Option<&[String]>,
    definition: Option<&StructuralRecordDefinition>,
) -> bool {
    let (Some(facets), Some(definition)) = (facets, definition) else {
        return false;
    };
    if record.category != definition.category
        || record.universal_kind != definition.universal_kind
        || record.schema_version != definition.schema_version
        || facets.iter().collect::<HashSet<_>>().len() != facets.len()
        || facets
            .iter()
            .any(|facet| !definition.allowed_facets.contains(facet))
        || definition
            .required_facets
            .iter()
            .any(|facet| !facets.contains(facet))
    {
        return false;
    }
    definition.body_schema.as_ref().is_none_or(|schema| {
        schema.value_type == "object"
            && schema.additional_properties == Some(false)
            && record.body.as_object().is_some_and(|body| {
                !body.keys().any(|key| !schema.properties.contains_key(key))
                    && !schema.required.iter().any(|key| !body.contains_key(key))
                    && schema.properties.iter().all(|(key, property)| {
                        body.get(key).is_none_or(|value| {
                            structural_payload_property_matches(value, property)
                        })
                    })
            })
    })
}

pub fn structural_kernel_canonical_batch(
    batch: &StructuralKernelCanonicalBatch,
) -> NativeCoreResult<StructuralKernelCanonicalResult> {
    structural_kernel_canonical_batch_parts(
        &batch.canonical_records,
        &batch.canonical_dependencies,
        &batch.record_definitions,
    )
}

/// Borrowed canonical-row variant used by the Rust indexing core. It avoids
/// cloning the producer's bounded canonical vectors merely to validate them.
pub fn structural_kernel_canonical_batch_parts(
    canonical_records: &[String],
    canonical_dependencies: &[String],
    record_definitions: &[StructuralRecordDefinition],
) -> NativeCoreResult<StructuralKernelCanonicalResult> {
    structural_kernel_canonical_batch_parts_with_records(
        canonical_records,
        canonical_dependencies,
        record_definitions,
    )
    .map(|(result, _)| result)
}

/// Borrowed canonical-row variant that also returns the parsed records used
/// during validation. The indexing core uses this to avoid parsing every
/// canonical JSON row a second time while preparing its SQLite staging rows.
pub fn structural_kernel_canonical_batch_parts_with_records(
    canonical_records: &[String],
    canonical_dependencies: &[String],
    record_definitions: &[StructuralRecordDefinition],
) -> NativeCoreResult<(StructuralKernelCanonicalResult, Vec<StructuralKernelRecord>)> {
    let row_count = canonical_records
        .len()
        .checked_add(canonical_dependencies.len())
        .ok_or_else(|| NativeCoreError::new("Structural canonical batch row count overflowed."))?;
    if row_count > MAX_BATCH_RECORDS {
        return Err(NativeCoreError::new(format!(
            "Structural canonical batch exceeds the {MAX_BATCH_RECORDS}-row bound."
        )));
    }
    let canonical_byte_length = canonical_records
        .iter()
        .chain(canonical_dependencies.iter())
        .try_fold(0usize, |total, row| total.checked_add(row.len()))
        .ok_or_else(|| {
            NativeCoreError::new("Structural canonical batch byte length overflowed.")
        })?;
    if canonical_byte_length > MAX_BATCH_FRAMED_BYTES {
        return Err(NativeCoreError::new(format!(
            "Structural canonical batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
        )));
    }

    let mut records = Vec::with_capacity(canonical_records.len());
    for canonical in canonical_records {
        let record: StructuralKernelRecord = serde_json::from_str(canonical).map_err(|error| {
            NativeCoreError::new(format!("Structural canonical record is invalid: {error}"))
        })?;
        if structural_record_canonical(&record)? != *canonical {
            return Err(NativeCoreError::new(
                "Structural canonical record is not in exact canonical form.",
            ));
        }
        records.push(record);
    }
    let mut dependencies = Vec::with_capacity(canonical_dependencies.len());
    for canonical in canonical_dependencies {
        let dependency: StructuralKernelDependency =
            serde_json::from_str(canonical).map_err(|error| {
                NativeCoreError::new(format!(
                    "Structural canonical dependency is invalid: {error}"
                ))
            })?;
        if structural_dependency_canonical(&dependency)? != *canonical {
            return Err(NativeCoreError::new(
                "Structural canonical dependency is not in exact canonical form.",
            ));
        }
        dependencies.push(dependency);
    }
    let definitions = record_definitions
        .iter()
        .map(|definition| (definition.kind.as_str(), definition))
        .collect::<HashMap<_, _>>();
    if definitions.len() != record_definitions.len() {
        return Err(NativeCoreError::new(
            "Structural canonical record definitions contain a duplicate kind.",
        ));
    }
    let record_schema_attestations = records
        .iter()
        .map(|record| {
            let facets = canonical_nested_record_fields(record.as_ref());
            structural_record_matches_definition(
                record,
                facets.as_deref(),
                definitions.get(record.kind.as_str()).copied(),
            )
        })
        .collect();
    let accepted_records = records
        .iter()
        .map(|record| StructuralAcceptedRecord {
            proposal_record_key: record.proposal_record_key.clone(),
            category: record.category.clone(),
            kind: record.kind.clone(),
            universal_kind: record.universal_kind.clone(),
            schema_version: record.schema_version,
            identity_key: record.identity_key.clone(),
        })
        .collect();
    let kernel = structural_kernel_batch_parts_with_canonical(
        &records,
        &dependencies,
        Some(canonical_records),
        Some(canonical_dependencies),
    )?;
    Ok((
        StructuralKernelCanonicalResult {
            kernel,
            records: accepted_records,
            dependencies,
            record_schema_attestations,
        },
        records,
    ))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogicalField {
    pub identifier: String,
    pub present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<LogicalValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LogicalValue {
    Null,
    Boolean {
        value: bool,
    },
    Integer {
        value: String,
    },
    Real {
        value: f64,
    },
    Text {
        value: String,
    },
    Bytes {
        value: Vec<u8>,
    },
    Sequence {
        values: Vec<LogicalValue>,
    },
    Set {
        values: Vec<LogicalValue>,
    },
    /// Schema-owned nested fields in their already resolved canonical order.
    /// This is not the object-sorting convenience behavior of TypeScript `value(object)`.
    Record {
        fields: Vec<LogicalField>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogicalRecord {
    pub domain: String,
    pub fields: Vec<LogicalField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalDigestResult {
    pub digest: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogicalRecordVerification {
    #[serde(flatten)]
    pub record: LogicalRecord,
    pub expected_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogicalValueRecord {
    pub domain: String,
    pub value: LogicalValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogicalValueVerification {
    #[serde(flatten)]
    pub record: LogicalValueRecord,
    pub expected_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogicalVerificationResult {
    pub valid: bool,
    pub actual_digest: String,
    pub byte_length: usize,
}

struct LogicalDigestWriter {
    hash: Sha256,
    byte_length: usize,
}

impl LogicalDigestWriter {
    fn new(domain: &str) -> Self {
        let mut writer = Self {
            hash: Sha256::new(),
            byte_length: 0,
        };
        writer.text(domain);
        writer
    }

    fn field(&mut self, field: &LogicalField, depth: usize) -> NativeCoreResult<()> {
        self.text(&field.identifier);
        self.boolean(field.present);
        match (field.present, field.value.as_ref()) {
            (true, Some(value)) => self.value(value, depth),
            (true, None) => Err(NativeCoreError::new(format!(
                "Logical field '{}' is present but has no value.",
                field.identifier
            ))),
            (false, None) => Ok(()),
            (false, Some(_)) => Err(NativeCoreError::new(format!(
                "Logical field '{}' is absent but carries a value.",
                field.identifier
            ))),
        }
    }

    fn value(&mut self, value: &LogicalValue, depth: usize) -> NativeCoreResult<()> {
        if depth > MAX_LOGICAL_DEPTH {
            return Err(NativeCoreError::new(
                "Logical digest value exceeds the maximum depth.",
            ));
        }
        match value {
            LogicalValue::Null => self.tag(3),
            LogicalValue::Boolean { value } => self.boolean(*value),
            LogicalValue::Integer { value } => {
                validate_integer(value)?;
                self.tag(5);
                self.text(value);
            }
            LogicalValue::Real { value } => {
                if !value.is_finite() || value.to_bits() == (-0.0_f64).to_bits() {
                    return Err(NativeCoreError::new(
                        "Logical digest real values must be finite and not negative zero.",
                    ));
                }
                self.tag(6);
                self.raw(&value.to_be_bytes());
            }
            LogicalValue::Text { value } => self.text(value),
            LogicalValue::Bytes { value } => {
                self.tag(8);
                self.length(value.len());
                self.raw(value);
            }
            LogicalValue::Sequence { values } => {
                validate_collection_length(values.len())?;
                self.tag(9);
                self.length(values.len());
                for value in values {
                    self.value(value, depth + 1)?;
                }
            }
            LogicalValue::Set { values } => {
                validate_collection_length(values.len())?;
                self.tag(10);
                self.length(values.len());
                for value in values {
                    self.value(value, depth + 1)?;
                }
            }
            LogicalValue::Record { fields } => {
                validate_fields(fields)?;
                validate_collection_length(fields.len())?;
                self.tag(10);
                self.length(fields.len());
                for field in fields {
                    self.field(field, depth + 1)?;
                }
            }
        }
        Ok(())
    }

    fn boolean(&mut self, value: bool) {
        self.tag(4);
        self.byte(u8::from(value));
    }

    fn text(&mut self, value: &str) {
        let bytes = value.as_bytes();
        self.tag(7);
        self.length(bytes.len());
        self.raw(bytes);
    }

    fn tag(&mut self, value: u8) {
        self.byte(value);
    }

    fn byte(&mut self, value: u8) {
        self.hash.update([value]);
        self.byte_length += 1;
    }

    fn length(&mut self, value: usize) {
        let mut current = value;
        loop {
            let mut byte = (current % 128) as u8;
            current /= 128;
            if current > 0 {
                byte |= 0x80;
            }
            self.byte(byte);
            if current == 0 {
                break;
            }
        }
    }

    fn raw(&mut self, value: &[u8]) {
        self.hash.update(value);
        self.byte_length += value.len();
    }

    fn finish(self) -> LogicalDigestResult {
        let digest_bytes = self.hash.finalize();
        let mut digest = String::with_capacity(71);
        digest.push_str("sha256:");
        for byte in digest_bytes {
            write!(&mut digest, "{byte:02x}").expect("writing to String cannot fail");
        }
        LogicalDigestResult {
            digest,
            byte_length: self.byte_length,
        }
    }

    /// Bytes-native counterpart of [`Self::finish`] (P2-2f): same hash, no
    /// `sha256:`-prefixed `String` ever built. Used by
    /// [`structural_kernel_rows`], whose callers want `[u8; 32]` digests
    /// directly.
    fn finish_bytes(self) -> ([u8; 32], usize) {
        (self.hash.finalize().into(), self.byte_length)
    }
}

fn validate_integer(value: &str) -> NativeCoreResult<()> {
    let bytes = value.as_bytes();
    let valid = match bytes {
        [b'0'] => true,
        [b'-', first, rest @ ..] => {
            matches!(first, b'1'..=b'9') && rest.iter().all(u8::is_ascii_digit)
        }
        [first, rest @ ..] => matches!(first, b'1'..=b'9') && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(NativeCoreError::new(
            "Logical digest integer text is not canonical.",
        ))
    }
}

fn validate_collection_length(length: usize) -> NativeCoreResult<()> {
    if length <= MAX_BATCH_RECORDS {
        Ok(())
    } else {
        Err(NativeCoreError::new(format!(
            "Logical collection exceeds the {MAX_BATCH_RECORDS}-item bound."
        )))
    }
}

fn validate_fields(fields: &[LogicalField]) -> NativeCoreResult<()> {
    validate_collection_length(fields.len())?;
    let mut identifiers = HashSet::with_capacity(fields.len());
    for field in fields {
        if !identifiers.insert(field.identifier.as_str()) {
            return Err(NativeCoreError::new(format!(
                "Logical record contains duplicate field identifier '{}'.",
                field.identifier
            )));
        }
    }
    Ok(())
}

fn digest_record(record: &LogicalRecord) -> NativeCoreResult<LogicalDigestResult> {
    validate_fields(&record.fields)?;
    let mut writer = LogicalDigestWriter::new(&record.domain);
    for field in &record.fields {
        writer.field(field, 1)?;
    }
    Ok(writer.finish())
}

fn validate_batch_length(length: usize) -> NativeCoreResult<()> {
    if length <= MAX_BATCH_RECORDS {
        Ok(())
    } else {
        Err(NativeCoreError::new(format!(
            "Native batch exceeds the {MAX_BATCH_RECORDS}-record bound."
        )))
    }
}

pub fn logical_digest_batch(
    records: &[LogicalRecord],
) -> NativeCoreResult<Vec<LogicalDigestResult>> {
    validate_batch_length(records.len())?;
    let mut total_bytes = 0usize;
    let mut results = Vec::with_capacity(records.len());
    for record in records {
        let result = digest_record(record)?;
        total_bytes = total_bytes.checked_add(result.byte_length).ok_or_else(|| {
            NativeCoreError::new("Native logical digest batch byte length overflowed.")
        })?;
        if total_bytes > MAX_BATCH_FRAMED_BYTES {
            return Err(NativeCoreError::new(format!(
                "Native logical digest batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
            )));
        }
        results.push(result);
    }
    Ok(results)
}

pub fn verify_logical_record_batch(
    records: &[LogicalRecordVerification],
) -> NativeCoreResult<Vec<LogicalVerificationResult>> {
    validate_batch_length(records.len())?;
    for record in records {
        if !is_digest(&record.expected_digest) {
            return Err(NativeCoreError::new(
                "Expected logical digest must be lowercase sha256 text.",
            ));
        }
    }
    let logical_records = records
        .iter()
        .map(|item| item.record.clone())
        .collect::<Vec<_>>();
    let digests = logical_digest_batch(&logical_records)?;
    Ok(digests
        .into_iter()
        .zip(records)
        .map(|(actual, expected)| LogicalVerificationResult {
            valid: actual.digest == expected.expected_digest,
            actual_digest: actual.digest,
            byte_length: actual.byte_length,
        })
        .collect())
}

fn digest_logical_value_record(
    record: &LogicalValueRecord,
) -> NativeCoreResult<LogicalDigestResult> {
    let mut writer = LogicalDigestWriter::new(&record.domain);
    writer.value(&record.value, 1)?;
    Ok(writer.finish())
}

pub fn logical_value_digest_batch(
    records: &[LogicalValueRecord],
) -> NativeCoreResult<Vec<LogicalDigestResult>> {
    validate_batch_length(records.len())?;
    let mut total_bytes = 0usize;
    let mut results = Vec::with_capacity(records.len());
    for record in records {
        let result = digest_logical_value_record(record)?;
        total_bytes = total_bytes.checked_add(result.byte_length).ok_or_else(|| {
            NativeCoreError::new("Native logical value batch byte length overflowed.")
        })?;
        if total_bytes > MAX_BATCH_FRAMED_BYTES {
            return Err(NativeCoreError::new(format!(
                "Native logical value batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
            )));
        }
        results.push(result);
    }
    Ok(results)
}

pub fn verify_logical_value_batch(
    records: &[LogicalValueVerification],
) -> NativeCoreResult<Vec<LogicalVerificationResult>> {
    validate_batch_length(records.len())?;
    for record in records {
        if !is_digest(&record.expected_digest) {
            return Err(NativeCoreError::new(
                "Expected logical digest must be lowercase sha256 text.",
            ));
        }
    }
    let logical_records = records
        .iter()
        .map(|item| item.record.clone())
        .collect::<Vec<_>>();
    let digests = logical_value_digest_batch(&logical_records)?;
    Ok(digests
        .into_iter()
        .zip(records)
        .map(|(actual, expected)| LogicalVerificationResult {
            valid: actual.digest == expected.expected_digest,
            actual_digest: actual.digest,
            byte_length: actual.byte_length,
        })
        .collect())
}

fn is_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DistanceMetric {
    Cosine,
    SquaredL2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorCandidate {
    pub id: String,
    pub vector: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExactVectorRequest {
    pub query: Vec<f64>,
    pub candidates: Vec<VectorCandidate>,
    pub k: usize,
    pub metric: DistanceMetric,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VectorTopKMatch {
    pub projection_record_id: String,
    pub rank: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedVectorElementType {
    Float32Le,
    Float64Le,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackedExactVectorRequest {
    pub query: Vec<u8>,
    pub candidates: Vec<u8>,
    pub projection_record_ids: Vec<String>,
    pub dimensions: usize,
    pub element_type: PackedVectorElementType,
    pub k: usize,
    pub metric: DistanceMetric,
}

pub fn exact_packed_vector_top_k_batch(
    requests: &[PackedExactVectorRequest],
) -> NativeCoreResult<Vec<Vec<VectorTopKMatch>>> {
    validate_batch_length(requests.len())?;
    let mut packed_bytes = 0usize;
    let decoded = requests
        .iter()
        .map(|request| {
            packed_bytes = packed_bytes
                .checked_add(request.query.len())
                .and_then(|value| value.checked_add(request.candidates.len()))
                .ok_or_else(|| NativeCoreError::new("Packed vector byte length overflowed."))?;
            if packed_bytes > MAX_BATCH_FRAMED_BYTES {
                return Err(NativeCoreError::new(format!(
                    "Packed vector batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
                )));
            }
            decode_packed_vector_request(request)
        })
        .collect::<NativeCoreResult<Vec<_>>>()?;
    exact_vector_top_k_batch(&decoded)
}

fn decode_packed_vector_request(
    request: &PackedExactVectorRequest,
) -> NativeCoreResult<ExactVectorRequest> {
    if request.dimensions == 0 {
        return Err(NativeCoreError::new(
            "Packed exact vector dimensions must be positive.",
        ));
    }
    let width = match request.element_type {
        PackedVectorElementType::Float32Le => 4,
        PackedVectorElementType::Float64Le => 8,
    };
    let vector_bytes = request
        .dimensions
        .checked_mul(width)
        .ok_or_else(|| NativeCoreError::new("Packed exact vector byte length overflowed."))?;
    if request.query.len() != vector_bytes {
        return Err(NativeCoreError::new(
            "Packed exact vector query has an invalid byte length.",
        ));
    }
    let candidate_bytes = request
        .projection_record_ids
        .len()
        .checked_mul(vector_bytes)
        .ok_or_else(|| NativeCoreError::new("Packed exact vector byte length overflowed."))?;
    if request.candidates.len() != candidate_bytes {
        return Err(NativeCoreError::new(
            "Packed exact vector candidates have an invalid byte length.",
        ));
    }
    let query = decode_vector_bytes(&request.query, request.element_type);
    let candidates = request
        .candidates
        .chunks_exact(vector_bytes)
        .zip(&request.projection_record_ids)
        .map(|(bytes, id)| VectorCandidate {
            id: id.clone(),
            vector: decode_vector_bytes(bytes, request.element_type),
        })
        .collect();
    Ok(ExactVectorRequest {
        query,
        candidates,
        k: request.k,
        metric: request.metric,
    })
}

fn decode_vector_bytes(bytes: &[u8], element_type: PackedVectorElementType) -> Vec<f64> {
    match element_type {
        PackedVectorElementType::Float32Le => bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk) as f64)
            .collect(),
        PackedVectorElementType::Float64Le => bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| f64::from_le_bytes(*chunk))
            .collect(),
    }
}

pub fn exact_vector_top_k_batch(
    requests: &[ExactVectorRequest],
) -> NativeCoreResult<Vec<Vec<VectorTopKMatch>>> {
    validate_batch_length(requests.len())?;
    let mut total_candidates = 0usize;
    let mut total_bytes = 0usize;
    let mut batches = Vec::with_capacity(requests.len());
    for request in requests {
        if request.query.is_empty() {
            return Err(NativeCoreError::new(
                "Exact vector query must not be empty.",
            ));
        }
        if request.k == 0 {
            return Err(NativeCoreError::new("Exact vector top-k must be positive."));
        }
        total_candidates = total_candidates
            .checked_add(request.candidates.len())
            .ok_or_else(|| NativeCoreError::new("Exact vector candidate count overflowed."))?;
        if total_candidates > MAX_BATCH_RECORDS {
            return Err(NativeCoreError::new(format!(
                "Exact vector batch exceeds the {MAX_BATCH_RECORDS}-candidate bound."
            )));
        }
        total_bytes = vector_request_bytes(request, total_bytes)?;
        if total_bytes > MAX_BATCH_FRAMED_BYTES {
            return Err(NativeCoreError::new(format!(
                "Exact vector batch exceeds the {MAX_BATCH_FRAMED_BYTES}-byte bound."
            )));
        }
        batches.push(exact_vector_top_k(request)?);
    }
    Ok(batches)
}

fn vector_request_bytes(request: &ExactVectorRequest, previous: usize) -> NativeCoreResult<usize> {
    let scalar_count = request
        .candidates
        .iter()
        .try_fold(request.query.len(), |count, candidate| {
            count.checked_add(candidate.vector.len())
        })
        .ok_or_else(|| NativeCoreError::new("Exact vector scalar count overflowed."))?;
    let identifier_bytes = request
        .candidates
        .iter()
        .try_fold(0usize, |count, candidate| {
            count.checked_add(candidate.id.len())
        })
        .ok_or_else(|| NativeCoreError::new("Exact vector identifier bytes overflowed."))?;
    previous
        .checked_add(
            scalar_count
                .checked_mul(8)
                .ok_or_else(|| NativeCoreError::new("Exact vector byte length overflowed."))?,
        )
        .and_then(|value| value.checked_add(identifier_bytes))
        .ok_or_else(|| NativeCoreError::new("Exact vector byte length overflowed."))
}

fn exact_vector_top_k(request: &ExactVectorRequest) -> NativeCoreResult<Vec<VectorTopKMatch>> {
    validate_vector(&request.query, request.query.len(), "query")?;
    let mut identifiers = HashSet::with_capacity(request.candidates.len());
    let mut ranked = Vec::with_capacity(request.candidates.len());
    for candidate in &request.candidates {
        if !identifiers.insert(candidate.id.as_str()) {
            return Err(NativeCoreError::new(format!(
                "Exact vector batch contains duplicate candidate identifier '{}'.",
                candidate.id
            )));
        }
        validate_vector(&candidate.vector, request.query.len(), "candidate")?;
        let distance = vector_distance(&candidate.vector, &request.query, request.metric)?;
        ranked.push((candidate.id.as_str(), distance));
    }
    ranked.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.as_bytes().cmp(right.0.as_bytes()))
    });
    Ok(ranked
        .into_iter()
        .take(request.k)
        .enumerate()
        .map(|(index, (id, _))| VectorTopKMatch {
            projection_record_id: id.to_owned(),
            rank: index + 1,
        })
        .collect())
}

fn validate_vector(vector: &[f64], dimensions: usize, label: &str) -> NativeCoreResult<()> {
    if vector.len() != dimensions || vector.iter().any(|value| !value.is_finite()) {
        return Err(NativeCoreError::new(format!(
            "Exact vector {label} has invalid dimensions or values."
        )));
    }
    Ok(())
}

fn vector_distance(left: &[f64], right: &[f64], metric: DistanceMetric) -> NativeCoreResult<f64> {
    match metric {
        DistanceMetric::SquaredL2 => {
            let mut distance = 0.0;
            for (left, right) in left.iter().zip(right) {
                let difference = left - right;
                distance += difference * difference;
                if !distance.is_finite() {
                    return Err(NativeCoreError::new("Exact vector distance is not finite."));
                }
            }
            Ok(distance)
        }
        DistanceMetric::Cosine => {
            let mut dot = 0.0;
            let mut left_norm = 0.0;
            let mut right_norm = 0.0;
            for (left, right) in left.iter().zip(right) {
                dot += left * right;
                left_norm += left * left;
                right_norm += right * right;
            }
            if left_norm == 0.0 || right_norm == 0.0 {
                return Err(NativeCoreError::new(
                    "Cosine exact vector top-k does not accept zero vectors.",
                ));
            }
            if !dot.is_finite() || !left_norm.is_finite() || !right_norm.is_finite() {
                return Err(NativeCoreError::new("Exact vector distance is not finite."));
            }
            let distance = 1.0 - dot / (left_norm * right_norm).sqrt();
            if distance.is_finite() {
                Ok(distance)
            } else {
                Err(NativeCoreError::new("Exact vector distance is not finite."))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Frente S-I (2026-09-08, plan `generic-waddling-hartmanis.md` §0): resident
// vector buffer + single-call exact top-k.
//
// `exact_packed_vector_top_k_batch` above (and `exact_vector_top_k_batch`/
// `exact_vector_top_k`) pay THREE costs on every call: (1) the caller
// (`nativeTopKChunked`, `packages/engine/src/semantic-retrieval.ts`) packs a
// FRESH candidate byte buffer per call/chunk (a `Uint8Array.set` copy per
// candidate), (2) this crate decodes every candidate from wire bytes to a
// freshly allocated `Vec<f64>` PER CANDIDATE (`decode_packed_vector_request`),
// and (3) `exact_vector_top_k` does a full `O(n log n)` SORT of the whole
// candidate list even when only the top few are kept. At n8n's own measured
// scale (72,922 entity-grain candidates, `docs/evidence/2026-09-08-v4-semantic-sweep-and-full-scale-latency.md`),
// the 4,095-candidate-per-call batch bound forces ~18 chunks, so ALL THREE
// costs are paid 18 TIMES per query even though the underlying vector data
// (the daemon's own `residentVectorCache`, `canonical-query-data-port.ts`)
// is already a SINGLE contiguous, generation-stable buffer that does not
// change between queries at all. Measured live: 581.4ms for the bounded
// entity-lane scan alone, attributed (by elimination -- 72,922 x 384-dim dot
// products is tens of millions of FLOPs, sub-10ms territory) to exactly this
// per-call marshaling/chunking overhead, not to floating-point compute.
//
// `register_vector_buffer` lets the JS side hand this crate ONE contiguous
// `f32` buffer PER (handle, generation) -- copied into Rust-owned memory
// EXACTLY ONCE per generation (a cache miss on the JS side, i.e. a real
// structural/semantic publish), never once per query. `exact_top_k_contiguous`
// then does the ENTIRE scan against that already-resident buffer in ONE
// N-API call: no per-query candidate marshaling, no f64 upcast allocation
// (the accumulation upcasts each element as it's read, matching this same
// file's own `vector_distance`'s f64 arithmetic, but never materializes a
// second full-size buffer), and partial (not full) selection --
// `select_nth_unstable_by` is expected O(n), strictly better than the
// O(n log k) a binary-heap selection would cost, and never allocates more
// than the input's own length.
//
// Correctness (decision 06: no ANN, no sampling, exact only): the caller
// MUST register `data` pre-sorted by ITS OWN candidate identifier, ascending
// (`canonical-query-data-port.ts`'s `residentVectorCache`/lane buffers are
// already built from a `SELECT ... ORDER BY projection_record_id` query, so
// this is free, not an extra sort) -- `exact_top_k_contiguous` tie-breaks
// STRICTLY by ascending buffer index on an exact distance tie, which is
// therefore ascending-identifier order too, exactly matching every other
// exact-vector code path in this crate (`exact_vector_top_k`'s own
// `left.0.as_bytes().cmp(right.0.as_bytes())`) and the JS oracle
// (`semantic-retrieval.ts`'s `utf8Compare`). The caller maps returned
// indices back to identifiers using the SAME index-aligned id array it used
// to build the registered buffer.
//
// Generation invalidation: `register_vector_buffer`'s `generation` argument
// is an opaque, caller-owned monotonic counter (not necessarily the
// workspace's own structural generation number -- see the call site's own
// doc comment) stored alongside the buffer. `exact_top_k_contiguous` rejects
// a call whose `generation` does not match the CURRENTLY registered one for
// that handle -- the caller (never this crate) decides when to re-register
// (a fresh cache miss) versus reuse (a cache hit, skipping the copy
// entirely) -- this crate only enforces "never silently scan stale data".

use std::sync::{Mutex, OnceLock};

/// Above this candidate count, `exact_top_k_contiguous` computes distances
/// with `rayon`'s data-parallel iterator instead of a plain sequential loop.
/// n8n's own full entity-grain lane (72,922 candidates) is comfortably past
/// this threshold; a 100-file corpus's lanes (low thousands) are not, so a
/// small/medium query never pays thread-pool dispatch overhead for a
/// workload a single core finishes in well under a millisecond.
const RESIDENT_VECTOR_PARALLEL_THRESHOLD: usize = 50_000;

struct ResidentVectorBuffer {
    generation: u32,
    dimensions: usize,
    data: Vec<f32>,
}

fn resident_vector_registry() -> &'static Mutex<HashMap<String, ResidentVectorBuffer>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, ResidentVectorBuffer>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers (replacing any prior entry for `handle_id`) one contiguous,
/// row-major `f32` buffer of `data.len() / dimensions` vectors, tagged with
/// `generation`. Copies `data` once; every `exact_top_k_contiguous` call
/// against this `(handle_id, generation)` pair afterward reuses the SAME
/// Rust-owned allocation, no further copies.
pub fn register_vector_buffer(
    handle_id: &str,
    generation: u32,
    dimensions: usize,
    data: Vec<f32>,
) -> NativeCoreResult<()> {
    if dimensions == 0 {
        return Err(NativeCoreError::new(
            "Resident vector buffer dimensions must be positive.",
        ));
    }
    if !data.len().is_multiple_of(dimensions) {
        return Err(NativeCoreError::new(
            "Resident vector buffer length is not a multiple of its dimensions.",
        ));
    }
    if data.iter().any(|value| !value.is_finite()) {
        return Err(NativeCoreError::new(
            "Resident vector buffer contains a non-finite value.",
        ));
    }
    let mut registry = resident_vector_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.insert(
        handle_id.to_owned(),
        ResidentVectorBuffer {
            generation,
            dimensions,
            data,
        },
    );
    Ok(())
}

/// Drops any buffer registered for `handle_id` (a no-op if none is
/// registered). Exists for test isolation and for a caller that wants to
/// free the resident memory of a handle it will never query again (e.g. a
/// workspace being closed) -- not currently called by the daemon's own
/// steady-state query path, which only ever REPLACES a handle's entry on
/// the next generation.
pub fn forget_vector_buffer(handle_id: &str) {
    let mut registry = resident_vector_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.remove(handle_id);
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ExactTopKContiguousMatch {
    pub index: u32,
    pub distance: f64,
}

#[inline]
fn dot_f32_as_f64(a: &[f32], b: &[f32]) -> f64 {
    // Chunked (unrolled-by-8) accumulation: auto-vectorizable by LLVM at
    // release opt levels (contiguous slices, no bounds-check-defeating
    // indirection), while still upcasting each element to `f64` as it's
    // multiplied so a 384-dimension dot product accumulates in the SAME
    // precision `vector_distance` (above) and the JS oracle both use --
    // only the SUMMATION ORDER differs (8 partial lanes merged at the end
    // rather than one strict left-to-right running sum), which can only
    // ever move a result by a few ULP, never flip a real (non-tied) rank
    // ordering; a genuine tie is broken by index, not by distance, so it is
    // unaffected either way.
    let (a_chunks, a_remainder) = a.as_chunks::<8>();
    let (b_chunks, b_remainder) = b.as_chunks::<8>();
    let mut lanes = [0f64; 8];
    for (a_chunk, b_chunk) in a_chunks.iter().zip(b_chunks) {
        for lane in 0..8 {
            lanes[lane] += f64::from(a_chunk[lane]) * f64::from(b_chunk[lane]);
        }
    }
    let mut total: f64 = lanes.iter().sum();
    for (x, y) in a_remainder.iter().zip(b_remainder) {
        total += f64::from(*x) * f64::from(*y);
    }
    total
}

#[inline]
fn squared_l2_f32_as_f64(a: &[f32], b: &[f32]) -> f64 {
    let (a_chunks, a_remainder) = a.as_chunks::<8>();
    let (b_chunks, b_remainder) = b.as_chunks::<8>();
    let mut lanes = [0f64; 8];
    for (a_chunk, b_chunk) in a_chunks.iter().zip(b_chunks) {
        for lane in 0..8 {
            let difference = f64::from(a_chunk[lane]) - f64::from(b_chunk[lane]);
            lanes[lane] += difference * difference;
        }
    }
    let mut total: f64 = lanes.iter().sum();
    for (x, y) in a_remainder.iter().zip(b_remainder) {
        let difference = f64::from(*x) - f64::from(*y);
        total += difference * difference;
    }
    total
}

fn resident_distance(
    query: &[f32],
    query_norm: f64,
    candidate: &[f32],
    metric: DistanceMetric,
) -> NativeCoreResult<f64> {
    match metric {
        DistanceMetric::SquaredL2 => {
            let distance = squared_l2_f32_as_f64(query, candidate);
            if !distance.is_finite() {
                return Err(NativeCoreError::new("Exact vector distance is not finite."));
            }
            Ok(distance)
        }
        DistanceMetric::Cosine => {
            let candidate_norm = dot_f32_as_f64(candidate, candidate).sqrt();
            if candidate_norm == 0.0 {
                return Err(NativeCoreError::new(
                    "Cosine exact vector top-k does not accept zero vectors.",
                ));
            }
            let dot = dot_f32_as_f64(query, candidate);
            if !dot.is_finite() || !candidate_norm.is_finite() {
                return Err(NativeCoreError::new("Exact vector distance is not finite."));
            }
            let distance = 1.0 - dot / (query_norm * candidate_norm);
            if distance.is_finite() {
                Ok(distance)
            } else {
                Err(NativeCoreError::new("Exact vector distance is not finite."))
            }
        }
    }
}

/// Exact top-`k` (or all `count`, whichever is smaller) over the buffer
/// registered for `handle_id` at `generation`, against `query`. Returns
/// `(index, distance)` pairs sorted by ascending distance, ties broken by
/// ascending `index` -- see this section's own header comment for why that
/// is a correct, exact tie-break as long as the caller registered `data` in
/// ascending-identifier order.
pub fn exact_top_k_contiguous(
    handle_id: &str,
    generation: u32,
    query: &[f32],
    k: usize,
    metric: DistanceMetric,
) -> NativeCoreResult<Vec<ExactTopKContiguousMatch>> {
    if k == 0 {
        return Err(NativeCoreError::new(
            "Resident exact top-k must be positive.",
        ));
    }
    if query.iter().any(|value| !value.is_finite()) {
        return Err(NativeCoreError::new(
            "Resident exact top-k query has a non-finite value.",
        ));
    }
    let registry = resident_vector_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let buffer = registry.get(handle_id).ok_or_else(|| {
        NativeCoreError::new(format!(
            "No resident vector buffer is registered for handle '{handle_id}'."
        ))
    })?;
    if buffer.generation != generation {
        return Err(NativeCoreError::new(format!(
            "Resident vector buffer handle '{handle_id}' is stale: registered generation {}, requested {generation}.",
            buffer.generation
        )));
    }
    if query.len() != buffer.dimensions {
        return Err(NativeCoreError::new(
            "Resident exact top-k query dimensions do not match the registered buffer.",
        ));
    }
    let dims = buffer.dimensions;
    let count = buffer.data.len() / dims;
    if count == 0 {
        return Ok(Vec::new());
    }
    let k = k.min(count);
    let query_norm = match metric {
        DistanceMetric::Cosine => {
            let norm = dot_f32_as_f64(query, query).sqrt();
            if norm == 0.0 {
                return Err(NativeCoreError::new(
                    "Cosine exact vector top-k does not accept zero vectors.",
                ));
            }
            norm
        }
        DistanceMetric::SquaredL2 => 0.0,
    };
    let data = &buffer.data;
    let distance_at = |index: usize| -> NativeCoreResult<f64> {
        let candidate = &data[index * dims..(index + 1) * dims];
        resident_distance(query, query_norm, candidate, metric)
    };
    let distances: Vec<f64> = if count > RESIDENT_VECTOR_PARALLEL_THRESHOLD {
        use rayon::prelude::*;
        (0..count)
            .into_par_iter()
            .map(distance_at)
            .collect::<NativeCoreResult<Vec<_>>>()?
    } else {
        (0..count)
            .map(distance_at)
            .collect::<NativeCoreResult<Vec<_>>>()?
    };
    // Partial selection: `select_nth_unstable_by` places the k smallest
    // (by this comparator) elements in `indexed[..k]`, in unspecified order
    // among themselves -- the trailing `sort_by` below then orders just
    // those `k` elements (never the full `count`).
    let mut indexed: Vec<(usize, f64)> =
        (0..count).map(|index| (index, distances[index])).collect();
    let cmp = |left: &(usize, f64), right: &(usize, f64)| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    };
    if k < count {
        indexed.select_nth_unstable_by(k - 1, cmp);
        indexed.truncate(k);
    }
    indexed.sort_by(cmp);
    Ok(indexed
        .into_iter()
        .map(|(index, distance)| ExactTopKContiguousMatch {
            index: index as u32,
            distance,
        })
        .collect())
}

#[cfg(test)]
mod resident_vector_tests {
    use super::*;

    fn buffer_from_rows(rows: &[[f32; 4]]) -> Vec<f32> {
        rows.iter().flat_map(|row| row.iter().copied()).collect()
    }

    #[test]
    fn exact_top_k_contiguous_matches_squared_l2_oracle_order() {
        let rows: Vec<[f32; 4]> = vec![
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
        ];
        register_vector_buffer("test:squared-l2", 1, 4, buffer_from_rows(&rows)).unwrap();
        let query = [1.0, 0.0, 0.0, 0.0];
        let result =
            exact_top_k_contiguous("test:squared-l2", 1, &query, 2, DistanceMetric::SquaredL2)
                .unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].index, 0);
        assert_eq!(result[1].index, 2);
        assert!(result[0].distance < result[1].distance);
        forget_vector_buffer("test:squared-l2");
    }

    #[test]
    fn exact_top_k_contiguous_breaks_exact_ties_by_ascending_index() {
        // Two candidates at IDENTICAL distance from the query -- registered
        // in ascending-identifier order (index 1 stands for a smaller
        // identifier than index 3, matching this crate's own contract), so
        // the tie-break must prefer index 1 over index 3 when k=1.
        let rows: Vec<[f32; 4]> = vec![
            [0.0, 1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
        ];
        register_vector_buffer("test:ties", 1, 4, buffer_from_rows(&rows)).unwrap();
        let query = [1.0, 0.0, 0.0, 0.0];
        let result =
            exact_top_k_contiguous("test:ties", 1, &query, 1, DistanceMetric::SquaredL2).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].index, 1);
        forget_vector_buffer("test:ties");
    }

    #[test]
    fn exact_top_k_contiguous_caps_k_to_count() {
        let rows: Vec<[f32; 4]> = vec![[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]];
        register_vector_buffer("test:k-gt-n", 1, 4, buffer_from_rows(&rows)).unwrap();
        let query = [1.0, 0.0, 0.0, 0.0];
        let result =
            exact_top_k_contiguous("test:k-gt-n", 1, &query, 100, DistanceMetric::SquaredL2)
                .unwrap();
        assert_eq!(result.len(), 2);
        forget_vector_buffer("test:k-gt-n");
    }

    #[test]
    fn exact_top_k_contiguous_rejects_a_stale_generation() {
        let rows: Vec<[f32; 4]> = vec![[1.0, 0.0, 0.0, 0.0]];
        register_vector_buffer("test:stale", 1, 4, buffer_from_rows(&rows)).unwrap();
        let query = [1.0, 0.0, 0.0, 0.0];
        let error = exact_top_k_contiguous("test:stale", 2, &query, 1, DistanceMetric::SquaredL2)
            .unwrap_err();
        assert!(error.to_string().contains("stale"));
        forget_vector_buffer("test:stale");
    }

    #[test]
    fn exact_top_k_contiguous_rejects_an_unregistered_handle() {
        let query = [1.0, 0.0, 0.0, 0.0];
        let error = exact_top_k_contiguous(
            "test:never-registered",
            1,
            &query,
            1,
            DistanceMetric::SquaredL2,
        )
        .unwrap_err();
        assert!(error.to_string().contains("No resident vector buffer"));
    }

    #[test]
    fn exact_top_k_contiguous_agrees_with_exact_vector_top_k_on_a_random_corpus() {
        // Cross-checks the new resident kernel's ranking against this same
        // file's own pre-existing `exact_vector_top_k` (the f64, no-shortcuts
        // oracle every other native vector path in this crate already
        // trusts) over a corpus too large to eyeball, including a k that
        // does not evenly divide the corpus.
        let dims = 12usize;
        let count = 733usize;
        let mut state: u64 = 0x9E3779B97F4A7C15;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut rows: Vec<[f32; 12]> = Vec::with_capacity(count);
        for _ in 0..count {
            let mut row = [0f32; 12];
            for slot in row.iter_mut() {
                *slot = ((next() % 2001) as f32 - 1000.0) / 1000.0;
            }
            rows.push(row);
        }
        let mut query = [0f32; 12];
        for slot in query.iter_mut() {
            *slot = ((next() % 2001) as f32 - 1000.0) / 1000.0;
        }
        let flat: Vec<f32> = rows.iter().flat_map(|row| row.iter().copied()).collect();
        register_vector_buffer("test:random-corpus", 7, dims, flat).unwrap();
        let k = 17usize;
        let resident = exact_top_k_contiguous(
            "test:random-corpus",
            7,
            &query,
            k,
            DistanceMetric::SquaredL2,
        )
        .unwrap();
        forget_vector_buffer("test:random-corpus");

        let candidates: Vec<VectorCandidate> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| VectorCandidate {
                // Zero-padded so lexicographic byte order matches ascending
                // numeric order, exactly mirroring the buffer's own
                // ascending-index registration order.
                id: format!("id-{index:04}"),
                vector: row.iter().map(|value| *value as f64).collect(),
            })
            .collect();
        let oracle = exact_vector_top_k(&ExactVectorRequest {
            query: query.iter().map(|value| *value as f64).collect(),
            candidates,
            k,
            metric: DistanceMetric::SquaredL2,
        })
        .unwrap();

        assert_eq!(resident.len(), oracle.len());
        for (resident_match, oracle_match) in resident.iter().zip(oracle.iter()) {
            let expected_index: usize = oracle_match.projection_record_id[3..].parse().unwrap();
            assert_eq!(
                resident_match.index as usize, expected_index,
                "resident kernel and exact_vector_top_k disagree on rank order"
            );
        }
    }

    #[test]
    fn exact_top_k_contiguous_agrees_with_the_oracle_past_the_rayon_parallel_threshold() {
        // `RESIDENT_VECTOR_PARALLEL_THRESHOLD` is 50,000 -- this corpus is
        // deliberately past it, so `exact_top_k_contiguous`'s distance
        // computation runs through the `rayon::prelude::into_par_iter`
        // branch, not the sequential one the test above already covers.
        // Cosine metric this time (the other test only covers squared L2),
        // matching n8n's own real query shape
        // (`canonical-query-data-port.ts`'s `trySemanticSearch` hardcodes
        // `distance_metric: "cosine"` for both lanes).
        let dims = 8usize;
        let count = 60_001usize;
        let mut state: u64 = 0xD1B54A32D192ED03;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut rows: Vec<[f32; 8]> = Vec::with_capacity(count);
        for _ in 0..count {
            let mut row = [0f32; 8];
            for slot in row.iter_mut() {
                *slot = ((next() % 2001) as f32 - 1000.0) / 1000.0;
            }
            rows.push(row);
        }
        let mut query = [0f32; 8];
        for slot in query.iter_mut() {
            *slot = ((next() % 2001) as f32 - 1000.0) / 1000.0;
        }
        let flat: Vec<f32> = rows.iter().flat_map(|row| row.iter().copied()).collect();
        register_vector_buffer("test:rayon-corpus", 3, dims, flat).unwrap();
        let k = 25usize;
        let resident =
            exact_top_k_contiguous("test:rayon-corpus", 3, &query, k, DistanceMetric::Cosine)
                .unwrap();
        forget_vector_buffer("test:rayon-corpus");
        assert_eq!(resident.len(), k);

        let candidates: Vec<VectorCandidate> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| VectorCandidate {
                id: format!("id-{index:05}"),
                vector: row.iter().map(|value| *value as f64).collect(),
            })
            .collect();
        let oracle = exact_vector_top_k(&ExactVectorRequest {
            query: query.iter().map(|value| *value as f64).collect(),
            candidates,
            k,
            metric: DistanceMetric::Cosine,
        })
        .unwrap();

        assert_eq!(resident.len(), oracle.len());
        for (resident_match, oracle_match) in resident.iter().zip(oracle.iter()) {
            let expected_index: usize = oracle_match.projection_record_id[3..].parse().unwrap();
            assert_eq!(
                resident_match.index as usize, expected_index,
                "resident kernel (rayon path) and exact_vector_top_k disagree on rank order"
            );
        }
    }
}

#[cfg(test)]
mod depth_boundary_tests {
    //! P2-2l item 3: proves `update_uce_value` and `encode_publication_
    //! body` agree on success/failure at the exact depths this task's own
    //! doc comments argue about (63/64/65/128/129), now that `update_uce_
    //! value`'s bound is unified to `MAX_LOGICAL_DEPTH` (64) instead of
    //! its former 128. Before this task's change, `update_uce_value`
    //! would have SUCCEEDED at depth 65 and 128 while `encode_publication_
    //! body` already failed at both -- this test would have failed on the
    //! unmodified tree, which is the whole point: it is a regression test
    //! for the unification, not just a smoke test of the current code.
    use super::*;

    /// Builds a `Value` nested `levels` object levels deep around a leaf
    /// number, such that a depth-first walk starting at parameter
    /// `depth == 1` (this crate's own convention: `update_uce_value(hash,
    /// record.body, 1)`, `encode_publication_body(record.body, ..., 1)`)
    /// reaches its deepest call at parameter depth `1 + levels`.
    fn nested(levels: usize) -> Value {
        let mut value = serde_json::json!(1);
        for _ in 0..levels {
            value = serde_json::json!({ "a": value });
        }
        value
    }

    fn uce_value_accepts(max_depth: usize) -> bool {
        let value = nested(max_depth.saturating_sub(1));
        let mut hash = Sha256::new();
        update_uce_value(&mut hash, &value, 1).is_ok()
    }

    fn publication_body_accepts(max_depth: usize) -> bool {
        let value = nested(max_depth.saturating_sub(1));
        let mut logical = LogicalDigestWriter::new("test:depth");
        let mut payload = Vec::new();
        encode_publication_body(&value, &mut logical, &mut payload, 1).is_ok()
    }

    #[test]
    fn both_traversals_agree_at_every_boundary_depth() {
        for depth in [63_usize, 64, 65, 128, 129] {
            let uce = uce_value_accepts(depth);
            let publication = publication_body_accepts(depth);
            assert_eq!(
                uce, publication,
                "update_uce_value and encode_publication_body disagree at depth {depth}: uce={uce} publication={publication}"
            );
            // Both traversals use MAX_LOGICAL_DEPTH (64) as their shared
            // bound after this task's unification: depth <= 64 succeeds,
            // depth > 64 fails, for both.
            assert_eq!(uce, depth <= MAX_LOGICAL_DEPTH, "depth {depth}");
        }
    }

    #[test]
    fn fused_body_pass_matches_both_traversals_at_every_boundary_depth() {
        for depth in [63_usize, 64, 65, 128, 129] {
            let value = nested(depth.saturating_sub(1));
            let mut hash = Sha256::new();
            let mut logical = LogicalDigestWriter::new("test:depth");
            let mut payload = Vec::new();
            let fused_ok =
                fused_body_pass(&value, &mut hash, &mut logical, &mut payload, 1).is_ok();
            assert_eq!(
                fused_ok,
                depth <= MAX_LOGICAL_DEPTH,
                "fused_body_pass at depth {depth}"
            );
            assert_eq!(fused_ok, uce_value_accepts(depth), "depth {depth}");
            assert_eq!(fused_ok, publication_body_accepts(depth), "depth {depth}");
        }
    }
}
