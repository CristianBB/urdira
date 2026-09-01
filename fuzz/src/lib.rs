#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_FUZZ_INPUT_BYTES: usize = 64 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_BATCH_ROWS: usize = 4_096;
const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_STRUCTURED_ROWS: usize = 64;
const MAX_STRUCTURED_TEXT_BYTES: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedRecord {
    pub proposal_record_key: String,
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub facets: String,
    pub schema_version: u64,
    pub source_span: String,
    pub identity_key: String,
    pub body: Value,
    pub evidence_references: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedDependency {
    pub proposed_dependency_id: String,
    pub proposal_record_key: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
    pub dependency_role: String,
    pub dependency_basis: String,
    pub source_reference: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactDeltaStreamBatch {
    pub protocol_version: u64,
    pub schema_id: String,
    pub fact_delta_id: String,
    pub sequence: u64,
    pub final_frame: bool,
    pub record_count: u64,
    pub dependency_count: u64,
    pub row_count: u64,
    pub byte_length: u64,
    pub records: Vec<ProposedRecord>,
    pub dependencies: Vec<ProposedDependency>,
    pub chunk_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError;

impl FactDeltaStreamBatch {
    fn payload_value(&self) -> Result<Value, ValidationError> {
        let mut value = serde_json::to_value(self).map_err(|_| ValidationError)?;
        let object = value.as_object_mut().ok_or(ValidationError)?;
        object.remove("chunk_digest");
        if let Some(final_frame) = object.remove("final_frame") {
            object.insert("final".to_owned(), final_frame);
        }
        Ok(value)
    }
}

pub fn validate_fact_delta_stream_batch_bytes(input: &[u8]) -> Result<(), ValidationError> {
    if input.len() > MAX_FUZZ_INPUT_BYTES {
        return Err(ValidationError);
    }
    let value: Value = serde_json::from_slice(input).map_err(|_| ValidationError)?;
    validate_fact_delta_stream_batch_value(&value)
}

pub fn validate_fact_delta_stream_batch_value(value: &Value) -> Result<(), ValidationError> {
    let mut normalized = value.clone();
    let object = normalized.as_object_mut().ok_or(ValidationError)?;
    let final_value = object.remove("final").ok_or(ValidationError)?;
    if object
        .insert("final_frame".to_owned(), final_value)
        .is_some()
    {
        return Err(ValidationError);
    }
    let batch: FactDeltaStreamBatch =
        serde_json::from_value(normalized).map_err(|_| ValidationError)?;
    validate_fact_delta_stream_batch(&batch)
}

pub fn validate_fact_delta_stream_batch(
    batch: &FactDeltaStreamBatch,
) -> Result<(), ValidationError> {
    if batch.protocol_version != 2
        || batch.schema_id != "core:FactDeltaStreamBatch"
        || !valid_identifier(&batch.fact_delta_id)
        || batch.sequence > MAX_SAFE_INTEGER
        || batch.record_count > MAX_SAFE_INTEGER
        || batch.dependency_count > MAX_SAFE_INTEGER
        || batch.row_count > MAX_SAFE_INTEGER
        || batch.byte_length > MAX_SAFE_INTEGER
        || batch.records.len() > MAX_BATCH_ROWS
        || batch.dependencies.len() > MAX_BATCH_ROWS
    {
        return Err(ValidationError);
    }
    let record_count = u64::try_from(batch.records.len()).map_err(|_| ValidationError)?;
    let dependency_count = u64::try_from(batch.dependencies.len()).map_err(|_| ValidationError)?;
    let row_count = record_count
        .checked_add(dependency_count)
        .ok_or(ValidationError)?;
    if batch.record_count != record_count
        || batch.dependency_count != dependency_count
        || batch.row_count != row_count
        || row_count > MAX_BATCH_ROWS as u64
    {
        return Err(ValidationError);
    }
    for record in &batch.records {
        validate_record(record)?;
    }
    for dependency in &batch.dependencies {
        validate_dependency(dependency)?;
    }
    let byte_length = native_batch_byte_length(&batch.records, &batch.dependencies)?;
    if byte_length > MAX_BATCH_BYTES || batch.byte_length != byte_length as u64 {
        return Err(ValidationError);
    }
    if !valid_digest(&batch.chunk_digest)
        || canonical_sha256(&batch.payload_value()?)? != batch.chunk_digest
    {
        return Err(ValidationError);
    }
    Ok(())
}

fn validate_record(record: &ProposedRecord) -> Result<(), ValidationError> {
    if !valid_identifier(&record.proposal_record_key)
        || !valid_identifier(&record.category)
        || !valid_identifier(&record.kind)
        || !valid_identifier(&record.universal_kind)
        || record.schema_version == 0
        || record.schema_version > MAX_SAFE_INTEGER
        || canonical_json(&record.body).is_err()
    {
        return Err(ValidationError);
    }
    Ok(())
}

fn validate_dependency(dependency: &ProposedDependency) -> Result<(), ValidationError> {
    if !valid_identifier(&dependency.proposed_dependency_id)
        || !valid_identifier(&dependency.proposal_record_key)
        || !valid_identifier(&dependency.dependency_artifact_id)
        || !valid_identifier(&dependency.dependency_artifact_version_id)
        || !valid_identifier(&dependency.dependency_role)
        || !valid_identifier(&dependency.dependency_basis)
        || canonical_json(&dependency.source_reference).is_err()
    {
        return Err(ValidationError);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    let count = value.chars().count();
    (1..=512).contains(&count)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn native_batch_byte_length(
    records: &[ProposedRecord],
    dependencies: &[ProposedDependency],
) -> Result<usize, ValidationError> {
    let record_rows = records
        .iter()
        .map(|record| {
            Ok(vec![
                record.proposal_record_key.clone(),
                record.category.clone(),
                record.kind.clone(),
                record.universal_kind.clone(),
                record.identity_key.clone(),
                canonical_json(&serde_json::to_value(record).map_err(|_| ValidationError)?)?,
            ])
        })
        .collect::<Result<Vec<_>, ValidationError>>()?;
    let graph_rows = records
        .iter()
        .filter(|record| record.category == "relation")
        .map(|record| {
            Ok(vec![
                record.proposal_record_key.clone(),
                canonical_json(&serde_json::to_value(record).map_err(|_| ValidationError)?)?,
            ])
        })
        .collect::<Result<Vec<_>, ValidationError>>()?;
    let identity_rows = records
        .iter()
        .filter(|record| !record.identity_key.is_empty())
        .map(|record| {
            Ok(vec![
                record.proposal_record_key.clone(),
                record.identity_key.clone(),
                canonical_json(&serde_json::to_value(record).map_err(|_| ValidationError)?)?,
            ])
        })
        .collect::<Result<Vec<_>, ValidationError>>()?;
    let dependency_rows = dependencies
        .iter()
        .map(|dependency| {
            Ok(vec![
                dependency.proposed_dependency_id.clone(),
                dependency.proposal_record_key.clone(),
                dependency.dependency_artifact_id.clone(),
                dependency.dependency_artifact_version_id.clone(),
                dependency.dependency_role.clone(),
                canonical_json(&serde_json::to_value(dependency).map_err(|_| ValidationError)?)?,
            ])
        })
        .collect::<Result<Vec<_>, ValidationError>>()?;
    [&record_rows, &graph_rows, &identity_rows, &dependency_rows]
        .into_iter()
        .try_fold(0usize, |total, rows| {
            total
                .checked_add(column_batch_bytes(rows)?)
                .ok_or(ValidationError)
        })
}

fn column_batch_bytes(rows: &[Vec<String>]) -> Result<usize, ValidationError> {
    let string_count = rows.iter().try_fold(0usize, |total, row| {
        total.checked_add(row.len()).ok_or(ValidationError)
    })?;
    let utf8_bytes = rows.iter().flatten().try_fold(0usize, |total, value| {
        total.checked_add(value.len()).ok_or(ValidationError)
    })?;
    utf8_bytes
        .checked_add(string_count.checked_mul(8).ok_or(ValidationError)?)
        .and_then(|value| value.checked_add((rows.len() + 1).checked_mul(20)?))
        .ok_or(ValidationError)
}

fn canonical_sha256(value: &Value) -> Result<String, ValidationError> {
    let mut hash = Sha256::new();
    hash.update(canonical_json(value)?.as_bytes());
    let bytes = hash.finalize();
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").map_err(|_| ValidationError)?;
    }
    Ok(output)
}

fn canonical_json(value: &Value) -> Result<String, ValidationError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            serde_json::to_string(value).map_err(|_| ValidationError)
        }
        Value::Number(number) => canonical_number(number),
        Value::Array(values) => {
            let encoded = values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", encoded.join(",")))
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let encoded = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|_| ValidationError)?,
                        canonical_json(value)?
                    ))
                })
                .collect::<Result<Vec<_>, ValidationError>>()?;
            Ok(format!("{{{}}}", encoded.join(",")))
        }
    }
}

