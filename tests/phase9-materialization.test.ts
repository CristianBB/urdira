import { describe, expect, it } from "vitest";

import type { CandidateMaterialization, CandidateProjectionTemplate, IndexCandidate, ProjectionWorkItem, ProposedRecord } from "@urdira/contracts";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { canonicalSha256 as pluginCanonicalSha256 } from "@urdira/plugin-sdk";
import { CandidateMaterializer, type CandidateMaterializationInput } from "../packages/engine/src/index.js";

const candidate = (): IndexCandidate => ({ candidate_generation_id: "candidate:materialization", workspace_id: "workspace:1", target_registry_snapshot_id: "registry:target", target_configuration_revision_id: "config:target", trigger_kind: "source_change", state: "ready", source_observation_batch_ids: [], issue_ids: [], created_at: "2026-08-10T00:00:00.000Z" });

const digest = (value: unknown): string => digestBytes(canonicalBytes(value));
const selectorDigest = (operation: string, normalizedSelectorOrAddress: string): string => pluginCanonicalSha256({ operation, normalized_selector_or_address: normalizedSelectorOrAddress });

function record(key: string, body: string): ProposedRecord {
  return { proposal_record_key: `proposal:${key}`, category: "entity", kind: "test:symbol", universal_kind: "definition", facets: "[]", schema_version: 1, source_span: "", identity_key: key, body: { body }, evidence_references: "[]" };
}

