//! Id recipes reproduced from the TypeScript engine (see the evidence doc
//! for the exact source line each one mirrors). Every id below is an opaque
//! `TEXT PRIMARY KEY`/`TEXT` column in `workspace-v3.sql` (no `CHECK`
//! constrains its shape), so this crate is free to compute these however it
//! likes as long as it is deterministic and stable — the recipes below
//! mirror the TS ones anyway, for auditability and so the two
//! implementations could, if ever run side by side, agree.

use crate::digest::{digest_logical_value, stable_id};
use serde_json::json;

/// `sourceProviderArtifactId(workspaceId, normalizedUri)`
/// (`packages/engine/src/source-provider.ts:89`):
/// `digestLogicalValue({ workspace_id, normalized_uri })`.
pub fn artifact_id(workspace_id: &str, normalized_uri: &str) -> String {
    digest_logical_value(&json!({
        "workspace_id": workspace_id,
        "normalized_uri": normalized_uri,
    }))
}

/// `stableId("content", { content_hash, byte_length })`
/// (`packages/engine/src/source-indexer.ts:969`).
pub fn content_blob_id(content_hash: &str, byte_length: u64) -> String {
    stable_id(
        "content",
        &json!({ "content_hash": content_hash, "byte_length": byte_length }),
    )
}

/// `stableId("artifact-version", { artifact_id, observation_id, content_hash })`
/// (`packages/engine/src/source-indexer.ts:971`).
pub fn artifact_version_id(artifact_id: &str, observation_id: &str, content_hash: &str) -> String {
    stable_id(
        "artifact-version",
        &json!({
            "artifact_id": artifact_id,
            "observation_id": observation_id,
            "content_hash": content_hash,
        }),
    )
}

/// `stableId("artifact-tombstone", { artifact_id, batch_id, absence_kind })`
/// (`packages/engine/src/source-indexer.ts:1198`).
pub fn artifact_tombstone_id(artifact_id: &str, batch_id: &str, absence_kind: &str) -> String {
    stable_id(
        "artifact-tombstone",
        &json!({
            "artifact_id": artifact_id,
            "batch_id": batch_id,
            "absence_kind": absence_kind,
        }),
    )
}

/// `stableId("artifact-change", { kind, batch_id, artifact_id })`
/// (`packages/engine/src/source-indexer.ts:990,1196`).
pub fn artifact_change_id(kind: &str, batch_id: &str, artifact_id: &str) -> String {
    stable_id(
        "artifact-change",
        &json!({ "kind": kind, "batch_id": batch_id, "artifact_id": artifact_id }),
    )
}

/// `stableId("source-observation", { batch_id, artifact_id, content_hash, generation })`.
/// Not a literal TS mirror (the TS recipe threads a provider watermark this
/// crate has no equivalent of — see the evidence doc) but the same
/// `stableId` construction, deterministic per `(batch, artifact, content,
/// generation)`.
pub fn source_observation_id(
    batch_id: &str,
    artifact_id: &str,
    observed_content_hash: Option<&str>,
    generation: i64,
) -> String {
    stable_id(
        "source-observation",
        &json!({
            "batch_id": batch_id,
            "artifact_id": artifact_id,
            "observed_content_hash": observed_content_hash,
            "generation": generation,
        }),
    )
}

/// `stableId("observation-batch", { workspace_id, generation, observation_count })`.
/// Not a literal TS mirror (see [`source_observation_id`]'s doc); unique per
/// generation because `generation` alone already is.
pub fn observation_batch_id(workspace_id: &str, generation: i64) -> String {
    stable_id(
        "observation-batch",
        &json!({ "workspace_id": workspace_id, "generation": generation }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_id_matches_ts_vector() {
        assert_eq!(
            artifact_id("workspace:oracle", "src/a.ts"),
            "sha256:65f152147fa04b9ab21ddb1d8a32f08936663863ff0769e46d453cf9673df141"
        );
    }

    #[test]
    fn content_blob_id_matches_ts_vector() {
        let content_hash =
            "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        assert_eq!(
            content_blob_id(content_hash, 20),
            "content:337efbafeebb642f5f5a82712cd90aff5e0267516ac3d313dfbd4f16871a99cf"
        );
    }

    #[test]
    fn artifact_version_id_matches_ts_vector() {
        let content_hash =
            "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        assert_eq!(
            artifact_version_id("abc", "def", content_hash),
            "artifact-version:c962766497757a3a3c64c7d7247e0fae5d5c64ed9231a38f258cb75d927236ea"
        );
    }

    #[test]
    fn ids_are_stable_across_repeated_calls() {
        assert_eq!(
            observation_batch_id("workspace:one", 5),
            observation_batch_id("workspace:one", 5)
        );
        assert_ne!(
            observation_batch_id("workspace:one", 5),
            observation_batch_id("workspace:one", 6)
        );
    }
}
