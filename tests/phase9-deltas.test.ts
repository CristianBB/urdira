import { describe, expect, it } from "vitest";

import type {
  ArtifactWorkItem,
  BasePluginInputRecordEntry,
  FactDelta,
  IndexCandidate,
  PluginInputAccessManifest,
  ProposedRecord,
  ReplacementScope,
} from "@urdira/contracts";
import { canonicalSha256, pluginInputAccessManifestDigest, pluginInputAccessManifestId, type AutomaticPluginInputAccessManifest } from "@urdira/plugin-sdk";
import {
  FactDeltaAcceptanceService,
  type AcceptedDeltaStore,
  type CandidateTargetRegistry,
  type FactDeltaValidationInput,
} from "../packages/engine/src/index.js";

const digest = (value: unknown): string => canonicalSha256(value);

function candidate(): IndexCandidate {
  return {
    candidate_generation_id: "candidate:1",
    workspace_id: "workspace:1",
    base_snapshot_id: "snapshot:1",
    base_generation: 7,
    base_registry_snapshot_id: "registry:base",
    target_registry_snapshot_id: "registry:target",
    base_configuration_revision_id: "config:base",
    target_configuration_revision_id: "config:target",
    trigger_kind: "source_change",
    state: "analyzing",
    source_observation_batch_ids: ["batch:1"],
    issue_ids: [],
    created_at: "2026-08-10T00:00:00.000Z",
  };
}

function scope(id = "scope:1", overrides: Partial<ReplacementScope> = {}): ReplacementScope {
  return {
    replacement_scope_id: id,
    owner_artifact_id: "artifact:owner",
    owner_artifact_version_id: "version:owner",
    capability: "core:definitions",
    record_categories: ["entity"],
    record_kinds: ["test:symbol"],
    base_record_set_digest: digest([{ record_id: "record:base", record_digest: digest("record") }]),
    output_completeness: "complete",
    ...overrides,
  };
}

function workItem(overrides: Partial<ArtifactWorkItem> = {}): ArtifactWorkItem {
  return {
    work_item_id: "work:1",
    workspace_id: "workspace:1",
    artifact_id: "artifact:owner",
    target_artifact_version_id: "version:owner",
    operation: "analyze",
    plugin_id: "plugin:test",
    plugin_version: "1.0.0",
    capabilities: ["core:definitions"],
    expected_replacement_scopes: [scope()],
    reason_codes: ["core:owner_artifact_updated"],
    cause_references: [{ cause_type: "artifact", cause_id: "artifact:owner" }],
    analysis_context_digest: digest("context"),
    work_item_digest: digest("work"),
    ...overrides,
  };
}

function manifest(overrides: Partial<AutomaticPluginInputAccessManifest> = {}): AutomaticPluginInputAccessManifest {
  const base: Omit<AutomaticPluginInputAccessManifest, "manifest_digest"> = {
    plugin_input_access_manifest_id: pluginInputAccessManifestId("request:1", digest("view")),
    request_id: "request:1",
    analysis_view_digest: digest("view"),
    artifact_version_entries: [{ artifact_id: "artifact:direct", artifact_version_id: "version:direct", content_hash: digest("direct"), access_modes: ["artifact_read"] }],
    record_entries: [{ input_type: "base_record", record_id: "record:base", record_digest: digest("record") }],
    lookup_entries: [],
    transitive_artifact_version_ids: [],
  };
  const value = { ...base, ...overrides };
  const { plugin_input_access_manifest_id: _manifestId, ...digestInput } = value;
  return { ...value, manifest_digest: pluginInputAccessManifestDigest(digestInput) };
}

function proposedRecord(overrides: Partial<ProposedRecord> = {}): ProposedRecord {
  return {
    proposal_record_key: "proposal:1",
    category: "entity",
    kind: "test:symbol",
    universal_kind: "definition",
    facets: "[]",
    schema_version: 1,
    source_span: "",
    identity_key: "symbol:one",
    body: { name: "one" },
    evidence_references: "[]",
    ...overrides,
  };
}

