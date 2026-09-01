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

fn update_uce_value(hash: &mut Sha256, value: &Value, depth: usize) -> NativeCoreResult<()> {
    if depth > 128 {
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
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            hash.update([6]);
            update_varint(hash, keys.len());
            for key in keys {
                update_uce_text(hash, key);
                update_uce_value(hash, fields.get(key).expect("object key exists"), depth + 1)?;
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

fn update_uce_key_value_text(hash: &mut Sha256, key: &str, value: &str) {
    update_uce_text(hash, key);
    update_uce_text(hash, value);
}

fn structural_record_digest(record: &StructuralKernelRecord) -> NativeCoreResult<String> {
    // Same byte ordering as UCE over serde_json::to_value(record), without
    // allocating and walking a second generic object graph.
    let mut hash = Sha256::new();
    hash.update([6]);
    update_varint(&mut hash, 10);
    update_uce_text(&mut hash, "body");
    update_uce_value(&mut hash, &record.body, 1)?;
    update_uce_key_value_text(&mut hash, "category", &record.category);
    update_uce_key_value_text(
        &mut hash,
        "evidence_references",
        &record.evidence_references,
    );
    update_uce_key_value_text(&mut hash, "facets", &record.facets);
    update_uce_key_value_text(&mut hash, "identity_key", &record.identity_key);
    update_uce_key_value_text(&mut hash, "kind", &record.kind);
    update_uce_key_value_text(
        &mut hash,
        "proposal_record_key",
        &record.proposal_record_key,
    );
    update_uce_text(&mut hash, "schema_version");
    hash.update([7]);
    hash.update((record.schema_version as f64).to_be_bytes());
    update_uce_key_value_text(&mut hash, "source_span", &record.source_span);
    update_uce_key_value_text(&mut hash, "universal_kind", &record.universal_kind);
    Ok(sha256_text(hash))
}

fn uce_text_digest(value: &str) -> String {
    let mut hash = Sha256::new();
    update_uce_text(&mut hash, value);
    sha256_text(hash)
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

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
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
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            logical.tag(10);
            logical.length(keys.len());
            payload.push(6);
            append_varint(payload, keys.len());
            for key in keys {
                logical.text(key);
                logical.boolean(true);
                payload.push(3);
                append_varint(payload, key.len());
                payload.extend_from_slice(key.as_bytes());
                encode_publication_body(
                    fields.get(key).expect("object key exists"),
                    logical,
                    payload,
                    depth + 1,
                )?;
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
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| {
                left.as_bytes()
                    .cmp(right.as_bytes())
                    .then_with(|| left.cmp(right))
            });
            output.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|error| {
                    NativeCoreError::new(format!(
                        "Structural kernel could not encode a JSON key: {error}"
                    ))
                })?);
                output.push(':');
                canonical_json_into(
                    fields.get(key).expect("object key exists"),
                    output,
                    depth + 1,
                )?;
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

fn canonical_nested_record_fields(record: &StructuralKernelRecord) -> Option<Vec<String>> {
    let facets = serde_json::from_str::<Value>(&record.facets).ok()?;
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
        let source_span = serde_json::from_str::<Value>(&record.source_span).ok()?;
        if canonical_json(&source_span).ok()? != record.source_span {
            return None;
        }
    }
    let evidence = serde_json::from_str::<Value>(&record.evidence_references).ok()?;
    if canonical_json(&evidence).ok()? != record.evidence_references {
        return None;
    }
    Some(facet_values)
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
        let facets = canonical_nested_record_fields(record);
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
            let facets = canonical_nested_record_fields(record);
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
