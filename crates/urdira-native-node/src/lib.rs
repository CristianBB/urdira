#![deny(unsafe_code)]

mod structural_store_napi;

use napi::{Error, Result, Status, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use serde::de::DeserializeOwned;
use serde_json::Value;
use urdira_jsts_native_projection::{
    PROFILE_ID as JSTS_PROJECTION_PROFILE_ID, ProjectionBatch as JstsProjectionBatch,
    project as project_jsts,
};
use urdira_native_core::{
    DistanceMetric, LogicalRecord, LogicalRecordVerification, LogicalValueRecord,
    LogicalValueVerification, PackedExactVectorRequest, PackedVectorElementType,
    StructuralKernelBatch, StructuralKernelCanonicalBatch, exact_packed_vector_top_k_batch,
    logical_digest_batch as core_logical_digest_batch,
    logical_value_digest_batch as core_logical_value_digest_batch,
    structural_kernel_batch as core_structural_kernel_batch,
    structural_kernel_canonical_batch as core_structural_kernel_canonical_batch,
    verify_logical_record_batch as core_verify_logical_record_batch,
    verify_logical_value_batch as core_verify_logical_value_batch,
};

const NATIVE_API_VERSION: u32 = 16;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuralObservationEnvelope {
    profile_id: String,
    batch: Value,
}

fn decode<T: DeserializeOwned>(value: Value, operation: &str) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        Error::new(
            Status::InvalidArg,
            format!("{operation} received an invalid bounded batch: {error}"),
        )
    })
}

#[napi(object)]
pub struct PackedExactVectorRequestInput {
    pub query: Uint8Array,
    pub candidates: Uint8Array,
    pub projection_record_ids: Vec<String>,
    pub dimensions: u32,
    pub element_type: String,
    pub k: u32,
    pub metric: String,
}

fn packed_vector_request(input: PackedExactVectorRequestInput) -> Result<PackedExactVectorRequest> {
    let element_type = match input.element_type.as_str() {
        "float32_le" => PackedVectorElementType::Float32Le,
        "float64_le" => PackedVectorElementType::Float64Le,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("exactVectorTopKBatch received unsupported element type '{other}'."),
            ));
        }
    };
    let metric = match input.metric.as_str() {
        "cosine" => DistanceMetric::Cosine,
        "squared_l2" => DistanceMetric::SquaredL2,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("exactVectorTopKBatch received unsupported metric '{other}'."),
            ));
        }
    };
    Ok(PackedExactVectorRequest {
        query: input.query.to_vec(),
        candidates: input.candidates.to_vec(),
        projection_record_ids: input.projection_record_ids,
        dimensions: input.dimensions as usize,
        element_type,
        k: input.k as usize,
        metric,
    })
}

fn encode<T: serde::Serialize>(value: T, operation: &str) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("{operation} could not return its owned result: {error}"),
        )
    })
}

fn core_error(error: urdira_native_core::NativeCoreError, operation: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("{operation} rejected the batch: {error}"),
    )
}

#[napi(js_name = "nativeApiVersion")]
pub fn native_api_version() -> u32 {
    NATIVE_API_VERSION
}

#[napi(js_name = "nativeTargetTriple")]
pub fn native_target_triple() -> String {
    env!("URDIRA_NATIVE_TARGET").to_owned()
}

/// Computes registered logical-digest.v3 records from Rust-owned call data.
#[napi(js_name = "logicalDigestBatch")]
pub fn logical_digest_batch(records: Value) -> Result<Value> {
    let records: Vec<LogicalRecord> = decode(records, "logicalDigestBatch")?;
    let results = core_logical_digest_batch(&records)
        .map_err(|error| core_error(error, "logicalDigestBatch"))?;
    encode(results, "logicalDigestBatch")
}

