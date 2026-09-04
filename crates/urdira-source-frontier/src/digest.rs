//! Byte-identical Rust port of `packages/canonical/src/logical-digest-writer.ts`'s
//! `digestLogicalValue`/`LogicalDigestWriter` encoding, and of
//! `packages/engine/src/source-indexer.ts`'s `stableId` helper built on top
//! of it. A second, independent copy of this same encoding already lives in
//! `crates/urdira-indexing-worker/src/main.rs` (`logical_value`/`stable_id`,
//! grep for it) and has been cross-checked against TypeScript in production
//! since v3; this copy is kept local rather than imported because
//! `urdira-indexing-worker`'s copy is a private `fn` in a binary crate, not a
//! library export, and the task boundary for this crate excludes editing
//! that crate to expose it.
//!
//! Every id this crate derives (`artifact_id`, `content_blob_id`,
//! `artifact_version_id`, `artifact_tombstone_id`, batch/observation ids)
//! goes through [`stable_id`] or [`digest_logical_value`] so it reproduces
//! the exact TypeScript recipe at those call sites (see `docs/evidence/
//! 2026-09-02-v4-p2-2a-source-frontier.md` for the line-by-line mapping and
//! the oracle vectors this module's tests assert against).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// Tag bytes from `LogicalDigestWriter`: `null=3, boolean=4, integer=5,
/// real=6, text=7, bytes=8, sequence=9, set=10`. Only the subset actually
/// reachable from a `serde_json::Value` (null, bool, integer-valued number,
/// non-integer number, string, array, object) is implemented; a
/// `serde_json::Value` can never carry raw bytes.
fn write_varint(output: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value % 128) as u8;
        value /= 128;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn write_text(output: &mut Vec<u8>, value: &str) {
    output.push(7);
    write_varint(output, value.len());
    output.extend_from_slice(value.as_bytes());
}

/// Mirrors `LogicalDigestWriter.value()`: numbers that are safe integers
/// (`Number.isSafeInteger`, i.e. `|n| <= 2^53-1` with no fractional part) are
/// encoded as tag 5 + their decimal text (matching `this.integer(value)` ->
/// `this.text(0, String(value))`); everything else uses tag 6 + big-endian
/// f64 bytes (matching `this.real(value)`).
fn write_value(output: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => output.push(3),
        Value::Bool(flag) => {
            output.push(4);
            output.push(u8::from(*flag));
        }
        Value::String(text) => write_text(output, text),
        Value::Number(number) => {
            let as_f64 = number.as_f64().unwrap_or(0.0);
            const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
            if as_f64.is_finite() && as_f64.fract() == 0.0 && as_f64.abs() <= MAX_SAFE_INTEGER {
                output.push(5);
                write_text(output, &format!("{:.0}", as_f64.trunc()));
            } else {
                output.push(6);
                // `Object.is(value, -0)` is rejected by the TS writer for
                // `real()`, but `value()` routes safe integers (including
                // 0/-0) through `integer()` above, so this branch never sees
                // -0 from a `serde_json::Value` produced by this crate.
                output.extend_from_slice(&as_f64.to_be_bytes());
            }
        }
        Value::Array(items) => {
            output.push(9);
            write_varint(output, items.len());
            for item in items {
                write_value(output, item);
            }
        }
        Value::Object(fields) => {
            // TS: `Object.entries(value).sort(([l], [r]) => l.localeCompare(r))`.
            // `String.prototype.localeCompare` without options is
            // locale-sensitive in general, but every key this crate ever
            // hashes is plain ASCII (snake_case field names, hex digests,
            // POSIX-ish URIs), for which `localeCompare` and a byte-wise
            // ordering agree.
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_unstable();
            output.push(10);
            write_varint(output, keys.len());
            for key in keys {
                write_text(output, key);
                // `field(identifier, present, write)`: present is always
                // true here because a `serde_json::Value::Object` entry is
                // never JS `undefined`.
                output.push(4);
                output.push(1);
                write_value(output, fields.get(key).expect("key came from this map"));
            }
        }
    }
}

fn to_prefixed_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(7 + bytes.len() * 2);
    out.push_str("sha256:");
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

/// `digestLogicalValue(value, domain)`. `domain` opens the digest exactly
/// like a leading logical string field (`this.text(0, domain)` in the
/// writer's constructor).
pub fn logical_digest(value: &Value, domain: &str) -> String {
    let mut bytes = Vec::new();
    write_text(&mut bytes, domain);
    write_value(&mut bytes, value);
    to_prefixed_hex(&Sha256::digest(bytes))
}

/// `digestLogicalValue(value)` with the default domain `"urdira:logical-value:v3"`.
pub fn digest_logical_value(value: &Value) -> String {
    logical_digest(value, "urdira:logical-value:v3")
}

/// `stableId(kind, value)`: `${kind}:${digestLogicalValue(value).slice(7)}`.
pub fn stable_id(kind: &str, value: &Value) -> String {
    format!(
        "{kind}:{}",
        digest_logical_value(value)
            .strip_prefix("sha256:")
            .expect("digest_logical_value always returns a sha256:-prefixed digest")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Vectors captured live from the real `packages/canonical` build
    /// (`node --input-type=module -e '...digestLogicalValue(...)'`, Node
    /// 24.18.1) — see the evidence doc for the exact commands. These pin
    /// this port byte-for-byte against the TypeScript encoder, independent
    /// of the file-system oracle in `tests/oracle_directory_provider.rs`.
    #[test]
    fn matches_ts_digest_logical_value_vectors() {
        assert_eq!(
            // sourceProviderArtifactId("workspace:oracle", "src/a.ts")
            digest_logical_value(&json!({
                "workspace_id": "workspace:oracle",
                "normalized_uri": "src/a.ts",
            })),
            "sha256:65f152147fa04b9ab21ddb1d8a32f08936663863ff0769e46d453cf9673df141"
        );

        let boundary_token =
            "sha256:a4ae4652158d769a01bf890b17c208b2f155d1dd13329c5641a15cede31f6304";
        let content_hash =
            "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        assert_eq!(
            digest_logical_value(&json!({
                "boundary_token": boundary_token,
                "content_hash": content_hash,
            })),
            "sha256:64bc33be3f841042332b1bfe4d8d8fde4f541688a95bd7266378cf9294ad1c47"
        );

        assert_eq!(
            stable_id(
                "content",
                &json!({ "content_hash": content_hash, "byte_length": 20 })
            ),
            "content:337efbafeebb642f5f5a82712cd90aff5e0267516ac3d313dfbd4f16871a99cf"
        );

        assert_eq!(
            stable_id(
                "artifact-version",
                &json!({ "artifact_id": "abc", "observation_id": "def", "content_hash": content_hash })
            ),
            "artifact-version:c962766497757a3a3c64c7d7247e0fae5d5c64ed9231a38f258cb75d927236ea"
        );
    }

    #[test]
    fn object_key_order_is_irrelevant() {
        let a = json!({"b": 1, "a": 2, "c": [1, 2, 3]});
        let b = json!({"c": [1, 2, 3], "a": 2, "b": 1});
        assert_eq!(digest_logical_value(&a), digest_logical_value(&b));
    }
}