function rawDelta(overrides: Partial<FactDelta> = {}): FactDelta {
  const core: Omit<FactDelta, "fact_delta_id" | "created_at" | "delta_digest"> = {
    candidate_generation_id: "candidate:1",
    workspace_id: "workspace:1",
    base_snapshot_id: "snapshot:1",
    work_item_id: "work:1",
    plugin_id: "plugin:test",
    plugin_version: "1.0.0",
    analysis_digest: digest("analysis"),
    analysis_configuration_digest: digest("configuration"),
    owner_artifact_id: "artifact:owner",
    owner_artifact_version_id: "version:owner",
    replacement_scopes: [scope()],
    input_artifact_version_ids: ["version:direct"],
    input_record_ids: ["record:base"],
    plugin_input_access_manifest_id: manifest().plugin_input_access_manifest_id,
    plugin_input_access_manifest_digest: manifest().manifest_digest,
    analysis_input_digest: digest("analysis-input"),
    proposed_records: [proposedRecord()],
    proposed_dependencies: [],
    completeness_claims: [{ completeness_claim_id: "claim:1", capability: "core:definitions", replacement_scope_ids: "scope:1", status: "complete", reason_codes: "", affected_artifact_ids: "", diagnostic_proposal_keys: "" }],
  };
  const value = { ...core, ...overrides };
  return { ...value, fact_delta_id: "delta:1", created_at: "2026-08-10T00:01:00.000Z", delta_digest: digest(value) };
}

function targetRegistry(): CandidateTargetRegistry {
  return {
    registry_snapshot_id: "registry:target",
    identifiers: new Set(["plugin:test", "core:definitions", "test:symbol", "definition"]),
    dependency_roles: new Set(["references"]),
    record_kinds: new Map([["test:symbol", { kind: "test:symbol", category: "entity", universal_kind: "definition", schema_version: 1, allowed_facets: [] }]]),
  };
}

