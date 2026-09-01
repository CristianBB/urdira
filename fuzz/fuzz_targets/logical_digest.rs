#![no_main]

use libfuzzer_sys::fuzz_target;
use urdira_fuzz::{ByteCursor, MAX_FUZZ_INPUT_BYTES};
use urdira_native_core::{
    LogicalField, LogicalRecord, LogicalRecordVerification, LogicalValue, LogicalValueRecord,
    LogicalValueVerification, logical_digest_batch, logical_value_digest_batch,
    verify_logical_record_batch, verify_logical_value_batch,
};

const MAX_DEPTH: usize = 6;
const MAX_CHILDREN: usize = 8;
const MAX_RECORDS: usize = 16;

fuzz_target!(|input: &[u8]| {
    if input.len() > MAX_FUZZ_INPUT_BYTES {
        return;
    }

    if let Ok(records) = serde_json::from_slice::<Vec<LogicalRecord>>(input) {
        let _ = logical_digest_batch(&records);
    }

    let mut cursor = ByteCursor::new(input);
    let count = cursor.next_usize(MAX_RECORDS + 1);
    let records = (0..count)
        .map(|index| logical_record(&mut cursor, index))
        .collect::<Vec<_>>();
    if let Ok(digests) = logical_digest_batch(&records) {
        let verifications = records
            .iter()
            .cloned()
            .zip(&digests)
            .map(|(record, digest)| LogicalRecordVerification {
                record,
                expected_digest: digest.digest.clone(),
            })
            .collect::<Vec<_>>();
        let verified = verify_logical_record_batch(&verifications)
            .expect("a digest emitted by the native core must verify");
        assert!(verified.iter().all(|result| result.valid));
        if let Some(first) = verifications.first() {
            let mut mismatched = first.clone();
            let replacement = if mismatched.expected_digest.ends_with('0') {
                '1'
            } else {
                '0'
            };
            mismatched.expected_digest.pop();
            mismatched.expected_digest.push(replacement);
            let result = verify_logical_record_batch(&[mismatched])
                .expect("a well-formed mismatching digest is a valid verification request");
            assert!(!result[0].valid);
        }
    }

    let value_records = records
        .iter()
        .enumerate()
        .map(|(index, record)| LogicalValueRecord {
            domain: format!("value-{index}"),
            value: LogicalValue::Record {
                fields: record.fields.clone(),
            },
        })
        .collect::<Vec<_>>();
    if let Ok(digests) = logical_value_digest_batch(&value_records) {
        let verifications = value_records
            .into_iter()
            .zip(digests)
            .map(|(record, digest)| LogicalValueVerification {
                record,
                expected_digest: digest.digest,
            })
            .collect::<Vec<_>>();
        let verified = verify_logical_value_batch(&verifications)
            .expect("a logical value digest emitted by the native core must verify");
        assert!(verified.iter().all(|result| result.valid));
    }
});

fn logical_record(cursor: &mut ByteCursor<'_>, index: usize) -> LogicalRecord {
    let field_count = cursor.next_usize(MAX_CHILDREN + 1);
    LogicalRecord {
        domain: format!("fuzz-domain-{index}-{}", cursor.text(48)),
        fields: (0..field_count)
            .map(|field_index| {
                let present = cursor.next_u8().is_multiple_of(2);
                LogicalField {
                    identifier: if cursor.next_u8().is_multiple_of(5) {
                        "duplicate".to_owned()
                    } else {
                        format!("field-{field_index}-{}", cursor.text(48))
                    },
                    present,
                    value: if present || cursor.next_u8().is_multiple_of(7) {
                        Some(logical_value(cursor, 0))
                    } else {
                        None
                    },
                }
            })
            .collect(),
    }
}

fn logical_value(cursor: &mut ByteCursor<'_>, depth: usize) -> LogicalValue {
    if depth >= MAX_DEPTH {
        return LogicalValue::Text {
            value: cursor.text(64),
        };
    }
    match cursor.next_u8() % 9 {
        0 => LogicalValue::Null,
        1 => LogicalValue::Boolean {
            value: cursor.next_u8().is_multiple_of(2),
        },
        2 => LogicalValue::Integer {
            value: cursor.text(32),
        },
        3 => {
            let mut bytes = [0u8; 8];
            let source = cursor.take(8);
            bytes[..source.len()].copy_from_slice(source);
            LogicalValue::Real {
                value: f64::from_bits(u64::from_le_bytes(bytes)),
            }
        }
        4 => LogicalValue::Text {
            value: cursor.text(96),
        },
        5 => LogicalValue::Bytes {
            value: cursor.take(96).to_vec(),
        },
        6 => LogicalValue::Sequence {
            values: children(cursor, depth),
        },
        7 => LogicalValue::Set {
            values: children(cursor, depth),
        },
        _ => {
            let count = cursor.next_usize(MAX_CHILDREN + 1);
            LogicalValue::Record {
                fields: (0..count)
                    .map(|index| LogicalField {
                        identifier: format!("nested-{index}-{}", cursor.text(32)),
                        present: true,
                        value: Some(logical_value(cursor, depth + 1)),
                    })
                    .collect(),
            }
        }
    }
}

fn children(cursor: &mut ByteCursor<'_>, depth: usize) -> Vec<LogicalValue> {
    let count = cursor.next_usize(MAX_CHILDREN + 1);
    (0..count)
        .map(|_| logical_value(cursor, depth + 1))
        .collect()
}
