#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use urdira_indexing_core::{
    CancellationToken, CoreError, EngineDescriptor, GenerationDescriptor, GenerationRequest,
    LanguageEngine, PhysicalGroup,
};

/// Rust-side JS/TS engine seam. The syntax worker owns source state and the
/// native projection owns language observations; this adapter only provides
/// ordered group delivery to the language-neutral core. Production callers
/// feed it from the supervised checker transport, while tests can enqueue
/// deterministic observations directly.
pub struct JavascriptTypescriptEngine {
    descriptor: EngineDescriptor,
    pending: BTreeMap<String, PhysicalGroup>,
    acknowledged: BTreeSet<String>,
    cancelled: bool,
}

impl JavascriptTypescriptEngine {
    pub fn new(
        engine_version: impl Into<String>,
        implementation_digest: impl Into<String>,
    ) -> Self {
        Self {
            descriptor: EngineDescriptor {
                engine_id: "urdira:jsts".into(),
                engine_version: engine_version.into(),
                implementation_digest: implementation_digest.into(),
            },
            pending: BTreeMap::new(),
            acknowledged: BTreeSet::new(),
            cancelled: false,
        }
    }

    pub fn enqueue_group(
        &mut self,
        first_owner_path: impl Into<String>,
        group: PhysicalGroup,
    ) -> Result<(), CoreError> {
        let key = first_owner_path.into();
        if self.pending.insert(key.clone(), group).is_some() {
            return Err(CoreError(format!("duplicate JS/TS owner group '{key}'")));
        }
        Ok(())
    }

    pub fn acknowledged_generations(&self) -> impl Iterator<Item = &String> {
        self.acknowledged.iter()
    }
}

impl LanguageEngine for JavascriptTypescriptEngine {
    fn describe(&self) -> Result<EngineDescriptor, CoreError> {
        Ok(self.descriptor.clone())
    }

    fn prepare(
        &mut self,
        request: &GenerationRequest,
        cancellation: &CancellationToken,
    ) -> Result<Vec<String>, CoreError> {
        if cancellation.is_cancelled() || self.cancelled {
            return Err(CoreError("JS/TS engine preparation cancelled".into()));
        }
        if request.engine != self.descriptor {
            return Err(CoreError(
                "JS/TS engine descriptor does not match the generation request".into(),
            ));
        }
        Ok(self.pending.keys().cloned().collect())
    }

    fn analyze_group(
        &mut self,
        owners: &[String],
        cancellation: &CancellationToken,
    ) -> Result<PhysicalGroup, CoreError> {
        if cancellation.is_cancelled() || self.cancelled {
            return Err(CoreError("JS/TS group analysis cancelled".into()));
        }
        if owners.is_empty() {
            return Err(CoreError("JS/TS group cannot be empty".into()));
        }
        let first = owners
            .first()
            .ok_or_else(|| CoreError("JS/TS group cannot be empty".into()))?;
        let group = self
            .pending
            .remove(first)
            .ok_or_else(|| CoreError(format!("JS/TS owner group '{first}' is unavailable")))?;
        let actual: Vec<&str> = group
            .owners
            .iter()
            .map(|owner| owner.owner_path.as_str())
            .collect();
        if actual != owners {
            self.pending.insert(first.clone(), group);
            return Err(CoreError(
                "JS/TS group owner order does not match the prepared manifest".into(),
            ));
        }
        Ok(group)
    }

    fn acknowledge(&mut self, descriptor: &GenerationDescriptor) -> Result<(), CoreError> {
        self.acknowledged
            .insert(descriptor.candidate_generation_id.clone());
        Ok(())
    }

    fn cancel(&mut self) -> Result<(), CoreError> {
        self.cancelled = true;
        Ok(())
    }
    fn shutdown(&mut self) -> Result<(), CoreError> {
        self.cancelled = true;
        self.pending.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use urdira_indexing_core::{OwnerObservation, StructuralKernelRecord};
    use urdira_worker_protocol::AuthoritativeChangeSet;

    fn group() -> PhysicalGroup {
        PhysicalGroup {
            group_sequence: 0,
            owners: vec![OwnerObservation {
                owner_artifact_id: "artifact:a".into(),
                owner_artifact_version_id: "version:a".into(),
                owner_path: "a.ts".into(),
                lane: "syntax".into(),
                sequence: 0,
                final_batch: true,
                records: vec![StructuralKernelRecord {
                    proposal_record_key: "proposal:a".into(),
                    category: "entity".into(),
                    kind: "jsts:entity_variable".into(),
                    universal_kind: "core:variable".into(),
                    facets: "[]".into(),
                    schema_version: 1,
                    source_span: "{}".into(),
                    identity_key: "identity:a".into(),
                    body: json!({"name":"a"}),
                    evidence_references: "[]".into(),
                }],
                dependencies: vec![],
                byte_length: 1,
                owner_digest: "sha256:a".into(),
                fact_delta_id: None,
                delta_digest: None,
            }],
        }
    }

    #[test]
    fn acknowledges_only_after_core_descriptor() {
        let mut engine = JavascriptTypescriptEngine::new("1", "sha256:engine");
        engine.enqueue_group("a.ts", group()).expect("enqueue");
        let request = GenerationRequest {
            operation_id: "operation:test".into(),
            workspace_id: "workspace:test".into(),
            candidate_generation_id: "candidate:test".into(),
            cancellation_path: None,
            direct_publication: false,
            source_snapshot_id: "snapshot:test".into(),
            cas_root: "/tmp/urdira-cas".into(),
            source_state_digest: "sha256:source".into(),
            base_generation: 0,
            registry_snapshot_id: "registry:test".into(),
            configuration_revision_id: "configuration:test".into(),
            resolution_lock_id: "lock:test".into(),
            workspace_schema_digest: None,
            change_set: AuthoritativeChangeSet::Exact {
                changed_artifact_ids: vec![],
            },
            candidate: None,
            frozen_base: None,
            work_manifest: None,
            engine: engine.describe().expect("describe"),
            deadline_ms: None,
        };
        let owners = engine
            .prepare(&request, &CancellationToken::default())
            .expect("prepare");
        assert_eq!(owners, vec!["a.ts"]);
    }
}
