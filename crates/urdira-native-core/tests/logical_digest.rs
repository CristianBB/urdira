use urdira_native_core::{
    LogicalField, LogicalRecord, LogicalRecordVerification, LogicalValue, LogicalValueRecord,
    LogicalValueVerification, logical_digest_batch, logical_value_digest_batch,
    verify_logical_record_batch, verify_logical_value_batch,
};

fn field(identifier: &str, value: LogicalValue) -> LogicalField {
    LogicalField {
        identifier: identifier.to_owned(),
        present: true,
        value: Some(value),
    }
}

#[test]
fn logical_digest_matches_the_typescript_oracle_for_ordering_and_utf8() {
    let records = vec![
        LogicalRecord {
            domain: "urdira:test-record:v3".to_owned(),
            fields: vec![
                field(
                    "zeta",
                    LogicalValue::Text {
                        value: "héllø 世界".to_owned(),
                    },
                ),
                field(
                    "alpha",
                    LogicalValue::Integer {
                        value: "42".to_owned(),
                    },
                ),
            ],
        },
        LogicalRecord {
            domain: "urdira:test-record:v3".to_owned(),
            fields: vec![
                field(
                    "alpha",
                    LogicalValue::Integer {
                        value: "42".to_owned(),
                    },
                ),
                field(
                    "zeta",
                    LogicalValue::Text {
                        value: "héllø 世界".to_owned(),
                    },
                ),
            ],
        },
    ];

    let digests = logical_digest_batch(&records).expect("digest batch");
    assert_eq!(
        digests[0].digest,
        "sha256:84b9fb272423f63d7907fc29026a4cfa83ad6241e7f8550bc8717d5070dfc878"
    );
    assert_ne!(digests[0].digest, digests[1].digest);
}

#[test]
fn digest_and_verification_batches_preserve_presence_and_detect_mismatch() {
    let record = LogicalRecord {
        domain: "records".to_owned(),
        fields: vec![
            field(
                "name",
                LogicalValue::Text {
                    value: "alpha".to_owned(),
                },
            ),
            LogicalField {
                identifier: "description".to_owned(),
                present: false,
                value: None,
            },
        ],
    };
    let digest =
        logical_digest_batch(std::slice::from_ref(&record)).expect("digest batch")[0].clone();
    let results = verify_logical_record_batch(&[
        LogicalRecordVerification {
            record: record.clone(),
            expected_digest: digest.digest.clone(),
        },
        LogicalRecordVerification {
            record,
            expected_digest: format!("sha256:{}", "0".repeat(64)),
        },
    ])
    .expect("verification batch");

    assert!(results[0].valid);
    assert!(!results[1].valid);
    assert_eq!(results[0].actual_digest, digest.digest);
}

#[test]
fn malformed_schema_owned_fields_fail_closed() {
    let duplicated = LogicalRecord {
        domain: "records".to_owned(),
        fields: vec![
            field("name", LogicalValue::Null),
            field("name", LogicalValue::Null),
        ],
    };
    assert!(
        logical_digest_batch(&[duplicated])
            .unwrap_err()
            .to_string()
            .contains("duplicate")
    );

    let absent_with_value = LogicalRecord {
        domain: "records".to_owned(),
        fields: vec![LogicalField {
            identifier: "name".to_owned(),
            present: false,
            value: Some(LogicalValue::Null),
        }],
    };
    assert!(
        logical_digest_batch(&[absent_with_value])
            .unwrap_err()
            .to_string()
            .contains("absent")
    );
}

#[test]
fn digest_batches_enforce_record_and_byte_bounds() {
    let empty = LogicalRecord {
        domain: "records".to_owned(),
        fields: Vec::new(),
    };
    let oversized_count = vec![empty; 4_097];
    assert!(
        logical_digest_batch(&oversized_count)
            .unwrap_err()
            .to_string()
            .contains("4096")
    );

    let oversized_bytes = LogicalRecord {
        domain: "records".to_owned(),
        fields: vec![field(
            "payload",
            LogicalValue::Text {
                value: "x".repeat(4 * 1024 * 1024),
            },
        )],
    };
    assert!(
        logical_digest_batch(&[oversized_bytes])
            .unwrap_err()
            .to_string()
            .contains("byte bound")
    );
}

#[test]
fn root_value_batches_digest_and_verify_the_same_owned_value() {
    let record = LogicalValueRecord {
        domain: "urdira:projection-set:v3".to_owned(),
        value: LogicalValue::Sequence {
            values: vec![LogicalValue::Record {
                fields: vec![field(
                    "name",
                    LogicalValue::Text {
                        value: "alpha".to_owned(),
                    },
                )],
            }],
        },
    };
    let digest = logical_value_digest_batch(std::slice::from_ref(&record))
        .expect("logical value digest batch")[0]
        .clone();
    let verification = verify_logical_value_batch(&[LogicalValueVerification {
        record,
        expected_digest: digest.digest.clone(),
    }])
    .expect("logical value verification batch");
    assert!(verification[0].valid);
    assert_eq!(verification[0].actual_digest, digest.digest);
}
