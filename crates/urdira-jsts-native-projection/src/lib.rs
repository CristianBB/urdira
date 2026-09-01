#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use urdira_native_core::{
    NativeCoreResult, StructuralKernelBatch, StructuralKernelDependency, StructuralKernelRecord,
    structural_kernel_seal_batch,
};

pub const PROFILE_ID: &str = "urdira:jsts-semantic-observations:v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionBatch {
    pub owners: Vec<ProjectionOwner>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionOwner {
    pub language: String,
    pub owner_path: String,
    pub entities: Vec<EntityObservation>,
    pub relations: Vec<RelationObservation>,
    pub diagnostics: Vec<DiagnosticObservation>,
    pub files: Vec<FileBinding>,
    pub allowed_record_kinds: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityObservation {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub universal_kind: String,
    pub path: String,
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub qualified_name: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub is_test: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationObservation {
    pub id: String,
    pub kind: String,
    pub source_id: String,
    #[serde(default)]
    pub target_id: Option<String>,
    pub path: String,
    pub start: i64,
    pub end: i64,
    pub classification: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticObservation {
    pub code: String,
    #[serde(default)]
    pub compiler_code: Option<i64>,
    pub message: String,
    pub path: String,
    #[serde(default)]
    pub start: Option<i64>,
    #[serde(default)]
    pub end: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileBinding {
    pub path: String,
    #[serde(default)]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub artifact_version_id: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedOwner {
    pub records: Vec<StructuralKernelRecord>,
    pub dependencies: Vec<StructuralKernelDependency>,
    pub diagnostic_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedRecordHeader {
    pub proposal_record_key: String,
    pub category: String,
    pub kind: String,
    pub universal_kind: String,
    pub identity_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectedDependencyHeader {
    pub proposed_dependency_id: String,
    pub proposal_record_key: String,
    pub dependency_artifact_id: String,
    pub dependency_artifact_version_id: String,
    pub dependency_role: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SealedProjectedOwner {
    pub canonical_records: Vec<String>,
    pub canonical_dependencies: Vec<String>,
    pub record_headers: Vec<ProjectedRecordHeader>,
    pub dependency_headers: Vec<ProjectedDependencyHeader>,
    pub diagnostic_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectionResult {
    pub owners: Vec<SealedProjectedOwner>,
}

fn canonical(value: &Value) -> String {
    serde_json::to_string(value).expect("projection values are serializable")
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    let mut output = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn bounded_identity(prefix: &str, domain: &str, values: &[&str]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    for value in values {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let mut output = String::from(prefix);
    for byte in hash.finalize() {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn proposal_key(identity: &str) -> String {
    bounded_identity(
        "jsts:record:sha256:",
        "urdira:jsts-proposal-record:v1",
        &[identity],
    )
}

fn dependency_id(relation: &str, version: &str) -> String {
    bounded_identity(
        "jsts:dependency:sha256:",
        "urdira:jsts-proposed-dependency:v1",
        &[relation, version],
    )
}

fn span(path: &str, start: i64, end: i64) -> Value {
    json!({ "path": path, "start": start, "end": end })
}

fn record(
    identity: String,
    category: &str,
    kind: String,
    universal_kind: String,
    facets: Value,
    source_span: Value,
    body: Value,
) -> StructuralKernelRecord {
    let evidence = Value::Array(vec![source_span.clone()]);
    StructuralKernelRecord {
        proposal_record_key: proposal_key(&identity),
        category: category.to_owned(),
        kind,
        universal_kind,
        facets: canonical(&facets),
        schema_version: 1,
        source_span: canonical(&source_span),
        identity_key: identity,
        body,
        evidence_references: canonical(&evidence),
    }
}

fn entity_kind(universal_kind: &str) -> &'static str {
    match universal_kind {
        "core:type" => "jsts:entity_type",
        "core:callable" => "jsts:entity_callable",
        "core:container" => "jsts:entity_container",
        "core:parameter" => "jsts:entity_parameter",
        _ => "jsts:entity_variable",
    }
}

fn entity_records(entity: &EntityObservation, language: &str) -> Vec<StructuralKernelRecord> {
    let mut body = Map::new();
    body.insert("name".into(), Value::String(entity.name.clone()));
    body.insert("kind".into(), Value::String(entity.kind.clone()));
    body.insert("language".into(), Value::String(language.to_owned()));
    body.insert("path".into(), Value::String(entity.path.clone()));
    body.insert("start".into(), Value::from(entity.start));
    body.insert("end".into(), Value::from(entity.end));
    if let Some(value) = &entity.parent_id {
        body.insert("parent_id".into(), Value::String(value.clone()));
    }
    if let Some(value) = &entity.qualified_name {
        body.insert("qualified_name".into(), Value::String(value.clone()));
    }
    if let Some(value) = &entity.r#type {
        body.insert("type".into(), Value::String(value.clone()));
    }
    if let Some(value) = entity.is_test {
        body.insert("is_test".into(), Value::Bool(value));
    }
    let source_span = span(&entity.path, entity.start, entity.end);
    let facets = if entity.parent_id.is_some() {
        json!(["core:declaration", "core:definition", "core:member"])
    } else {
        json!(["core:declaration", "core:definition"])
    };
    let mut records = vec![record(
        entity.id.clone(),
        "entity",
        entity_kind(&entity.universal_kind).to_owned(),
        entity.universal_kind.clone(),
        facets,
        source_span.clone(),
        Value::Object(body),
    )];
    if let Some(inferred_type) = &entity.r#type {
        let type_hash =
            sha256_prefixed(canonical(&Value::String(inferred_type.clone())).as_bytes());
        let type_identity = format!(
            "jsts:inferred-type:{}:{}",
            entity.id,
            type_hash.trim_start_matches("sha256:")
        );
        records.push(record(
            type_identity.clone(), "entity", "jsts:entity_inferred_type".into(), "core:type".into(), json!([]), source_span.clone(),
            json!({ "name": format!("inferred type of {}", entity.qualified_name.as_ref().unwrap_or(&entity.name)), "kind": "inferred_type", "type": inferred_type, "language": language, "path": entity.path, "start": entity.start, "end": entity.end }),
        ));
        let relation_identity = format!("jsts:type-of:{}:{type_identity}", entity.id);
        records.push(record(
            relation_identity, "relation", "jsts:relation_type_of".into(), "core:type_of".into(), json!(["core:reference_relation"]), source_span,
            json!({ "source_id": entity.id, "target_id": type_identity, "classification": "confirmed", "path": entity.path, "start": entity.start, "end": entity.end }),
        ));
    }
    records
}

fn relation_record(relation: &RelationObservation) -> StructuralKernelRecord {
    let kind = format!(
        "jsts:relation_{}",
        relation
            .kind
            .strip_prefix("core:")
            .unwrap_or(&relation.kind)
    );
    let facets = if relation.kind == "core:contains" {
        json!(["core:structural_relation"])
    } else if relation.classification == "possible" {
        json!(["core:reference_relation", "core:indirect"])
    } else {
        json!(["core:reference_relation"])
    };
    let mut body = Map::new();
    body.insert(
        "source_id".into(),
        Value::String(relation.source_id.clone()),
    );
    if let Some(value) = &relation.target_id {
        body.insert("target_id".into(), Value::String(value.clone()));
    }
    body.insert(
        "classification".into(),
        Value::String(relation.classification.clone()),
    );
    body.insert("path".into(), Value::String(relation.path.clone()));
    body.insert("start".into(), Value::from(relation.start));
    body.insert("end".into(), Value::from(relation.end));
    record(
        relation.id.clone(),
        "relation",
        kind,
        relation.kind.clone(),
        facets,
        span(&relation.path, relation.start, relation.end),
        Value::Object(body),
    )
}

fn diagnostic_record(diagnostic: &DiagnosticObservation, index: usize) -> StructuralKernelRecord {
    let identity = format!(
        "jsts:diagnostic:{}:{}:{}:{index}",
        diagnostic.path,
        diagnostic.start.unwrap_or(0),
        diagnostic.code
    );
    let mut source_span = Map::new();
    source_span.insert("path".into(), Value::String(diagnostic.path.clone()));
    if let Some(value) = diagnostic.start {
        source_span.insert("start".into(), Value::from(value));
    }
    if let Some(value) = diagnostic.end {
        source_span.insert("end".into(), Value::from(value));
    }
    let mut body = Map::new();
    body.insert("code".into(), Value::String(diagnostic.code.clone()));
    if let Some(value) = diagnostic.compiler_code {
        body.insert("compiler_code".into(), Value::from(value));
    }
    body.insert("message".into(), Value::String(diagnostic.message.clone()));
    body.insert("path".into(), Value::String(diagnostic.path.clone()));
    if let Some(value) = diagnostic.start {
        body.insert("start".into(), Value::from(value));
    }
    if let Some(value) = diagnostic.end {
        body.insert("end".into(), Value::from(value));
    }
    record(
        identity,
        "diagnostic",
        "jsts:diagnostic".into(),
        "core:construct".into(),
        json!([]),
        Value::Object(source_span),
        Value::Object(body),
    )
}

fn project_owner(owner: &ProjectionOwner) -> ProjectedOwner {
    let allowed = owner.allowed_record_kinds.iter().collect::<HashSet<_>>();
    let mut records = Vec::new();
    for entity in owner
        .entities
        .iter()
        .filter(|entry| entry.path == owner.owner_path)
    {
        records.extend(
            entity_records(entity, &owner.language)
                .into_iter()
                .filter(|entry| allowed.contains(&entry.kind)),
        );
    }
    for relation in owner
        .relations
        .iter()
        .filter(|entry| entry.path == owner.owner_path)
    {
        let projected = relation_record(relation);
        if allowed.contains(&projected.kind) {
            records.push(projected);
        }
    }
    let mut diagnostic_codes = Vec::new();
    for (diagnostic_index, diagnostic) in owner
        .diagnostics
        .iter()
        .filter(|entry| entry.path == owner.owner_path)
        .enumerate()
    {
        diagnostic_codes.push(diagnostic.code.clone());
        let projected = diagnostic_record(diagnostic, diagnostic_index);
        if allowed.contains(&projected.kind) {
            records.push(projected);
        }
    }

    let entity_by_id = owner
        .entities
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let file_by_path = owner
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let record_keys = records
        .iter()
        .map(|entry| {
            (
                entry.identity_key.as_str(),
                entry.proposal_record_key.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut dependencies = Vec::new();
    for relation in owner
        .relations
        .iter()
        .filter(|entry| entry.path == owner.owner_path)
    {
        let Some(target_id) = &relation.target_id else {
            continue;
        };
        let relation_kind = format!(
            "jsts:relation_{}",
            relation
                .kind
                .strip_prefix("core:")
                .unwrap_or(&relation.kind)
        );
        if !allowed.contains(&relation_kind) {
            continue;
        }
        let Some(target) = entity_by_id.get(target_id.as_str()) else {
            continue;
        };
        if target.path == owner.owner_path {
            continue;
        }
        let Some(file) = file_by_path.get(target.path.as_str()) else {
            continue;
        };
        let (Some(artifact_id), Some(version_id), Some(proposal_record_key)) = (
            &file.artifact_id,
            &file.artifact_version_id,
            record_keys.get(relation.id.as_str()),
        ) else {
            continue;
        };
        let mut source_reference = Map::new();
        source_reference.insert(
            "reference_type".into(),
            Value::String("local_proposal".into()),
        );
        source_reference.insert(
            "proposal_record_key".into(),
            Value::String((*proposal_record_key).to_owned()),
        );
        if let Some(hash) = &file.content_hash {
            source_reference.insert("content_hash".into(), Value::String(hash.clone()));
        }
        dependencies.push(StructuralKernelDependency {
            proposed_dependency_id: dependency_id(&relation.id, version_id),
            proposal_record_key: (*proposal_record_key).to_owned(),
            dependency_artifact_id: artifact_id.clone(),
            dependency_artifact_version_id: version_id.clone(),
            dependency_role: "jsts:resolution_input".into(),
            dependency_basis: "checker_resolution".into(),
            source_reference: Value::Object(source_reference),
        });
    }
    ProjectedOwner {
        records,
        dependencies,
        diagnostic_codes,
    }
}

/// Projects a bounded semantic observation group and immediately runs the
/// language-neutral structural kernel over the exact emitted rows.
pub fn project(batch: &ProjectionBatch) -> NativeCoreResult<ProjectionResult> {
    let mut owners = batch.owners.iter().map(project_owner).collect::<Vec<_>>();
    let mut record_headers = Vec::with_capacity(owners.len());
    let mut dependency_headers = Vec::with_capacity(owners.len());
    let mut record_counts = Vec::with_capacity(owners.len());
    let mut dependency_counts = Vec::with_capacity(owners.len());
    let mut structural_records = Vec::new();
    let mut structural_dependencies = Vec::new();
    for owner in &mut owners {
        record_counts.push(owner.records.len());
        dependency_counts.push(owner.dependencies.len());
        record_headers.push(
            owner
                .records
                .iter()
                .map(|record| ProjectedRecordHeader {
                    proposal_record_key: record.proposal_record_key.clone(),
                    category: record.category.clone(),
                    kind: record.kind.clone(),
                    universal_kind: record.universal_kind.clone(),
                    identity_key: record.identity_key.clone(),
                })
                .collect::<Vec<_>>(),
        );
        dependency_headers.push(
            owner
                .dependencies
                .iter()
                .map(|dependency| ProjectedDependencyHeader {
                    proposed_dependency_id: dependency.proposed_dependency_id.clone(),
                    proposal_record_key: dependency.proposal_record_key.clone(),
                    dependency_artifact_id: dependency.dependency_artifact_id.clone(),
                    dependency_artifact_version_id: dependency
                        .dependency_artifact_version_id
                        .clone(),
                    dependency_role: dependency.dependency_role.clone(),
                })
                .collect::<Vec<_>>(),
        );
        structural_records.append(&mut owner.records);
        structural_dependencies.append(&mut owner.dependencies);
    }
    let structural = StructuralKernelBatch {
        records: structural_records,
        dependencies: structural_dependencies,
    };
    let kernel = structural_kernel_seal_batch(&structural)?;
    // The kernel already returns canonical strings in owner-contiguous order.
    // Move them into the per-owner envelopes instead of slicing with `to_vec`,
    // which cloned every large canonical row before the Node boundary.
    let mut canonical_records = kernel.canonical_records.into_iter();
    let mut canonical_dependencies = kernel.canonical_dependencies.into_iter();
    let sealed = owners
        .into_iter()
        .enumerate()
        .map(|(index, owner)| SealedProjectedOwner {
            canonical_records: (0..record_counts[index])
                .map(|_| {
                    canonical_records
                        .next()
                        .expect("kernel record count matches owners")
                })
                .collect(),
            canonical_dependencies: (0..dependency_counts[index])
                .map(|_| {
                    canonical_dependencies
                        .next()
                        .expect("kernel dependency count matches owners")
                })
                .collect(),
            record_headers: record_headers[index].clone(),
            dependency_headers: dependency_headers[index].clone(),
            diagnostic_codes: owner.diagnostic_codes,
        })
        .collect();
    Ok(ProjectionResult { owners: sealed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_semantic_observations_with_exact_bounded_identities() {
        let result = project(&ProjectionBatch {
            owners: vec![ProjectionOwner {
                language: "typescript".into(),
                owner_path: "src/a.ts".into(),
                entities: vec![EntityObservation {
                    id: "jsts:entity:a".into(),
                    name: "a".into(),
                    kind: "function".into(),
                    universal_kind: "core:callable".into(),
                    path: "src/a.ts".into(),
                    start: 0,
                    end: 10,
                    parent_id: None,
                    qualified_name: Some("a".into()),
                    r#type: Some("() => void".into()),
                    is_test: None,
                }],
                relations: vec![],
                diagnostics: vec![],
                files: vec![],
                allowed_record_kinds: vec![
                    "jsts:entity_callable".into(),
                    "jsts:entity_inferred_type".into(),
                    "jsts:relation_type_of".into(),
                ],
            }],
        })
        .expect("projection succeeds");
        assert_eq!(result.owners[0].record_headers.len(), 3);
        assert_eq!(result.owners[0].canonical_records.len(), 3);
        assert!(
            result.owners[0].record_headers[0]
                .proposal_record_key
                .starts_with("jsts:record:sha256:")
        );
        assert_eq!(result.owners[0].canonical_dependencies.len(), 0);
    }
}
