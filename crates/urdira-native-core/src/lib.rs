#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
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
#[derive(Debug, Clone, Copy)]
pub struct StructuralKernelRecordRef<'a> {
    pub proposal_record_key: &'a str,
    pub category: &'a str,
    pub kind: &'a str,
    pub universal_kind: &'a str,
    pub facets: &'a str,
    pub schema_version: u32,
    pub source_span: &'a str,
    pub identity_key: &'a str,
    pub body: &'a Value,
    pub evidence_references: &'a str,
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
            body: &self.body,
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
    update_uce_value(&mut hash, record.body, 1)?;
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

fn canonical_nested_record_fields_and_span(
    record: StructuralKernelRecordRef<'_>,
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

    let mut body_writer = LogicalDigestWriter::new("urdira:relational-value:v3");
    let mut body = Vec::new();
    fused_body_pass(
        record.body,
        &mut record_hash,
        &mut body_writer,
        &mut body,
        1,
    )?;
    let (body_digest, body_byte_length) = body_writer.finish_bytes();

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
    for &record in records {
        let (facets, span) = canonical_nested_record_fields_and_span(
            record,
            &mut canonical_scratch,
            &mut facet_dedup,
        );
        let structural_attestation = facets.is_some();
        let row = structural_kernel_row(
            record,
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
    for (&record, &facets) in records.iter().zip(typed_facets.iter()) {
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