function acceptedDelta(records: readonly ProposedRecord[], owner: { readonly owner_artifact_id: string; readonly owner_artifact_version_id: string } = { owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner" }): CandidateMaterializationInput["accepted_deltas"][number] {
  return { delta: { delta_digest: digest(records), fact_delta_id: `delta:${records.length}`, owner_artifact_id: owner.owner_artifact_id, owner_artifact_version_id: owner.owner_artifact_version_id } as never, replacement_sets: [{ scope: { replacement_scope_id: "scope:1", owner_artifact_id: owner.owner_artifact_id, owner_artifact_version_id: owner.owner_artifact_version_id, capability: "core:definitions", record_categories: ["entity"], record_kinds: ["test:symbol"], base_record_set_digest: digest([{ record_id: "record:changed", record_digest: digest("old") }, { record_id: "record:missing", record_digest: digest("missing") }, { record_id: "record:same", record_digest: digest(record("same", "same")) }]), output_completeness: "complete" }, records, record_set_digest: digest(records) }], input_artifact_version_ids: [], input_record_ids: [], transitive_artifact_version_ids: [], validated_staged_records: [], acceptance: "inserted" } as never;
}

function input(overrides: Partial<CandidateMaterializationInput> = {}): CandidateMaterializationInput {
  return { candidate: candidate(), manifest: { work_manifest_id: "manifest:1" } as never, source_plan: { transitions: [], seeds: [], equivalent: true, next_freshness_checkpoint: {} as never }, accepted_deltas: [], accepted_projection_sets: [], base_records: [], base_projections: [], capability_state_entries: [], source_observation_watermarks: [], created_at: "2026-08-10T00:00:00.000Z", known_artifact_versions: [], known_lookup_dependencies: [], ...overrides };
}

describe("Phase 9 generation-neutral candidate materialization", () => {
  it("exposes a truthful generation-neutral CandidateMaterialization runtime shape", () => {
    const materialization: CandidateMaterialization = new CandidateMaterializer().seal(input()).materialization;
    expect(Object.keys(materialization).sort()).toEqual([
      "accepted_fact_delta_digests",
      "artifact_dependency_template_set",
      "candidate_generation_id",
      "candidate_materialization_id",
      "capability_state_entries",
      "identity_assignment_template_set",
      "lookup_dependency_template_set",
      "lookup_revalidation_template_set",
      "materialization_digest",
      "projection_closure_template_sets",
      "projection_open_template_sets",
      "record_closure_template_set",
      "record_open_template_set",
      "source_observation_watermarks",
      "source_transition_template_set",
      "workspace_id",
    ].sort());
    // candidate_generation_id is the one candidate-metadata field that IS part
    // of the sealed payload (it salts materialization identity, see below);
    // everything else about the owning candidate stays absent.
    expect(materialization.candidate_generation_id).toBe(candidate().candidate_generation_id);
    expect(materialization).not.toHaveProperty("base_snapshot_id");
    expect(materialization).not.toHaveProperty("work_manifest_id");
    expect(materialization).not.toHaveProperty("created_at");
  });
  it("seals without generation, publication time, snapshot, or manifest identities", () => {
    const sealed = new CandidateMaterializer().seal(input());
    expect(JSON.stringify(sealed.materialization)).not.toMatch(/valid_from_generation|published_at|snapshot_id|generation_manifest_id/u);
  });

  it("returns immutable templates and a stable materialization digest", () => {
    const sealed = new CandidateMaterializer().seal(input());
    expect(Object.isFrozen(sealed.materialization)).toBe(true);
    expect(sealed.materialization.materialization_digest).toMatch(/^sha256:/u);
  });

  it("reuses identical records and replaces changed or missing authoritative members", () => {
    const same = record("same", "same");
    const changed = record("changed", "new");
    const sealed = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([same, changed])], base_records: [
      { record_id: "record:same", record_digest: digest(same), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity", identity_id: "entity:same", identity_key: "same", valid_from_generation: 1 },
      { record_id: "record:changed", record_digest: digest("old"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity", identity_id: "entity:changed", identity_key: "changed", valid_from_generation: 1 },
      { record_id: "record:missing", record_digest: digest("missing"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity", identity_id: "entity:missing", identity_key: "missing", valid_from_generation: 1 },
    ] }));
    expect(sealed.reused_record_ids).toEqual(["record:same"]);
    expect(sealed.record_closures.map((entry) => entry.record_id)).toEqual(["record:changed", "record:missing"]);
    expect(sealed.record_opens).toHaveLength(1);
  });

  it("allocates a new identity after an absence barrier", () => {
    const sealed = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([record("reappeared", "body")])], absence_barriers: [{ identity_type: "entity", identity_key: "reappeared", closed_identity_id: "entity:closed" }] } as never));
    expect(sealed.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    expect(sealed.identity_assignments[0]?.identity_id).not.toBe("entity:closed");
  });

  it("closes a barriered authoritative record instead of silently reopening it", () => {
    const sealed = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([record("reappeared", "body")])], base_records: [{ record_id: "record:closed", record_digest: digest(record("reappeared", "body")), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity", identity_id: "entity:closed", identity_key: "reappeared", valid_from_generation: 1 }], absence_barriers: [{ identity_type: "entity", identity_key: "reappeared", closed_identity_id: "entity:closed" }] } as never));
    expect(sealed.record_closures.map((entry) => entry.record_id)).toEqual(["record:closed"]);
    expect(sealed.record_opens).toHaveLength(1);
    expect(sealed.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    expect(sealed.identity_assignments[0]?.identity_id).not.toBe("entity:closed");
  });

  it("closes and re-creates an identity that moves outside the replacement-owner scope", () => {
    const moved = record("moved", "same-content");
    const previous = { record_id: "record:owner-a", record_digest: digest(moved), workspace_id: "workspace:1", owner_artifact_id: "artifact:a", owner_artifact_version_id: "version:a", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity" as const, identity_id: "entity:owner-a", identity_key: "moved", valid_from_generation: 1 };
    const next = new CandidateMaterializer().seal(input({
      accepted_deltas: [acceptedDelta([moved], { owner_artifact_id: "artifact:b", owner_artifact_version_id: "version:b" })],
      global_identity_records: [previous],
    }));
    const opened = next.record_opens[0]!;
    const replacementId = next.identity_assignments[0]!.record_id;
    expect(next.reused_record_ids).toEqual([]);
    expect(next.record_closures).toEqual([expect.objectContaining({ record_id: previous.record_id, replacement_record_id: replacementId })]);
    expect(replacementId).toBe(`record:${digest({ record: moved, previous_record_id: previous.record_id }).slice("sha256:".length)}`);
    expect(opened.open_reason_code).toBe("core:record_created");
    expect(next.identity_assignments[0]).toMatchObject({ assignment_kind: "created", identity_type: "entity", owner_artifact_id: "artifact:b", owner_artifact_version_id: "version:b" });
    expect(next.identity_assignments[0]!.identity_id).not.toBe(previous.identity_id);
  });

  it("rejects multiple active exact-key predecessors", () => {
    const moved = record("duplicate", "same-content");
    const predecessor = (recordId: string, identityId: string) => ({ record_id: recordId, record_digest: digest(moved), workspace_id: "workspace:1", owner_artifact_id: recordId, owner_artifact_version_id: `${recordId}:version`, category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity" as const, identity_id: identityId, identity_key: "duplicate", valid_from_generation: 1 });
    expect(() => new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([moved], { owner_artifact_id: "artifact:new", owner_artifact_version_id: "version:new" })], global_identity_records: [predecessor("record:a", "entity:a"), predecessor("record:b", "entity:b")] }))).toThrowError(expect.objectContaining({ code: "core:identity_assignment_conflict" }));
  });

  it("preserves dependency, lookup, and projection source bindings and rejects a projection digest mismatch", () => {
    const projection: CandidateProjectionTemplate = { projection_record_id: "projection:1", projection_kind: "core:graph", projection_key: "key", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner", "version:source"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: { edge: "value" } };
    const projectionWork: ProjectionWorkItem = { projection_work_item_id: "projection-work", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:graph", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("work") };
    const projectionInput = input({ accepted_projection_sets: [{ work_item: projectionWork as never, projections: [projection], projection_set_digest: digest([projection]) }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], record_dependencies: [{ dependency_entry_id: "dependency:1", workspace_id: "workspace:1", record_id: "record:same", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:source", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 }], lookup_bindings: [{ lookup_dependency_id: "lookup:1", workspace_id: "workspace:1", consumer_id: "record:same", consumer_type: "record_set", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: selectorDigest("record_query", "{}"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector", valid_from_generation: 1 }], known_artifact_versions: [{ artifact_id: "artifact:owner", artifact_version_id: "version:owner", content_digest: digest("owner") }, { artifact_id: "artifact:source", artifact_version_id: "version:source", content_digest: digest("source") }], known_dependency_roles: ["references"], known_lookup_dependencies: [{ lookup_dependency_id: "lookup:1", workspace_id: "workspace:1", consumer_type: "record_set", consumer_id: "record:same", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: selectorDigest("record_query", "{}"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector" }] } as never);
    const sealed = new CandidateMaterializer().seal(projectionInput);
    expect(sealed.record_dependencies).toHaveLength(1);
    expect(sealed.lookup_bindings).toHaveLength(1);
    expect(sealed.record_dependencies[0]?.dependency_artifact_version_id).toBe("version:source");
    expect(() => new CandidateMaterializer().seal(input({ accepted_projection_sets: [{ work_item: projectionWork as never, projections: [projection], projection_set_digest: digest("wrong") }] }))).toThrowError(expect.objectContaining({ code: "core:projection_digest_mismatch" }));
  });

  it("rejects dependency bindings when the complete artifact authority is omitted", () => {
    const projection: CandidateProjectionTemplate = { projection_record_id: "projection:authority", projection_kind: "core:graph", projection_key: "authority", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner", "version:source"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: {} };
    const projectionWork: ProjectionWorkItem = { projection_work_item_id: "projection-authority", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:graph", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("work") };
    const dependency = { dependency_entry_id: "dependency:authority", workspace_id: "workspace:1", record_id: "record:same", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:source", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 };
    expect(() => new CandidateMaterializer().seal(input({ accepted_projection_sets: [{ work_item: projectionWork, projections: [projection], projection_set_digest: digest([projection]) }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], record_dependencies: [dependency], known_dependency_roles: ["references"] } as never))).toThrowError(expect.objectContaining({ code: "core:dependency_validation_failed" }));
  });

  it("rejects an artifact authority entry with an invalid content digest", () => {
    expect(() => new CandidateMaterializer().seal(input({ known_artifact_versions: [{ artifact_id: "artifact:source", artifact_version_id: "version:source", content_digest: "not-a-sha256" }], record_dependencies: [{ dependency_entry_id: "dependency:digest", workspace_id: "workspace:1", record_id: "record:same", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:source", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], known_dependency_roles: ["references"] } as never))).toThrowError(expect.objectContaining({ code: "core:dependency_validation_failed" }));
  });

  it("rejects lookup bindings when their complete authority collection is omitted", () => {
    expect(() => new CandidateMaterializer().seal(input({ lookup_bindings: [{ lookup_dependency_id: "lookup:missing-authority", workspace_id: "workspace:1", consumer_type: "record_set", consumer_id: "record:same", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: selectorDigest("record_query", "{}"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector", valid_from_generation: 1 }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }] } as never))).toThrowError(expect.objectContaining({ code: "core:dependency_validation_failed" }));
  });

  it("keeps sealed dependency and lookup digests invariant across validity generations", () => {
    const artifactAuthority = [
      { artifact_id: "artifact:owner", artifact_version_id: "version:owner", content_digest: digest("owner") },
      { artifact_id: "artifact:source", artifact_version_id: "version:source", content_digest: digest("source") },
    ];
    const projection: CandidateProjectionTemplate = { projection_record_id: "projection:generation-neutral", projection_kind: "core:graph", projection_key: "generation-neutral", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner", "version:source"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: {} };
    const projectionWork: ProjectionWorkItem = { projection_work_item_id: "projection-generation-neutral", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:graph", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("work") };
    const dependency = { dependency_entry_id: "dependency:generation-neutral", workspace_id: "workspace:1", record_id: "record:same", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:source", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 };
    const lookup = { lookup_dependency_id: "lookup:generation-neutral", workspace_id: "workspace:1", consumer_type: "record_set", consumer_id: "record:same", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: selectorDigest("record_query", "{}"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector", valid_from_generation: 1 };
    const authority = { lookup_dependency_id: lookup.lookup_dependency_id, workspace_id: lookup.workspace_id, consumer_type: lookup.consumer_type, consumer_id: lookup.consumer_id, operation: lookup.operation, normalized_selector_or_address: lookup.normalized_selector_or_address, selector_digest: lookup.selector_digest, previous_result_set_digest: lookup.previous_result_set_digest, invalidation_scope: lookup.invalidation_scope };
    const common = { accepted_projection_sets: [{ work_item: projectionWork, projections: [projection], projection_set_digest: digest([projection]) }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], known_artifact_versions: artifactAuthority, record_dependencies: [dependency], lookup_bindings: [lookup], known_lookup_dependencies: [authority], known_dependency_roles: ["references"] };
    const first = new CandidateMaterializer().seal(input(common as never));
    const second = new CandidateMaterializer().seal(input({ ...common, record_dependencies: [{ ...dependency, valid_from_generation: 8, valid_to_generation: 9 }], lookup_bindings: [{ ...lookup, valid_from_generation: 8, valid_to_generation: 9 }] } as never));
    expect(second.materialization.materialization_digest).toBe(first.materialization.materialization_digest);
    expect(first.record_dependencies[0]).not.toHaveProperty("valid_from_generation");
    expect(first.lookup_bindings[0]).not.toHaveProperty("valid_from_generation");
  });

  it.each([
    ["consumer_type", { consumer_type: "invalid_consumer" }],
    ["operation", { operation: "invalid_operation" }],
    ["invalidation_scope", { invalidation_scope: "invalid_scope" }],
  ] as const)("rejects lookup authority with an invalid bounded %s", (_field, override) => {
    const lookup = { lookup_dependency_id: "lookup:invalid-union", workspace_id: "workspace:1", consumer_type: "record_set", consumer_id: "record:same", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: selectorDigest("record_query", "{}"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector", valid_from_generation: 1, ...override };
    const authority = { lookup_dependency_id: lookup.lookup_dependency_id, workspace_id: lookup.workspace_id, consumer_type: lookup.consumer_type, consumer_id: lookup.consumer_id, operation: lookup.operation, normalized_selector_or_address: lookup.normalized_selector_or_address, selector_digest: lookup.selector_digest, previous_result_set_digest: lookup.previous_result_set_digest, invalidation_scope: lookup.invalidation_scope };
    expect(() => new CandidateMaterializer().seal(input({ base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], lookup_bindings: [lookup], known_lookup_dependencies: [authority] } as never))).toThrowError(expect.objectContaining({ code: "core:dependency_validation_failed" }));
  });

  it("rejects a lookup selector digest that does not match the SDK binding contract", () => {
    const lookup = { lookup_dependency_id: "lookup:digest-mismatch", workspace_id: "workspace:1", consumer_type: "record_set", consumer_id: "record:same", operation: "record_query", normalized_selector_or_address: "{}", selector_digest: digest("wrong-selector"), previous_result_set_digest: digest("lookup"), invalidation_scope: "exact_selector", valid_from_generation: 1 };
    const authority = { lookup_dependency_id: lookup.lookup_dependency_id, workspace_id: lookup.workspace_id, consumer_type: lookup.consumer_type, consumer_id: lookup.consumer_id, operation: lookup.operation, normalized_selector_or_address: lookup.normalized_selector_or_address, selector_digest: lookup.selector_digest, previous_result_set_digest: lookup.previous_result_set_digest, invalidation_scope: lookup.invalidation_scope };
    expect(() => new CandidateMaterializer().seal(input({ base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], lookup_bindings: [lookup], known_lookup_dependencies: [authority] } as never))).toThrowError(expect.objectContaining({ code: "core:dependency_validation_failed" }));
  });

  it.each([
    ["a mismatched projection kind", { projection_kind: "core:other" }],
    ["a source set without the owner version", { source_artifact_version_ids: ["version:unrelated"] }],
    ["an unrelated source set", { source_record_ids: ["record:unrelated"] }],
  ] as const)("rejects %s at the materializer boundary", (_name, overrides) => {
    const projection: CandidateProjectionTemplate = { projection_record_id: "projection:invalid", projection_kind: "core:graph", projection_key: "key", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:source"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: { edge: "value" }, ...overrides };
    const projectionWork: ProjectionWorkItem = { projection_work_item_id: "projection-invalid", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:graph", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("work") };
    expect(() => new CandidateMaterializer().seal(input({ accepted_projection_sets: [{ work_item: projectionWork, projections: [projection], projection_set_digest: digest([projection]) }] }))).toThrowError(expect.objectContaining({ code: "core:projection_output_invalid" }));
  });

  it("allocates a distinct changed projection occurrence and links closure to its replacement", () => {
    const projection: CandidateProjectionTemplate = { projection_record_id: "projection:base", projection_kind: "core:graph", projection_key: "key", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: { edge: "new" } };
    const projectionWork: ProjectionWorkItem = { projection_work_item_id: "projection-replace", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:graph", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("work") };
    const sealed = new CandidateMaterializer().seal(input({ accepted_projection_sets: [{ work_item: projectionWork, projections: [projection], projection_set_digest: digest([projection]) }], base_records: [{ record_id: "record:same", record_digest: digest("record:same"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 }], known_artifact_versions: [{ artifact_id: "artifact:owner", artifact_version_id: "version:owner", content_digest: digest("owner") }], base_projections: [{ projection_record_id: "projection:base", projection_kind: "core:graph", projection_key: "key", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", content_digest: digest({ ...projection, payload: { edge: "old" } }), source_artifact_version_ids: ["version:owner"], source_record_ids: ["record:same"], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config") }] }));
    const closure = sealed.materialization.projection_closure_template_sets[0];
    const opened = JSON.parse(sealed.materialization.projection_open_template_sets[0]?.projection ?? "{}") as { projection_record_id?: string };
    expect(closure?.projection_record_id).toBe("projection:base");
    expect(closure?.replacement_projection_record_id).toBe(opened.projection_record_id);
    expect(opened.projection_record_id).not.toBe("projection:base");
  });

  it.each([
    ["record dependency with unknown record", { record_dependencies: [{ dependency_entry_id: "dependency:bad", workspace_id: "workspace:1", record_id: "record:unknown", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:owner", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 }] }],
    ["record dependency with wrong owner", { record_dependencies: [{ dependency_entry_id: "dependency:bad", workspace_id: "workspace:1", record_id: "record:same", owner_artifact_id: "artifact:other", owner_artifact_version_id: "version:owner", dependency_artifact_id: "artifact:source", dependency_artifact_version_id: "version:owner", dependency_role: "references", producer_id: "plugin:test", producer_version: "1.0.0", valid_from_generation: 1 }] }],
    ["lookup binding with incomplete shape", { lookup_bindings: [{ lookup_dependency_id: "lookup:bad", result_set_digest: digest("lookup") }] }],
    ["projection dependency with undeclared source", { projection_dependencies: [{ projection_record_id: "projection:1", source_type: "record", source_id: "record:unknown" }] }],
  ] as const)("rejects malformed %s", (_name, overrides) => {
    expect(() => new CandidateMaterializer().seal(input(overrides as never))).toThrow();
  });

  it("keeps equivalent semantic materializations digest-identical across non-salting candidate metadata", () => {
    const first = input();
    const second = input({ candidate: { ...candidate(), base_snapshot_id: "snapshot:other" }, manifest: { work_manifest_id: "manifest:other" } as never, created_at: "2027-01-01T00:00:00.000Z" });
    const firstSealed = new CandidateMaterializer().seal(first);
    const secondSealed = new CandidateMaterializer().seal(second);
    expect(secondSealed.materialization.materialization_digest).toBe(firstSealed.materialization.materialization_digest);
    expect(JSON.stringify(secondSealed.materialization)).not.toMatch(/base_snapshot_id|work_manifest_id|created_at/u);
  });

  // Salting fix: before this, CandidateMaterializer.seal derived identity
  // purely from analysis CONTENT, so an upgrade generation over an unchanged
  // tree reproduced the byte-identical id/digest of the previous candidate's
  // already-published row, colliding with candidate_materializations'
  // UNIQUE (workspace_id, materialization_digest) and its immutable
  // candidate_generation_id column (storage:publication_conflict). Folding
  // candidate_generation_id into the sealed payload makes both identifiers
  // unique per candidate, while a resumed candidate (same
  // candidate_generation_id, replayed) still re-seals byte-stable.
  it("salts materialization identity by the owning candidate: distinct candidates over identical content never collide, a resumed candidate replays byte-stable", () => {
    const first = input();
    const second = input({ candidate: { ...candidate(), candidate_generation_id: "candidate:upgrade-generation" } });
    const firstSealed = new CandidateMaterializer().seal(first);
    const secondSealed = new CandidateMaterializer().seal(second);
    expect(secondSealed.materialization.candidate_generation_id).not.toBe(firstSealed.materialization.candidate_generation_id);
    expect(secondSealed.materialization.candidate_materialization_id).not.toBe(firstSealed.materialization.candidate_materialization_id);
    expect(secondSealed.materialization.materialization_digest).not.toBe(firstSealed.materialization.materialization_digest);

    const firstReplayed = new CandidateMaterializer().seal(input());
    expect(firstReplayed.materialization.candidate_materialization_id).toBe(firstSealed.materialization.candidate_materialization_id);
    expect(firstReplayed.materialization.materialization_digest).toBe(firstSealed.materialization.materialization_digest);
  });

  it("does not make accepted delta operational identities part of the semantic digest", () => {
    const records = [record("semantic", "body")];
    const firstDelta = acceptedDelta(records);
    const secondDelta = { ...firstDelta, delta: { ...firstDelta.delta, delta_digest: digest("another-candidate-generation") } };
    const first = new CandidateMaterializer().seal(input({ accepted_deltas: [firstDelta] }));
    const second = new CandidateMaterializer().seal(input({ accepted_deltas: [secondDelta] }));
    expect(second.materialization.materialization_digest).toBe(first.materialization.materialization_digest);
  });

  // Regression test for a confirmed real-world bug: `CandidateMaterializer.seal()`
  // (`packages/engine/src/candidate-materialization.ts`) used to compute its final
  // `materialization_digest` by canonically encoding the *complete* semantic payload in
  // one call, including `record_open_template_set` -- a single Text field holding the
  // JSON serialization of every newly opened record, each of which embeds its own full
  // `body` (standing in for a real plugin's per-record source `text`, per
  // `packages/plugin-javascript-typescript/src/analyzer.ts`). Confirmed against real
  // excalidraw code: the `packages/math` package alone (26 files) produces ~6,022,461
  // aggregate code points, over `packages/canonical/src/cbor.ts`'s default
  // `max_text_code_points` (4 * 1024 * 1024), which applies per encoded Text field, not
  // just per source file -- and that giant string was also the whole-workspace memory
  // blow-up this phase replaces. Now `record_open_template_set` holds only a small,
  // bounded `OrderedSetDescriptor` (descriptor-as-text) whose `content_digest` is
  // computed incrementally, one record at a time, via `digestCanonicalArray` -- so no
  // *aggregate* text limit is ever hit, only each record's own (default) per-element
  // limit. This synthesizes four records with a 1.5-million-character body each (6
  // million characters -- what used to overflow the default aggregate limit by 50%) and
  // asserts sealing still succeeds under entirely default limits, and that the resulting
  // descriptor's `entry_count`/`content_digest` are exactly what the sealed record-open
  // array actually contains.
  it("materializes a candidate whose aggregate record text exceeds the old default per-field canonical text limit, using only default limits", () => {
    const bigBody = "x".repeat(1_500_000);
    const records = [record("big-0", bigBody), record("big-1", bigBody), record("big-2", bigBody), record("big-3", bigBody)];
    const sealed = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta(records)] }));
    expect(sealed.materialization.materialization_digest).toMatch(/^sha256:/u);
    expect(sealed.record_opens).toHaveLength(4);
    const descriptor = JSON.parse(sealed.materialization.record_open_template_set) as { entry_count: number; content_digest: string; element_type: string };
    expect(descriptor.entry_count).toBe(sealed.record_opens.length);
    expect(descriptor.element_type).toBe("core:CandidateRecordOpenTemplate");
    expect(descriptor.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("yields OrderedSetDescriptor text for every template-set field, with entry_count/content_digest matching the sealed arrays", () => {
    const same = record("same", "same");
    const sealed = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([same])], base_records: [
      { record_id: "record:same", record_digest: digest(same), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity", identity_id: "entity:same", identity_key: "same", valid_from_generation: 1 },
    ] }));
    const fields: readonly [string, readonly unknown[]][] = [
      ["source_transition_template_set", sealed.source_transitions],
      ["record_open_template_set", sealed.record_opens],
      ["record_closure_template_set", sealed.record_closures],
      ["identity_assignment_template_set", sealed.identity_assignments],
      ["artifact_dependency_template_set", sealed.record_dependencies],
      ["lookup_dependency_template_set", sealed.lookup_bindings],
      ["lookup_revalidation_template_set", sealed.lookup_revalidations],
    ];
    for (const [field, entries] of fields) {
      const descriptorText = (sealed.materialization as unknown as Record<string, string>)[field] ?? "";
      const descriptor = JSON.parse(descriptorText) as { entry_count: number; content_digest: string; descriptor_id: string; comparator_id: string; comparator_version: string; element_schema_version: string };
      expect(descriptor.entry_count).toBe(entries.length);
      expect(descriptor.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(descriptor.descriptor_id).toBe(`set:${descriptor.content_digest.slice("sha256:".length)}`);
      expect(descriptor.comparator_id).toBe("core:lexicographic_uri");
      expect(descriptor.comparator_version).toBe("1");
      expect(descriptor.element_schema_version).toBe("1");
    }
  });

  // Decision 05 (content-derived record identity): ProposedRecord carries no
  // workspace_id/owner_artifact_id/owner_artifact_version_id of its own, so
  // two first-opens of byte-identical content mint the byte-identical
  // record_id/record_digest regardless of which workspace or which owner
  // artifact produced them -- the property a future workspace fork depends
  // on (only currently-visible rows get copied; their ids never need
  // recomputing).
  it("mints identical record ids and digests for identical content regardless of workspace or owner (the fork property)", () => {
    const sharedContent = record("shared-across-workspaces", "identical-body");
    const expectedRecordId = `record:${digest(sharedContent).slice("sha256:".length)}`;
    const sealedInWorkspaceOne = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([sharedContent])] }));
    const otherCandidate: IndexCandidate = { ...candidate(), workspace_id: "workspace:completely-different" };
    const sealedInWorkspaceTwo = new CandidateMaterializer().seal(input({
      candidate: otherCandidate,
      accepted_deltas: [acceptedDelta([sharedContent], { owner_artifact_id: "artifact:unrelated-owner", owner_artifact_version_id: "version:unrelated-owner" })],
    }));
    expect(sealedInWorkspaceOne.record_opens).toHaveLength(1);
    expect(sealedInWorkspaceTwo.record_opens).toHaveLength(1);
    // The digest input carried by the open template is byte-identical: no
    // workspace_id or owner ever entered it.
    expect(sealedInWorkspaceOne.record_opens[0]?.record_without_validity).toBe(sealedInWorkspaceTwo.record_opens[0]?.record_without_validity);
    expect(sealedInWorkspaceOne.identity_assignments[0]?.record_id).toBe(expectedRecordId);
    expect(sealedInWorkspaceTwo.identity_assignments[0]?.record_id).toBe(expectedRecordId);
    // The row-column routing (owner ids) still differs correctly per candidate.
    expect(sealedInWorkspaceOne.record_opens[0]).toMatchObject({ owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner" });
    expect(sealedInWorkspaceTwo.record_opens[0]).toMatchObject({ owner_artifact_id: "artifact:unrelated-owner", owner_artifact_version_id: "version:unrelated-owner" });
  });

  // Decision 05's chain-salting rule: an A->B->A content revert must not
  // re-mint the id of its own closed history row. Simulates three
  // successive `seal()` calls under the same identity key -- open A, replace
  // with B, replace back to A -- each one's `base_records` reflecting what
  // the previous seal published, exactly as `workspace-indexing-session.ts`
  // feeds `CandidateMaterializer.seal` from real storage between
  // generations. Asserts three distinct record ids and unbroken identity
  // continuity (one identity_id, chained previous_record_id, "created" then
  // two "continued" assignments).
  it("chain-salts an A->B->A content revert into three distinct record ids with continuous identity", () => {
    const contentA = record("revert", "content-A");
    const contentB = record("revert", "content-B");

    const openA = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([contentA])] }));
    expect(openA.reused_record_ids).toEqual([]);
    expect(openA.record_opens).toHaveLength(1);
    const recordIdA1 = openA.identity_assignments[0]!.record_id;
    const identityId = openA.identity_assignments[0]!.identity_id;
    expect(openA.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    expect(recordIdA1).toBe(`record:${digest(contentA).slice("sha256:".length)}`);

    const baseAfterA = [{ record_id: recordIdA1, record_digest: digest(contentA), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity" as const, identity_id: identityId, identity_key: "revert", valid_from_generation: 1 }];
    const replaceWithB = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([contentB])], base_records: baseAfterA }));
    expect(replaceWithB.reused_record_ids).toEqual([]);
    expect(replaceWithB.record_opens).toHaveLength(1);
    expect(replaceWithB.record_closures.map((entry) => entry.record_id)).toEqual([recordIdA1]);
    const recordIdB = replaceWithB.identity_assignments[0]!.record_id;
    expect(replaceWithB.identity_assignments[0]).toMatchObject({ assignment_kind: "continued", identity_id: identityId, previous_record_id: recordIdA1 });
    // The replacement digest input is salted with the previous record id, so
    // it does not equal a bare content digest of B.
    expect(recordIdB).not.toBe(`record:${digest(contentB).slice("sha256:".length)}`);
    expect(recordIdB).toBe(`record:${digest({ record: contentB, previous_record_id: recordIdA1 }).slice("sha256:".length)}`);

    const baseAfterB = [{ record_id: recordIdB, record_digest: digest(contentB), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", identity_type: "entity" as const, identity_id: identityId, identity_key: "revert", valid_from_generation: 2 }];
    const revertToA = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([contentA])], base_records: baseAfterB }));
    expect(revertToA.reused_record_ids).toEqual([]);
    expect(revertToA.record_opens).toHaveLength(1);
    expect(revertToA.record_closures.map((entry) => entry.record_id)).toEqual([recordIdB]);
    const recordIdA2 = revertToA.identity_assignments[0]!.record_id;
    expect(revertToA.identity_assignments[0]).toMatchObject({ assignment_kind: "continued", identity_id: identityId, previous_record_id: recordIdB });
    expect(recordIdA2).toBe(`record:${digest({ record: contentA, previous_record_id: recordIdB }).slice("sha256:".length)}`);

    // The chain salt is exactly what makes this collision-free: the
    // reverted-to-A occurrence gets its own distinct id, never reusing the
    // original A occurrence's (now-closed) id, even though both opens carry
    // byte-identical content.
    expect(new Set([recordIdA1, recordIdB, recordIdA2]).size).toBe(3);
    // Identity continuity: the same logical entity throughout.
    expect(replaceWithB.identity_assignments[0]?.identity_id).toBe(identityId);
    expect(revertToA.identity_assignments[0]?.identity_id).toBe(identityId);
  });

  // P0 regression: delete-then-restore-identical-content. Unlike the A->B->A
  // revert above, a genuine file deletion CLOSES the record with nothing to
  // replace it, so the identity becomes invisible -- the next scan's
  // `base_records` (built from `currentlyVisibleForOwners`,
  // `packages/storage/src/repositories.ts`) simply does not contain it
  // anymore. Without a produced `absence_barriers` entry for that now-closed
  // identity, `recordTemplates` sees no `previousCandidate` at all (not
  // "unchanged", not "replaced" -- just absent) and takes the untouched
  // first-open branch: a pure content digest, with NO chain salt. If the
  // restored content is byte-identical to what was closed, that pure digest
  // re-mints the EXACT id of the closed history row -- demonstrated by the
  // first assertion below. This is the storage layer's
  // `storage:publication_conflict` root cause (see `publication-authority.ts`'s
  // `assertPublicationImmutableRows`, which finds that id already occupied by
  // a row from an earlier generation and rejects the publish, forever, since
  // the next scan re-derives the identical state). Producing the closed
  // identity as an absence barrier (`closedIdentitiesForOwners`,
  // `packages/storage/src/repositories.ts`, wired at
  // `workspace-indexing-session.ts`'s seal call site) is what makes the
  // restored record diverge instead, asserted second.
  it("re-mints the closed row's exact id on an unbarriered delete-then-restore (demonstrates the bug), and diverges with a produced absence barrier (demonstrates the fix)", () => {
    const content = record("restored", "byte-identical-body");

    // Generation 1: first open.
    const opened = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([content])] }));
    const closedRecordId = opened.identity_assignments[0]!.record_id;
    const closedIdentityId = opened.identity_assignments[0]!.identity_id;
    expect(opened.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    expect(closedRecordId).toBe(`record:${digest(content).slice("sha256:".length)}`);

    // Generation 2: the owning file is deleted -- the record closes with no
    // replacement. Its identity is now invisible, so it contributes nothing
    // to a later seal's `base_records` (mirroring
    // `currentlyVisibleForOwners`'s visibility filter in production).

    // Generation 3: the file is restored with byte-identical content, and
    // the seal is fed NO absence barrier -- reproducing the gap this fix
    // closes (`closedIdentitiesForOwners` not yet wired, or having found
    // nothing).
    const restoredWithoutBarrier = new CandidateMaterializer().seal(input({ accepted_deltas: [acceptedDelta([content])], base_records: [] }));
    const restoredRecordIdWithoutBarrier = restoredWithoutBarrier.identity_assignments[0]!.record_id;
    expect(restoredWithoutBarrier.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    // The bug: an unsalted first-open digest of byte-identical content
    // re-mints the closed row's own id.
    expect(restoredRecordIdWithoutBarrier).toBe(closedRecordId);

    // Generation 3, fixed: the same restore, now fed the produced absence
    // barrier for the closed identity (what `closedIdentitiesForOwners`
    // would have returned).
    const restoredWithBarrier = new CandidateMaterializer().seal(input({
      accepted_deltas: [acceptedDelta([content])],
      base_records: [],
      absence_barriers: [{ identity_type: "entity", identity_key: "restored", closed_identity_id: closedIdentityId }],
    } as never));
    const restoredRecordIdWithBarrier = restoredWithBarrier.identity_assignments[0]!.record_id;
    expect(restoredWithBarrier.identity_assignments[0]).toMatchObject({ assignment_kind: "created" });
    // The fix: salted with the closed identity, the restored occurrence gets
    // its own distinct id, never colliding with the closed history row.
    expect(restoredRecordIdWithBarrier).not.toBe(closedRecordId);
    expect(restoredRecordIdWithBarrier).toBe(`record:${digest({ record: content, absence_barrier: closedIdentityId }).slice("sha256:".length)}`);
  });
});
