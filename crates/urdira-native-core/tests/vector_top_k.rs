use urdira_native_core::{
    DistanceMetric, ExactVectorRequest, PackedExactVectorRequest, PackedVectorElementType,
    VectorCandidate, exact_packed_vector_top_k_batch, exact_vector_top_k_batch,
};

fn candidate(id: &str, vector: &[f64]) -> VectorCandidate {
    VectorCandidate {
        id: id.to_owned(),
        vector: vector.to_vec(),
    }
}

#[test]
fn exact_top_k_uses_utf8_identifier_ties() {
    let result = exact_vector_top_k_batch(&[ExactVectorRequest {
        query: vec![1.0, 0.0],
        candidates: vec![
            candidate("b", &[1.0, 0.0]),
            candidate("a", &[1.0, 0.0]),
            candidate("c", &[0.0, 1.0]),
        ],
        k: 2,
        metric: DistanceMetric::Cosine,
    }])
    .expect("top-k batch");

    assert_eq!(
        result[0]
            .iter()
            .map(|item| item.projection_record_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(result[0][0].rank, 1);
    assert_eq!(result[0][1].rank, 2);
}

#[test]
fn cosine_rejects_zero_vectors_and_squared_l2_accepts_them() {
    let cosine = ExactVectorRequest {
        query: vec![0.0, 0.0],
        candidates: vec![candidate("a", &[1.0, 0.0])],
        k: 1,
        metric: DistanceMetric::Cosine,
    };
    assert!(
        exact_vector_top_k_batch(&[cosine])
            .unwrap_err()
            .to_string()
            .contains("zero")
    );

    let l2 = ExactVectorRequest {
        query: vec![0.0, 0.0],
        candidates: vec![candidate("b", &[1.0, 0.0]), candidate("a", &[0.0, 0.0])],
        k: 2,
        metric: DistanceMetric::SquaredL2,
    };
    let result = exact_vector_top_k_batch(&[l2]).expect("squared L2 top-k");
    assert_eq!(result[0][0].projection_record_id, "a");
}

#[test]
fn packed_little_endian_vectors_are_length_checked_before_exact_scan() {
    let bytes = |values: &[f64]| {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>()
    };
    let request = PackedExactVectorRequest {
        query: bytes(&[1.0, 0.0]),
        candidates: bytes(&[1.0, 0.0, 1.0, 0.0]),
        projection_record_ids: vec!["b".to_owned(), "a".to_owned()],
        dimensions: 2,
        element_type: PackedVectorElementType::Float64Le,
        k: 2,
        metric: DistanceMetric::Cosine,
    };
    let result =
        exact_packed_vector_top_k_batch(std::slice::from_ref(&request)).expect("packed exact scan");
    assert_eq!(result[0][0].projection_record_id, "a");

    let malformed = PackedExactVectorRequest {
        candidates: vec![0; 3],
        ..request
    };
    assert!(
        exact_packed_vector_top_k_batch(&[malformed])
            .unwrap_err()
            .to_string()
            .contains("byte length")
    );
}