function input(overrides: Partial<FactDeltaValidationInput> = {}): FactDeltaValidationInput {
  const acceptedManifest = manifest();
  return {
    candidate: candidate(),
    work_item: workItem(),
    raw_delta: rawDelta(),
    accepted_manifest: acceptedManifest,
    expected_replacement_scopes: [scope()],
    target_registry: targetRegistry(),
    base_records: [{ record_id: "record:base", record_digest: digest("record"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }],
    base_record_dependencies: [],
    staged_records: [],
    analysis_context_digest: digest("context"),
    ...overrides,
  };
}

function memoryStore(): AcceptedDeltaStore {
  const values = new Map<string, string>();
  return {
    async get(factDeltaId) {
      const delta_digest = values.get(factDeltaId);
      return delta_digest === undefined ? undefined : { delta_digest };
    },
    async insert(delta) {
      if (values.has(delta.delta.fact_delta_id)) return "already_present";
      values.set(delta.delta.fact_delta_id, delta.delta.delta_digest);
      return "inserted";
    },
    async remove(factDeltaId) {
      values.delete(factDeltaId);
    },
  };
}

describe("Phase 9 FactDelta acceptance", () => {
  it("accepts a registered partial claim only when its diagnostic evidence is source-owned", async () => {
    const partialScope = scope("scope:partial", { record_categories: ["entity", "diagnostic"], record_kinds: ["test:symbol", "test:diagnostic"] });
    const diagnostic = proposedRecord({ proposal_record_key: "diagnostic:1", category: "diagnostic", kind: "test:diagnostic", universal_kind: "core:construct", identity_key: "diagnostic:1", body: { code: "test:partial" } });
    const registry = {
      ...targetRegistry(),
      identifiers: new Set([...targetRegistry().identifiers, "test:diagnostic", "core:construct", "test:partial"]),
      record_kinds: new Map([...targetRegistry().record_kinds, ["test:diagnostic", { kind: "test:diagnostic", category: "diagnostic", universal_kind: "core:construct", schema_version: 1, allowed_facets: [] }]]),
    };
    const claims = [{ completeness_claim_id: "claim:partial", capability: "core:definitions", replacement_scope_ids: "scope:partial", status: "partial", reason_codes: '["test:partial"]', affected_artifact_ids: '["artifact:owner"]', diagnostic_proposal_keys: '["diagnostic:1"]' }];
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ expected_replacement_scopes: [partialScope], work_item: workItem({ expected_replacement_scopes: [partialScope] }), target_registry: registry, raw_delta: rawDelta({ replacement_scopes: [partialScope], proposed_records: [proposedRecord(), diagnostic], completeness_claims: claims }) }))).resolves.toMatchObject({ acceptance: "inserted" });
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ expected_replacement_scopes: [partialScope], work_item: workItem({ expected_replacement_scopes: [partialScope] }), target_registry: registry, raw_delta: rawDelta({ replacement_scopes: [partialScope], proposed_records: [proposedRecord(), diagnostic], completeness_claims: [{ ...claims[0]!, reason_codes: "", affected_artifact_ids: "", diagnostic_proposal_keys: "" }] }) }))).rejects.toMatchObject({ code: "core:replacement_scope_incomplete" });
  });

  it("accepts the contract-optional base snapshot on an initial candidate", async () => {
    const initialCandidate = { ...candidate(), base_snapshot_id: undefined, base_generation: undefined, base_registry_snapshot_id: undefined, base_configuration_revision_id: undefined } as unknown as IndexCandidate;
    const delta = rawDelta();
    const { base_snapshot_id: _baseSnapshotId, ...withoutBase } = delta;
    const { fact_delta_id, created_at, delta_digest: _digest, ...digestInput } = withoutBase;
    const initialDelta = { ...withoutBase, fact_delta_id, created_at, delta_digest: digest(digestInput) };
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ candidate: initialCandidate, raw_delta: initialDelta }))).resolves.toMatchObject({ acceptance: "inserted" });
  });

  it("requires every expected replacement scope exactly once including empty output", async () => {
    const acceptance = new FactDeltaAcceptanceService(memoryStore());
    await expect(acceptance.accept(input({ raw_delta: rawDelta({ replacement_scopes: [] }), expected_replacement_scopes: [scope()] }))).rejects.toMatchObject({ code: "core:required_delta_missing" });
    const accepted = await acceptance.accept(input({ raw_delta: rawDelta({ replacement_scopes: [scope("scope:empty")], proposed_records: [], completeness_claims: [{ completeness_claim_id: "claim:empty", capability: "core:definitions", replacement_scope_ids: "scope:empty", status: "complete", reason_codes: "", affected_artifact_ids: "", diagnostic_proposal_keys: "" }] }), expected_replacement_scopes: [scope("scope:empty")] }));
    expect(accepted.replacement_sets[0]?.records).toEqual([]);
  });

  it("derives direct and transitive inputs from the accepted manifest", async () => {
    const acceptedManifest = manifest({ transitive_artifact_version_ids: ["version:target"] });
    const accepted = await new FactDeltaAcceptanceService(memoryStore()).accept(input({ accepted_manifest: acceptedManifest, raw_delta: rawDelta({ plugin_input_access_manifest_digest: acceptedManifest.manifest_digest }) }));
    expect(accepted.input_artifact_version_ids).toEqual(["version:direct"]);
    expect(accepted.transitive_artifact_version_ids).toEqual(["version:direct", "version:target"]);
  });

  it("rejects id reuse with another digest", async () => {
    const acceptance = new FactDeltaAcceptanceService(memoryStore());
    await acceptance.accept(input());
    await expect(acceptance.accept(input({ raw_delta: rawDelta({ delta_digest: digest("conflict") }) }))).rejects.toMatchObject({ code: "core:delta_id_conflict" });
  });

  it("rejects a proposal outside every authoritative replacement scope", async () => {
    const extra = proposedRecord({ proposal_record_key: "proposal:extra", kind: "test:other_kind" });
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ proposed_records: [proposedRecord(), extra] }) }))).rejects.toMatchObject({ code: "core:delta_scope_mismatch", scope: expect.objectContaining({ proposal_record_key: "proposal:extra" }) });
  });

  it("rejects duplicate replacement scope identities with the FactDelta scope", async () => {
    const duplicate = scope("scope:1");
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ replacement_scopes: [duplicate, duplicate] }) }))).rejects.toMatchObject({ code: "core:delta_scope_mismatch", scope: expect.objectContaining({ scope_type: "fact_delta", fact_delta_id: "delta:1" }) });
  });

  it("rejects an extra replacement scope identity with the FactDelta scope", async () => {
    const extra = scope("scope:extra");
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ replacement_scopes: [scope(), extra] }) }))).rejects.toMatchObject({ code: "core:delta_scope_mismatch", scope: expect.objectContaining({ scope_type: "fact_delta", fact_delta_id: "delta:1", replacement_scope_ids: ["scope:extra"] }) });
  });

  it.each([
    ["candidate_generation_id", "core:delta_scope_mismatch", "candidate_generation_id"],
    ["workspace_id", "core:delta_scope_mismatch", "workspace_id"],
    ["work_item_id", "core:delta_scope_mismatch", "work_item_id"],
    ["plugin_id", "core:delta_scope_mismatch", "plugin_id"],
    ["plugin_version", "core:delta_scope_mismatch", "plugin_version"],
    ["owner_artifact_id", "core:delta_scope_mismatch", "owner_artifact_id"],
    ["owner_artifact_version_id", "core:delta_scope_mismatch", "owner_artifact_version_id"],
  ] as const)("rejects a FactDelta %s identity mismatch with its typed scope", async (field, code, scopeField) => {
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ [field]: "wrong:identity" } as Partial<FactDelta>) }))).rejects.toMatchObject({ code, scope: expect.objectContaining({ scope_type: "fact_delta", fact_delta_id: "delta:1", field: scopeField }) });
  });

  it("rejects a target registry identity mismatch with the FactDelta scope", async () => {
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ target_registry: { ...targetRegistry(), registry_snapshot_id: "registry:wrong" } }))).rejects.toMatchObject({ code: "core:delta_scope_mismatch", scope: expect.objectContaining({ scope_type: "fact_delta", fact_delta_id: "delta:1" }) });
  });

  it("rejects an analysis context mismatch with the FactDelta scope", async () => {
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ analysis_context_digest: digest("context:wrong") }))).rejects.toMatchObject({ code: "core:analysis_context_unavailable", scope: expect.objectContaining({ scope_type: "fact_delta", fact_delta_id: "delta:1" }) });
  });

  it("rejects a replacement scope when its base record-set digest is stale", async () => {
    const stale = scope("scope:1", { base_record_set_digest: digest("stale-base") });
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ expected_replacement_scopes: [stale], raw_delta: rawDelta({ replacement_scopes: [stale] }) }))).rejects.toMatchObject({ code: "core:delta_base_mismatch", scope: expect.objectContaining({ scope_type: "replacement_scope", replacement_scope_id: "scope:1" }) });
  });

  it("rejects staged manifest entries that are not validated producer entries", async () => {
    const stagedManifest = manifest({ record_entries: [
      { input_type: "base_record", record_id: "record:base", record_digest: digest("record") },
      { input_type: "staged_record", staged_record_id: "staged:1", producing_work_item_id: "work:producer", proposal_record_key: "proposal:producer", validated_record_digest: digest("staged") },
    ] });
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ accepted_manifest: stagedManifest, raw_delta: rawDelta({ plugin_input_access_manifest_digest: stagedManifest.manifest_digest }) }))).rejects.toMatchObject({ code: "core:undeclared_input" });
  });

  it("rejects dependencies with an undeclared artifact version or closing base dependency", async () => {
    const dependency = { proposed_dependency_id: "dependency:1", proposal_record_key: "proposal:1", dependency_artifact_id: "artifact:dependency", dependency_artifact_version_id: "version:dependency", dependency_role: "references", dependency_basis: "base", source_reference: {} };
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ proposed_dependencies: [dependency] }) }))).rejects.toMatchObject({ code: "core:dependency_validation_failed", scope: expect.objectContaining({ dependency_artifact_version_id: "version:dependency" }) });
  });

  it("maps a candidate base snapshot mismatch to the base issue scope", async () => {
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ raw_delta: rawDelta({ base_snapshot_id: "snapshot:stale" }) }))).rejects.toMatchObject({ code: "core:delta_base_mismatch", scope: expect.objectContaining({ field: "base_snapshot_id" }) });
  });

  it("requires the canonical empty record-set digest for an empty authoritative scope", async () => {
    const emptyManifest = manifest({ record_entries: [] });
    const emptyScope = scope("scope:empty", { base_record_set_digest: digest([]) });
    const emptyRaw = rawDelta({
      replacement_scopes: [emptyScope],
      input_record_ids: [],
      plugin_input_access_manifest_id: emptyManifest.plugin_input_access_manifest_id,
      plugin_input_access_manifest_digest: emptyManifest.manifest_digest,
      proposed_records: [],
      completeness_claims: [{ completeness_claim_id: "claim:empty", capability: "core:definitions", replacement_scope_ids: "scope:empty", status: "complete", reason_codes: "", affected_artifact_ids: "", diagnostic_proposal_keys: "" }],
    });
    const accepted = await new FactDeltaAcceptanceService(memoryStore()).accept(input({ accepted_manifest: emptyManifest, expected_replacement_scopes: [emptyScope], base_records: [], raw_delta: emptyRaw }));
    expect(accepted.replacement_sets[0]?.records).toEqual([]);
  });

  it("rejects a base dependency whose closure identity or content is inconsistent", async () => {
    const dependency = { dependency_entry_id: "dependency:base", workspace_id: "workspace:1", record_id: "record:base", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:direct", dependency_artifact_version_id: "version:direct", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 };
    const registry = { ...targetRegistry(), dependency_closure: new Map([["version:direct", { dependency_artifact_version_id: "version:direct", dependency_artifact_id: "artifact:wrong", dependency_role: "wrong-role", digest: digest("wrong") }]]), artifact_versions: new Map([["version:direct", { artifact_version_id: "version:direct", artifact_id: "artifact:direct", content_hash: digest("direct") }]]) };
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ target_registry: registry, base_record_dependencies: [dependency] }))).rejects.toMatchObject({ code: "core:dependency_validation_failed" });
  });

  it("rejects an empty structured dependency source reference", async () => {
    const manifestWithClosure = manifest({ transitive_artifact_version_ids: ["version:closure"] });
    const dependency = { proposed_dependency_id: "dependency:1", proposal_record_key: "proposal:1", dependency_artifact_id: "artifact:closure", dependency_artifact_version_id: "version:closure", dependency_role: "references", dependency_basis: "derived", source_reference: {} };
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ accepted_manifest: manifestWithClosure, raw_delta: rawDelta({ plugin_input_access_manifest_digest: manifestWithClosure.manifest_digest, proposed_dependencies: [dependency] }) }))).rejects.toMatchObject({ code: "core:dependency_validation_failed" });
  });

  it("requires the declared accepted-delta adapter to discard late identities", async () => {
    const values = new Map<string, string>();
    const store: AcceptedDeltaStore = {
      async get(factDeltaId) {
        const delta_digest = values.get(factDeltaId);
        return delta_digest === undefined ? undefined : { delta_digest };
      },
      async insert(delta) {
        values.set(delta.delta.fact_delta_id, delta.delta.delta_digest);
        return "inserted";
      },
      async remove(factDeltaId) {
        values.delete(factDeltaId);
      },
    };
    const acceptance = new FactDeltaAcceptanceService(store);
    await acceptance.accept(input());
    await acceptance.discard("delta:1");
    expect(await store.get("delta:1")).toBeUndefined();
  });

  it("rejects an unknown FactDelta source-reference discriminator", async () => {
    const manifestWithClosure = manifest({ transitive_artifact_version_ids: ["version:closure"] });
    const dependency = { proposed_dependency_id: "dependency:1", proposal_record_key: "proposal:1", dependency_artifact_id: "artifact:closure", dependency_artifact_version_id: "version:closure", dependency_role: "references", dependency_basis: "derived", source_reference: { reference_type: "unregistered", proposal_record_key: "proposal:1" } };
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ accepted_manifest: manifestWithClosure, raw_delta: rawDelta({ plugin_input_access_manifest_digest: manifestWithClosure.manifest_digest, proposed_dependencies: [dependency] }) }))).rejects.toMatchObject({ code: "core:dependency_validation_failed", scope: expect.objectContaining({ dependency_failure_kind: "source_reference_type_unknown" }) });
  });

  it("rejects unregistered facets and bodies that violate the registered schema", async () => {
    const registry = { ...targetRegistry(), record_kinds: new Map([["test:symbol", { kind: "test:symbol", category: "entity", universal_kind: "definition", schema_version: 1, allowed_facets: [], body_schema: { type: "object", additionalProperties: false, properties: { name: { type: "string", description: "", required: true } }, required: ["name"] } }]]) } as never;
    const invalidRecord = proposedRecord({ facets: JSON.stringify(["facet:unknown"]), body: { wrong: true } });
    await expect(new FactDeltaAcceptanceService(memoryStore()).accept(input({ target_registry: registry, raw_delta: rawDelta({ proposed_records: [invalidRecord] }) }))).rejects.toMatchObject({ code: "core:record_schema_invalid", scope: expect.objectContaining({ proposal_record_key: "proposal:1" }) });
  });
});
