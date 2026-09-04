use serde_json::json;
use urdira_native_core::{
    StructuralKernelBatch, StructuralKernelDependency, StructuralKernelRecord,
    structural_kernel_batch, structural_kernel_batch_parts, structural_kernel_rows,
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

fn decode_hex(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "odd-length hex string: {hex}");
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("valid hex byte"))
        .collect()
}

fn decode_32(hex: &str) -> [u8; 32] {
    decode_hex(hex).try_into().expect("32-byte digest")
}

/// P2-2f equivalence test: for a fixture batch mixing entity and relation
/// records (multi-byte UTF-8 identity keys/bodies, a facets array, a
/// present source_span), `structural_kernel_rows` (the new bytes-native
/// entrypoint `urdira-indexing-worker`'s v4 materialize pass now calls)
/// must produce, for every record, EXACTLY the same
/// record_id/record_digest/body_digest/body/facets/span/identity_type/
/// identity_key/identity_id/identity_key_digest/identity_assignment_id as
/// the pre-existing `structural_kernel_batch_parts` oracle (hex/JSON-text
/// shaped), field by field, byte for byte.
#[test]
fn native_core_rows_match_batch_parts_oracle() {
    let mut entity = record("proposal:entity");
    entity.facets = "[\"core:named\",\"core:declaration\"]".to_owned();
    entity.identity_key = "jsts:variable:src/é.ts:0:widgét".to_owned();
    entity.source_span = "{\"end\":42,\"path\":\"src/é.ts\",\"start\":7}".to_owned();

    let mut relation = record("proposal:relation");
    relation.category = "relation".to_owned();
    relation.kind = "jsts:relation_contains".to_owned();
    relation.universal_kind = "core:contains".to_owned();
    relation.facets = "[\"core:structural_relation\"]".to_owned();
    relation.identity_key = "jsts:contains:a:b".to_owned();
    relation.body = json!({
        "source_id": "jsts:variable:src/a.ts:0:a",
        "target_id": "jsts:variable:src/b.ts:0:b",
        "note": "é",
    });
    relation.source_span = "{\"end\":20,\"path\":\"src/a.ts\",\"start\":0}".to_owned();

    let mut diagnostic = record("proposal:diagnostic");
    diagnostic.category = "diagnostic".to_owned();
    // Non-canonical facets text (extra spaces): exercises the
    // `structural_attestation == false` / empty-facets fallback path both
    // the oracle and the new function must agree on.
    diagnostic.facets = "[ \"core:named\" ]".to_owned();
    diagnostic.source_span = String::new();

    let records = vec![entity, relation, diagnostic];

    let oracle = structural_kernel_batch_parts(&records, &[]).expect("oracle kernel call");
    let bytes_result = structural_kernel_rows(&records).expect("bytes-native kernel call");

    assert_eq!(bytes_result.rows.len(), records.len());
    assert_eq!(oracle.publication_records.len(), records.len());

    for (index, row) in bytes_result.rows.iter().enumerate() {
        let publication = &oracle.publication_records[index];
        assert_eq!(
            row.record_id,
            decode_32(publication.record_id.trim_start_matches("record:")),
            "record_id mismatch at index {index}"
        );
        assert_eq!(
            row.record_digest,
            decode_32(publication.record_digest.trim_start_matches("sha256:")),
            "record_digest mismatch at index {index}"
        );
        assert_eq!(
            row.body_digest,
            decode_32(publication.body_digest.trim_start_matches("sha256:")),
            "body_digest mismatch at index {index}"
        );
        assert_eq!(
            row.body_byte_length, publication.body_byte_length,
            "body_byte_length mismatch at index {index}"
        );
        assert_eq!(
            row.body,
            decode_hex(&oracle.record_body_payload_hexes[index]),
            "body bytes mismatch at index {index}"
        );
        assert_eq!(
            row.facets, publication.facets,
            "facets mismatch at index {index}"
        );
        assert_eq!(
            row.structural_attestation, oracle.record_structural_attestations[index],
            "structural_attestation mismatch at index {index}"
        );
        assert_eq!(
            row.identity_type, publication.identity_type,
            "identity_type mismatch at index {index}"
        );
        assert_eq!(
            row.identity_key, publication.identity_key,
            "identity_key mismatch at index {index}"
        );
        assert_eq!(
            row.identity_id,
            decode_32(
                publication
                    .identity_id
                    .rsplit_once(':')
                    .expect("type-prefixed identity id")
                    .1
            ),
            "identity_id mismatch at index {index}"
        );
        assert_eq!(
            row.identity_key_digest,
            decode_32(
                publication
                    .identity_key_digest
                    .trim_start_matches("sha256:")
            ),
            "identity_key_digest mismatch at index {index}"
        );
        assert_eq!(
            row.identity_assignment_id,
            decode_32(
                publication
                    .identity_assignment_id
                    .trim_start_matches("sha256:")
            ),
            "identity_assignment_id mismatch at index {index}"
        );

        let expected_span = publication
            .primary_source_span
            .as_ref()
            .map(|span| {
                (
                    span.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                    span.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                )
            })
            .unwrap_or((0, 0));
        assert_eq!(
            (row.span_start, row.span_end),
            expected_span,
            "span mismatch at index {index}"
        );
    }

    // Bisection safety valve: still enforced on the bytes-native path.
    let too_many: Vec<StructuralKernelRecord> = (0..4_097)
        .map(|index| record(&format!("proposal:{index}")))
        .collect();
    assert!(structural_kernel_rows(&too_many).is_err());
}

