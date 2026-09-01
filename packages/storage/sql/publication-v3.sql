-- name: candidate_publication_descriptor_empty
INSERT OR IGNORE INTO candidate_publication_descriptors (candidate_generation_id, workspace_id, record_count, facet_count, identity_count, canonical_byte_length, first_record_id, last_record_id, record_sequence_digest, identity_sequence_digest, sealed_at) VALUES (?1, ?2, 0, 0, 0, 0, NULL, NULL, 'rust:pending', 'rust:pending', ?3)

-- name: candidate_publication_projection_descriptor_empty
INSERT OR IGNORE INTO candidate_publication_projection_descriptors (candidate_generation_id, workspace_id, projection_count, dependency_count, value_node_count, first_projection_record_id, last_projection_record_id, projection_sequence_digest, sealed_at) VALUES (?1, ?2, 0, 0, 0, NULL, NULL, 'rust:empty', ?3)
