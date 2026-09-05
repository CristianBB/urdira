use serde_json::json;
use urdira_native_core::{
    StructuralKernelBatch, StructuralKernelDependency, StructuralKernelRecord,
    structural_kernel_batch, structural_kernel_batch_parts, structural_kernel_rows,
};

// A3b: BodyEncoder/EncodedBody/decode_body oracle tests, below.
mod a3b_body_encoder {
    use serde::Serialize;
    use serde_json::{Map, Value, json};
    use urdira_native_core::{
        BodyEncoder, BodyRef, StructuralKernelRecordRef, decode_body, serialize_payload,
        structural_kernel_rows_ref,
    };

    /// A3b coste 1: `serde::Serialize`-able wrapper around a raw
    /// `BodyEncoder`-produced payload, calling `serialize_payload` directly
    /// -- exists only so `assert_body_oracle` (below) can hand
    /// `serde_json::to_string` the STREAMING serializer path (no
    /// intermediate `Value`) and compare its output against `serde_json::
    /// to_string(&value)` byte for byte, for every one of this test's 14
    /// producer-shape bodies.
    struct PayloadWrapper<'a>(&'a [u8]);

    impl Serialize for PayloadWrapper<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serialize_payload(self.0, serializer)
        }
    }

    /// A small typed value tree used to build BOTH sides of the oracle: the
    /// `serde_json::Value` a not-yet-migrated producer would build, and the
    /// [`BodyEncoder`] calls a migrated producer makes for the exact same
    /// logical content. Keeping ONE typed description and deriving both
    /// sides from it (rather than writing the `Value` and the encoder calls
    /// separately by hand) makes it structurally impossible for the two
    /// sides to drift on anything but the one thing under test: whether the
    /// two encodings actually agree.
    #[derive(Clone)]
    enum FieldValue {
        Str(String),
        /// Encoded via `BodyEncoder::uint` -- mirrors a body field built
        /// from a Rust unsigned integer (`Value::from(some_u32)`, etc.).
        Uint(u64),
        /// Encoded via `BodyEncoder::int` -- mirrors a body field built
        /// from a Rust signed integer (`Value::from(some_i32)`, etc.).
        Int(i64),
        /// Encoded via `BodyEncoder::real` -- mirrors a body field built
        /// from an actual Rust `f64`.
        Real(f64),
        Bool(bool),
        Null,
        Array(Vec<FieldValue>),
        Object(Vec<(&'static str, FieldValue)>),
    }

    impl FieldValue {
        fn to_json(&self) -> Value {
            match self {
                FieldValue::Str(value) => Value::String(value.clone()),
                FieldValue::Uint(value) => Value::from(*value),
                FieldValue::Int(value) => Value::from(*value),
                FieldValue::Real(value) => Value::from(*value),
                FieldValue::Bool(value) => Value::Bool(*value),
                FieldValue::Null => Value::Null,
                FieldValue::Array(items) => {
                    Value::Array(items.iter().map(FieldValue::to_json).collect())
                }
                FieldValue::Object(fields) => {
                    let mut map = Map::new();
                    for (key, value) in fields {
                        map.insert((*key).to_owned(), value.to_json());
                    }
                    Value::Object(map)
                }
            }
        }

        fn encode(&self, encoder: &mut BodyEncoder) {
            match self {
                FieldValue::Str(value) => encoder.string(value).expect("string never fails"),
                FieldValue::Uint(value) => encoder.uint(*value).expect("uint never fails"),
                FieldValue::Int(value) => encoder.int(*value).expect("int never fails"),
                FieldValue::Real(value) => encoder.real(*value).expect("finite, non-negative-zero"),
                FieldValue::Bool(value) => encoder.bool(*value).expect("bool never fails"),
                FieldValue::Null => encoder.null().expect("null never fails"),
                FieldValue::Array(items) => {
                    encoder
                        .begin_array(items.len())
                        .expect("array field count is fixed");
                    for item in items {
                        item.encode(encoder);
                    }
                }
                FieldValue::Object(fields) => {
                    encoder
                        .begin_object(fields.len())
                        .expect("object field count is fixed");
                    for (key, value) in fields {
                        encoder.key(key).expect("fields given in sorted order");
                        value.encode(encoder);
                    }
                }
            }
        }
    }

    /// Builds the top-level body `Value` for `fields` (already given in
    /// strict lexicographic key order by the caller -- `serde_json::Map`
    /// would reorder them into the same order regardless, since this
    /// workspace never enables `preserve_order`, but keeping the test's own
    /// input pre-sorted keeps it an honest mirror of what a real producer's
    /// `BodyEncoder` calls must do).
    fn build_value(fields: &[(&'static str, FieldValue)]) -> Value {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert((*key).to_owned(), value.to_json());
        }
        Value::Object(map)
    }

    fn build_encoded(fields: &[(&'static str, FieldValue)]) -> urdira_native_core::EncodedBody {
        let mut encoder = BodyEncoder::new();
        encoder
            .begin_object(fields.len())
            .expect("object field count is fixed");
        for (key, value) in fields {
            encoder.key(key).expect("fields given in sorted order");
            value.encode(&mut encoder);
        }
        encoder.finish()
    }

    fn record_ref<'a>(
        category: &'a str,
        kind: &'a str,
        universal_kind: &'a str,
        identity_key: &'a str,
        body: BodyRef<'a>,
    ) -> StructuralKernelRecordRef<'a> {
        StructuralKernelRecordRef {
            proposal_record_key: identity_key,
            category,
            kind,
            universal_kind,
            facets: "[]",
            schema_version: 1,
            source_span: "{\"end\":2,\"path\":\"a.ts\",\"start\":1}",
            identity_key,
            body,
            evidence_references: "[]",
        }
    }

    /// The core oracle: for `fields` (one representative body per
    /// producer-shape, given in strict lexicographic key order), asserts
    /// that canonicalizing a record whose body is the equivalent `Value`
    /// tree and canonicalizing a record whose body is the [`BodyEncoder`]-
    /// built [`urdira_native_core::EncodedBody`] produce byte-for-byte
    /// identical `StructuralKernelRow`s -- `record_id`, `record_digest`,
    /// `body_digest`, `body_byte_length`, `body` payload bytes,
    /// `identity_key`, and `identity_id` all included (every field
    /// `StructuralKernelRow` derives `PartialEq` over, so `assert_eq!` on
    /// the whole row checks all of them at once). Both records share every
    /// OTHER field (`category`/`kind`/`universal_kind`/`identity_key`), so
    /// any difference in the resulting rows can only come from the body
    /// encoding itself.
    fn assert_body_oracle(
        category: &str,
        kind: &str,
        universal_kind: &str,
        identity_key: &str,
        fields: &[(&'static str, FieldValue)],
    ) {
        let value = build_value(fields);
        let encoded = build_encoded(fields);
        let value_row = structural_kernel_rows_ref(&[record_ref(
            category,
            kind,
            universal_kind,
            identity_key,
            BodyRef::Value(&value),
        )])
        .expect("value-bodied kernel call");
        let encoded_row = structural_kernel_rows_ref(&[record_ref(
            category,
            kind,
            universal_kind,
            identity_key,
            BodyRef::Encoded(&encoded),
        )])
        .expect("encoded-bodied kernel call");
        assert_eq!(
            value_row.rows, encoded_row.rows,
            "Value vs Encoded row mismatch for identity_key={identity_key}"
        );
        assert_eq!(value_row.byte_length, encoded_row.byte_length);
        // decode_body(encode(x)) == x, for the same case (whole-number
        // encoder.uint/int values normalize back to serde_json's integer
        // Number variant on decode -- see decode_body's own doc comment --
        // which is exactly what every one of these fields was built from in
        // the first place).
        let decoded = decode_body(&encoded.payload).expect("decode_body succeeds");
        assert_eq!(
            decoded, value,
            "decode_body(encode(x)) != x for identity_key={identity_key}"
        );
        // A3b coste 1: the STREAMING serializer (`serialize_payload`, no
        // intermediate `Value`) must produce byte-for-byte the same JSON
        // text `serde_json::to_string(&value)` does -- this is what
        // `RecordBody`'s `Serialize` impl now calls for an `Encoded` body,
        // in place of the old `decode_body` + `value.serialize(...)` round
        // trip.
        let streamed = serde_json::to_string(&PayloadWrapper(&encoded.payload))
            .expect("serialize_payload succeeds");
        let expected = serde_json::to_string(&value).expect("value serializes");
        assert_eq!(
            streamed, expected,
            "serialize_payload(encode(x)) != serde_json::to_string(&x) for identity_key={identity_key}"
        );
    }

    #[test]
    fn encoded_body_matches_value_body_oracle() {
        use FieldValue::{Bool, Int, Null, Object, Real, Str, Uint};

        // 1. `core:references` (semantic_sites.rs::reference_proposed_record).
        assert_body_oracle(
            "relation",
            "jsts:relation_references",
            "core:references",
            "jsts:references:a.ts:1:2:src:tgt",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:variable:a.ts:0:src".into())),
                ("start", Uint(1)),
                ("target_id", Str("jsts:variable:a.ts:0:tgt".into())),
            ],
        );

        // 2. `core:call` confirmed (semantic_sites.rs::call_proposed_record).
        assert_body_oracle(
            "relation",
            "jsts:relation_call",
            "core:call",
            "jsts:call:a.ts:1:2:src:tgt",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:function:a.ts:0:caller".into())),
                ("start", Uint(1)),
                ("target_id", Str("jsts:function:a.ts:0:callee".into())),
            ],
        );

        // 3. `core:inherits` (semantic_sites.rs::heritage_proposed_record).
        assert_body_oracle(
            "relation",
            "jsts:relation_inherits",
            "core:inherits",
            "jsts:inherits:a.ts:1:2:src:tgt",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:class:a.ts:0:Child".into())),
                ("start", Uint(1)),
                ("target_id", Str("jsts:class:a.ts:0:Base".into())),
            ],
        );

        // 4. `core:covers` (semantic_sites.rs::covers_proposed_record).
        assert_body_oracle(
            "relation",
            "jsts:relation_covers",
            "core:covers",
            "jsts:covers:a.ts:1:2:src:tgt",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:function:a.ts:0:testFn".into())),
                ("start", Uint(1)),
                (
                    "target_id",
                    Str("jsts:external_symbol:node:test#test".into()),
                ),
            ],
        );

        // 5. `core:call` possible/candidate, with the extra `reason` field
        // (semantic_sites.rs::candidate_call_record).
        assert_body_oracle(
            "relation",
            "jsts:relation_call",
            "core:call",
            "jsts:call:a.ts:1:2:candidate",
            &[
                ("classification", Str("possible".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("reason", Str("overload_candidate".into())),
                ("source_id", Str("jsts:function:a.ts:0:caller".into())),
                ("start", Uint(1)),
                ("target_id", Str("jsts:function:a.ts:0:overload_1".into())),
            ],
        );

        // 6. `core:contains` WITHOUT a `target_id` (lib.rs::proposal_relation_
        // record's optional-`target_id` branch -- exercises 5 fields, not 6).
        assert_body_oracle(
            "relation",
            "jsts:relation_contains",
            "core:contains",
            "jsts:contains:a.ts:1:2:no-target",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:module:a.ts:0:a".into())),
                ("start", Uint(1)),
            ],
        );

        // 7. Module/plain entity, no optional fields (lib.rs::
        // proposal_entity_record's 6-field base case).
        assert_body_oracle(
            "entity",
            "jsts:entity_container",
            "core:container",
            "jsts:module:a.ts:0:a",
            &[
                ("end", Uint(100)),
                ("kind", Str("module".into())),
                ("language", Str("typescript".into())),
                ("name", Str("a".into())),
                ("path", Str("a.ts".into())),
                ("start", Uint(0)),
            ],
        );

        // 8. Member entity, every optional field present (lib.rs::
        // proposal_entity_record's full 9-field case) -- includes a
        // non-ASCII qualified name.
        assert_body_oracle(
            "entity",
            "jsts:entity_callable",
            "core:callable",
            "jsts:method:a.ts:10:métodó",
            &[
                ("end", Uint(20)),
                ("is_test", Bool(true)),
                ("kind", Str("method".into())),
                ("language", Str("typescript".into())),
                ("name", Str("métodó".into())),
                ("parent_id", Str("jsts:class:a.ts:0:Wídget".into())),
                ("path", Str("a.ts".into())),
                ("qualified_name", Str("a.ts.Wídget.métodó".into())),
                ("start", Uint(10)),
            ],
        );

        // 9. Parameter entity, `parent_id` only (semantic_sites.rs::
        // parameter_entity_record via lib.rs::proposal_entity_record).
        assert_body_oracle(
            "entity",
            "jsts:entity_parameter",
            "core:parameter",
            "jsts:parameter:a.ts:15:value",
            &[
                ("end", Uint(20)),
                ("kind", Str("parameter".into())),
                ("language", Str("typescript".into())),
                ("name", Str("value".into())),
                ("parent_id", Str("jsts:function:a.ts:0:outer".into())),
                ("path", Str("a.ts".into())),
                ("start", Uint(15)),
            ],
        );

        // 10. External symbol entity, fixed `language: "typescript"`
        // (lib.rs::external_symbol_entity via proposal_entity_record) --
        // synthetic zero-span, and a specifier with a non-ASCII byte.
        assert_body_oracle(
            "entity",
            "jsts:entity_container",
            "core:container",
            "jsts:external_symbol:café-pkg#default",
            &[
                ("end", Uint(0)),
                ("kind", Str("external_symbol".into())),
                ("language", Str("typescript".into())),
                ("name", Str("café-pkg#default".into())),
                ("path", Str("external:café-pkg".into())),
                ("start", Uint(0)),
            ],
        );

        // 11. `core:imports` relation WITH a `target_id` (lib.rs::
        // proposal_relation_record's 6-field branch).
        assert_body_oracle(
            "relation",
            "jsts:relation_import",
            "core:imports",
            "jsts:import:a.ts:1:2:import",
            &[
                ("classification", Str("confirmed".into())),
                ("end", Uint(2)),
                ("path", Str("a.ts".into())),
                ("source_id", Str("jsts:module:a.ts:0:a".into())),
                ("start", Uint(1)),
                ("target_id", Str("jsts:external_module:lodash".into())),
            ],
        );

        // 12. `jsts:entity_inferred_type` (residual.rs::
        // build_inferred_type_rows's entity body -- includes the `type`
        // field no other shape here has).
        assert_body_oracle(
            "entity",
            "jsts:entity_inferred_type",
            "core:type",
            "jsts:inferred-type:a.ts:0:x:abc123",
            &[
                ("end", Int(20)),
                ("kind", Str("inferred_type".into())),
                ("language", Str("typescript".into())),
                ("name", Str("inferred type of x".into())),
                ("path", Str("a.ts".into())),
                ("start", Int(10)),
                ("type", Str("string | number".into())),
            ],
        );

        // 13. `jsts:diagnostic` (residual.rs::build_diagnostic_row).
        assert_body_oracle(
            "diagnostic",
            "jsts:diagnostic",
            "core:construct",
            "jsts:diagnostic:a.ts:0:jsts:compiler_diagnostic:0",
            &[
                ("code", Str("jsts:compiler_diagnostic".into())),
                ("compiler_code", Uint(2_322)),
                ("end", Int(10)),
                (
                    "message",
                    Str("Type 'string' is not assignable to type 'number'.".into()),
                ),
                ("path", Str("a.ts".into())),
                ("start", Int(0)),
            ],
        );

        // 14. Synthetic: nested arrays/objects (empty and non-empty),
        // `null`, a large (but exactly-representable) integer, and a
        // fractional `real` value -- no real producer's body nests this
        // deeply, but `BodyEncoder` must still encode/decode it identically
        // to the equivalent `Value` tree, and `structural_kernel_row` must
        // still digest it identically.
        assert_body_oracle(
            "entity",
            "jsts:entity_variable",
            "core:value",
            "jsts:synthetic:nested",
            &[
                ("empty_array", FieldValue::Array(vec![])),
                ("empty_object", Object(vec![])),
                ("large_uint", Uint(123_456_789_012_345)),
                (
                    "nested",
                    Object(vec![
                        ("a", FieldValue::Array(vec![Null, Bool(false), Uint(0)])),
                        ("b", Str("é€🎉".into())),
                    ]),
                ),
                ("ratio", Real(3.5)),
                ("zero", Uint(0)),
            ],
        );
    }

    /// `BodyEncoder::uint` for a value past `i64::MAX` takes the SAME
    /// fallback path `fused_body_pass`'s `Value::Number` arm takes for such
    /// a number (`value.as_i64()` returns `None`, so it falls into the
    /// "real" logical-digest branch) -- verified directly here rather than
    /// folded into the round-trip oracle above, because encoding a number
    /// this large through the `[7] + f64_be` payload format is ALREADY
    /// lossy before this task (the payload has never had a wider numeric
    /// encoding than `f64`, for either path): `decode_body(encode(x)) == x`
    /// does not hold for it, and never could, regardless of which encoder
    /// produced the bytes. What must still hold, and does, is that the
    /// `Value`-bodied and `BodyEncoder`-bodied paths agree on every
    /// resulting byte -- the same information loss, in the same place, for
    /// both.
    #[test]
    fn uint_past_i64_max_matches_value_body_row_for_row() {
        let huge = u64::MAX;
        let value = json!({ "n": huge });
        let mut encoder = BodyEncoder::new();
        encoder.begin_object(1).expect("field count");
        encoder.key("n").expect("only key");
        encoder.uint(huge).expect("uint never fails");
        let encoded = encoder.finish();

        let value_row = structural_kernel_rows_ref(&[record_ref(
            "entity",
            "jsts:entity_variable",
            "core:value",
            "jsts:synthetic:huge-uint",
            BodyRef::Value(&value),
        )])
        .expect("value-bodied kernel call");
        let encoded_row = structural_kernel_rows_ref(&[record_ref(
            "entity",
            "jsts:entity_variable",
            "core:value",
            "jsts:synthetic:huge-uint",
            BodyRef::Encoded(&encoded),
        )])
        .expect("encoded-bodied kernel call");
        assert_eq!(value_row.rows, encoded_row.rows);
    }

    #[test]
    fn key_order_is_enforced_strictly_increasing() {
        let mut encoder = BodyEncoder::new();
        encoder.begin_object(2).expect("field count");
        encoder.key("a").expect("first key always ok");
        encoder.string("x").expect("string never fails");
        encoder.key("b").expect("'b' sorts after 'a'");
        encoder.string("y").expect("string never fails");
        encoder.finish();

        let mut rejected = BodyEncoder::new();
        rejected.begin_object(2).expect("field count");
        rejected.key("b").expect("first key always ok");
        rejected.string("x").expect("string never fails");
        assert!(
            rejected.key("a").is_err(),
            "'a' sorts before 'b': must be rejected"
        );
    }
}

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