fn canonical_number(number: &serde_json::Number) -> Result<String, ValidationError> {
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() <= MAX_SAFE_INTEGER {
            return Ok(value.to_string());
        }
    }
    if let Some(value) = number.as_u64() {
        if value <= MAX_SAFE_INTEGER {
            return Ok(value.to_string());
        }
    }
    if let Some(value) = number.as_f64() {
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64 {
            return Ok(if value == 0.0 {
                "0".to_owned()
            } else {
                format!("{value:.0}")
            });
        }
    }
    Err(ValidationError)
}

pub fn structured_fact_delta_batch(input: &[u8]) -> FactDeltaStreamBatch {
    let mut cursor = ByteCursor::new(input);
    let record_count = cursor.next_usize(MAX_STRUCTURED_ROWS + 1);
    let dependency_count = cursor.next_usize(MAX_STRUCTURED_ROWS + 1 - record_count);
    let records = (0..record_count)
        .map(|index| ProposedRecord {
            proposal_record_key: format!(
                "record-{index}-{}",
                cursor.text(MAX_STRUCTURED_TEXT_BYTES)
            ),
            category: if cursor.next_u8().is_multiple_of(3) {
                "relation"
            } else {
                "entity"
            }
            .to_owned(),
            kind: format!("kind-{}", cursor.next_u8()),
            universal_kind: "symbol".to_owned(),
            facets: cursor.text(MAX_STRUCTURED_TEXT_BYTES),
            schema_version: u64::from(cursor.next_u8()) + 1,
            source_span: cursor.text(MAX_STRUCTURED_TEXT_BYTES),
            identity_key: if cursor.next_u8().is_multiple_of(2) {
                cursor.text(MAX_STRUCTURED_TEXT_BYTES)
            } else {
                String::new()
            },
            body: structured_json(&mut cursor, 0),
            evidence_references: cursor.text(MAX_STRUCTURED_TEXT_BYTES),
        })
        .collect::<Vec<_>>();
    let dependencies = (0..dependency_count)
        .map(|index| ProposedDependency {
            proposed_dependency_id: format!("dependency-{index}"),
            proposal_record_key: format!("record-{}", index % record_count.max(1)),
            dependency_artifact_id: format!("artifact-{}", cursor.next_u8()),
            dependency_artifact_version_id: format!("version-{}", cursor.next_u8()),
            dependency_role: "source".to_owned(),
            dependency_basis: "direct".to_owned(),
            source_reference: structured_json(&mut cursor, 0),
        })
        .collect::<Vec<_>>();
    let mut batch = FactDeltaStreamBatch {
        protocol_version: 2,
        schema_id: "core:FactDeltaStreamBatch".to_owned(),
        fact_delta_id: format!("delta-{}", cursor.next_u8()),
        sequence: u64::from(cursor.next_u8()),
        final_frame: cursor.next_u8().is_multiple_of(2),
        record_count: records.len() as u64,
        dependency_count: dependencies.len() as u64,
        row_count: (records.len() + dependencies.len()) as u64,
        byte_length: 0,
        records,
        dependencies,
        chunk_digest: String::new(),
    };
    batch.byte_length = native_batch_byte_length(&batch.records, &batch.dependencies)
        .expect("bounded structured batch") as u64;
    batch.chunk_digest = canonical_sha256(&batch.payload_value().expect("batch payload"))
        .expect("bounded canonical payload");
    batch
}