/// P2-2l item 2 equivalence test: for facets text that is canonical by
/// construction (this file's own `record()` fixture already builds
/// canonical facets text -- matching every real `ProposedRecord` producer
/// this task audited, `urdira-jsts-syntax-worker`'s `lib.rs`/`semantic_
/// sites.rs`), `structural_kernel_rows_typed` must produce EXACTLY the
/// same rows as `structural_kernel_rows_ref`, field by field, when handed
/// each record's own already-parsed facet list -- the guarantee this
/// task's `structural_kernel_rows_typed` doc comment argues for by
/// construction, checked here directly rather than only argued.
#[test]
fn typed_rows_match_untyped_rows_oracle() {
    use urdira_native_core::{structural_kernel_rows_ref, structural_kernel_rows_typed};

    let mut entity = record("proposal:typed-entity");
    entity.facets = "[\"core:named\",\"core:declaration\"]".to_owned();

    let mut relation = record("proposal:typed-relation");
    relation.category = "relation".to_owned();
    relation.facets = "[\"core:structural_relation\"]".to_owned();

    let mut empty_facets = record("proposal:typed-empty");
    empty_facets.facets = "[]".to_owned();
    empty_facets.source_span = String::new();

    let records = [entity, relation, empty_facets];
    let refs: Vec<_> = records.iter().map(|r| r.as_ref()).collect();
    let typed_facets: Vec<Vec<String>> = vec![
        vec!["core:named".to_string(), "core:declaration".to_string()],
        vec!["core:structural_relation".to_string()],
        vec![],
    ];
    let typed_facets_refs: Vec<&[String]> = typed_facets.iter().map(Vec::as_slice).collect();

    let untyped = structural_kernel_rows_ref(&refs).expect("untyped kernel call");
    let typed = structural_kernel_rows_typed(&refs, &typed_facets_refs).expect("typed kernel call");

    assert_eq!(untyped.byte_length, typed.byte_length);
    assert_eq!(untyped.rows.len(), typed.rows.len());
    for (index, (expected, actual)) in untyped.rows.iter().zip(typed.rows.iter()).enumerate() {
        assert_eq!(expected, actual, "row mismatch at index {index}");
    }

    // Mismatched lengths are rejected rather than silently truncated/padded.
    assert!(structural_kernel_rows_typed(&refs, &typed_facets_refs[..2]).is_err());
}