/// Recomputes schema-ordered records and reports exact SHA-256 equality.
#[napi(js_name = "verifyLogicalRecordBatch")]
pub fn verify_logical_record_batch(records: Value) -> Result<Value> {
    let records: Vec<LogicalRecordVerification> = decode(records, "verifyLogicalRecordBatch")?;
    let results = core_verify_logical_record_batch(&records)
        .map_err(|error| core_error(error, "verifyLogicalRecordBatch"))?;
    encode(results, "verifyLogicalRecordBatch")
}

/// Computes registered logical-digest.v3 root values from Rust-owned call data.
#[napi(js_name = "logicalValueDigestBatch")]
pub fn logical_value_digest_batch(records: Value) -> Result<Value> {
    let records: Vec<LogicalValueRecord> = decode(records, "logicalValueDigestBatch")?;
    let results = core_logical_value_digest_batch(&records)
        .map_err(|error| core_error(error, "logicalValueDigestBatch"))?;
    encode(results, "logicalValueDigestBatch")
}

/// Recomputes root logical values and reports exact SHA-256 equality.
#[napi(js_name = "verifyLogicalValueBatch")]
pub fn verify_logical_value_batch(records: Value) -> Result<Value> {
    let records: Vec<LogicalValueVerification> = decode(records, "verifyLogicalValueBatch")?;
    let results = core_verify_logical_value_batch(&records)
        .map_err(|error| core_error(error, "verifyLogicalValueBatch"))?;
    encode(results, "verifyLogicalValueBatch")
}

/// Validates and canonicalizes one bounded structural row group while the
/// values are owned by Rust. Workspace/registry checks remain in the engine.
#[napi(js_name = "structuralKernelBatch")]
pub fn structural_kernel_batch(batch: Value) -> Result<Value> {
    let batch: StructuralKernelBatch = decode(batch, "structuralKernelBatch")?;
    let result = core_structural_kernel_batch(&batch)
        .map_err(|error| core_error(error, "structuralKernelBatch"))?;
    encode(result, "structuralKernelBatch")
}

/// Revalidates exact producer-sealed rows in Rust, avoiding a nested
/// JavaScript reconstruction before the core-owned structural pass.
#[napi(js_name = "structuralKernelCanonicalBatch")]
pub fn structural_kernel_canonical_batch(batch: Value) -> Result<Value> {
    let batch: StructuralKernelCanonicalBatch = decode(batch, "structuralKernelCanonicalBatch")?;
    let result = core_structural_kernel_canonical_batch(&batch)
        .map_err(|error| core_error(error, "structuralKernelCanonicalBatch"))?;
    encode(result, "structuralKernelCanonicalBatch")
}

/// Dispatches a closed language observation profile, then returns both the
/// projected logical rows and the core kernel result from the same Rust pass.
#[napi(js_name = "structuralObservationBatch")]
pub fn structural_observation_batch(request: Value) -> Result<Value> {
    let request: StructuralObservationEnvelope = decode(request, "structuralObservationBatch")?;
    match request.profile_id.as_str() {
        JSTS_PROJECTION_PROFILE_ID => {
            let batch: JstsProjectionBatch = decode(request.batch, "structuralObservationBatch")?;
            let result = project_jsts(&batch)
                .map_err(|error| core_error(error, "structuralObservationBatch"))?;
            encode(result, "structuralObservationBatch")
        }
        profile => Err(Error::new(
            Status::InvalidArg,
            format!("structuralObservationBatch received unknown profile '{profile}'."),
        )),
    }
}

/// Executes complete exact scans and returns deterministic top-k identities only.
#[napi(js_name = "exactVectorTopKBatch")]
pub fn exact_vector_top_k_batch_binding(
    requests: Vec<PackedExactVectorRequestInput>,
) -> Result<Value> {
    let requests = requests
        .into_iter()
        .map(packed_vector_request)
        .collect::<Result<Vec<_>>>()?;
    let results = exact_packed_vector_top_k_batch(&requests)
        .map_err(|error| core_error(error, "exactVectorTopKBatch"))?;
    encode(results, "exactVectorTopKBatch")
}
