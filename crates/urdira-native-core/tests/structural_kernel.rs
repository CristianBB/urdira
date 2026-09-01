use serde_json::json;
use urdira_native_core::{
    StructuralKernelBatch, StructuralKernelDependency, StructuralKernelRecord,
    structural_kernel_batch, structural_kernel_batch_parts,
};

fn record(key: &str) -> StructuralKernelRecord {
    StructuralKernelRecord {
        proposal_record_key: key.to_owned(),
        category: "entity".to_owned(),
        kind: "jsts:entity_declaration".to_owned(),
        universal_kind: "core:declaration".to_owned(),
        facets: "[\"core:named\"]".to_owned(),
        schema_version: 1,
        source_span: "{\"end\":2,\"path\":\"src/é.ts\",\"start\":1}".to_owned(),
        identity_key: "decl:é".to_owned(),
        body: json!({ "z": 1, "é": true, "a": [null, "text"] }),
        evidence_references: "[]".to_owned(),
    }
}

#[test]
fn canonicalizes_and_digests_closed_structural_rows() {
    let batch = StructuralKernelBatch {
        records: vec![record("proposal:one")],
        dependencies: vec![StructuralKernelDependency {
            proposed_dependency_id: "dependency:one".to_owned(),
            proposal_record_key: "proposal:one".to_owned(),
            dependency_artifact_id: "artifact:dep".to_owned(),
            dependency_artifact_version_id: "artifact-version:dep".to_owned(),
            dependency_role: "core:imports".to_owned(),
            dependency_basis: "proposal".to_owned(),
            source_reference: json!({ "reference_type": "local_proposal", "proposal_record_key": "proposal:one" }),
        }],
    };
    let result = structural_kernel_batch(&batch).expect("kernel batch");
    let borrowed_result = structural_kernel_batch_parts(&batch.records, &batch.dependencies)
        .expect("borrowed kernel batch");
    assert_eq!(result, borrowed_result);
    assert_eq!(result.canonical_records.len(), 1);
    assert_eq!(result.record_facets, vec![Some(vec!["core:named".into()])]);
    assert_eq!(result.record_structural_attestations, vec![true]);
    assert_eq!(result.canonical_dependencies.len(), 1);
    assert!(
        result.canonical_records[0].contains("\"body\":{\"a\":[null,\"text\"],\"z\":1,\"é\":true}")
    );
    assert_eq!(
        result.record_ids[0],
        format!(
            "record:{}",
            result.record_digests[0].trim_start_matches("sha256:")
        )
    );
    assert!(result.records_digest.starts_with("sha256:"));
    assert!(result.dependencies_digest.starts_with("sha256:"));
}

#[test]
fn leaves_business_validation_to_the_engine() {
    let mut mechanically_valid = record("");
    mechanically_valid.facets = "[ \"core:named\" ]".to_owned();
    let unresolved = StructuralKernelDependency {
        proposed_dependency_id: "".to_owned(),
        proposal_record_key: "proposal:missing".to_owned(),
        dependency_artifact_id: "artifact:dep".to_owned(),
        dependency_artifact_version_id: "artifact-version:dep".to_owned(),
        dependency_role: "core:imports".to_owned(),
        dependency_basis: "proposal".to_owned(),
        source_reference: json!({ "reference_type": "local_proposal", "proposal_record_key": "proposal:missing" }),
    };
    let result = structural_kernel_batch(&StructuralKernelBatch {
        records: vec![mechanically_valid],
        dependencies: vec![unresolved],
    })
    .expect("mechanical kernel batch");
    assert!(result.canonical_records[0].contains("[ \\\"core:named\\\" ]"));
}

#[test]
fn enforces_safe_integer_and_row_budgets() {
    let mut invalid_number = record("proposal:number");
    invalid_number.body = json!({ "unsafe": 9_007_199_254_740_992_i64 });
    assert!(
        structural_kernel_batch(&StructuralKernelBatch {
            records: vec![invalid_number],
            dependencies: vec![]
        })
        .is_err()
    );

    let records = (0..4_097)
        .map(|index| record(&format!("proposal:{index}")))
        .collect();
    assert!(
        structural_kernel_batch(&StructuralKernelBatch {
            records,
            dependencies: vec![]
        })
        .is_err()
    );
}