fn structured_json(cursor: &mut ByteCursor<'_>, depth: usize) -> Value {
    if depth >= 3 {
        return Value::String(cursor.text(MAX_STRUCTURED_TEXT_BYTES));
    }
    match cursor.next_u8() % 6 {
        0 => Value::Null,
        1 => Value::Bool(cursor.next_u8().is_multiple_of(2)),
        2 => Value::Number(u64::from(cursor.next_u8()).into()),
        3 => Value::String(cursor.text(MAX_STRUCTURED_TEXT_BYTES)),
        4 => Value::Array(
            (0..cursor.next_usize(5))
                .map(|_| structured_json(cursor, depth + 1))
                .collect(),
        ),
        _ => {
            let count = cursor.next_usize(5);
            let mut object = Map::new();
            for index in 0..count {
                object.insert(format!("key-{index}"), structured_json(cursor, depth + 1));
            }
            Value::Object(object)
        }
    }
}

pub struct ByteCursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> ByteCursor<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        Self { input, offset: 0 }
    }

    pub fn next_u8(&mut self) -> u8 {
        let value = self.input.get(self.offset).copied().unwrap_or(0);
        self.offset = self.offset.saturating_add(1).min(self.input.len());
        value
    }

    pub fn next_usize(&mut self, exclusive_maximum: usize) -> usize {
        if exclusive_maximum == 0 {
            return 0;
        }
        usize::from(self.next_u8()) % exclusive_maximum
    }

    pub fn take(&mut self, maximum: usize) -> &'a [u8] {
        let requested = self.next_usize(maximum.saturating_add(1));
        let remaining = self.input.len().saturating_sub(self.offset);
        let length = requested.min(remaining);
        let start = self.offset;
        self.offset += length;
        &self.input[start..start + length]
    }

    pub fn text(&mut self, maximum: usize) -> String {
        String::from_utf8_lossy(self.take(maximum)).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_batch_is_valid_and_count_mutation_is_rejected() {
        let batch = structured_fact_delta_batch(b"bounded decision twenty five seed");
        assert_eq!(validate_fact_delta_stream_batch(&batch), Ok(()));
        let mut invalid = batch;
        invalid.row_count += 1;
        assert_eq!(
            validate_fact_delta_stream_batch(&invalid),
            Err(ValidationError)
        );
    }
}
