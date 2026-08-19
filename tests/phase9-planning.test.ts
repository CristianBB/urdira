import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactWorkItem,
  IndexCandidate,
  PluginCapabilityDeclaration,
  ProjectionWorkItem,
  RecordArtifactDependency,
} from "@urdira/contracts";
import {
  CandidatePlanner,
  buildCandidateExecutionDag,
  executeCandidateDag,
  type CandidatePlannerInput,
  type CandidatePlanningSeedChange,
  type CandidatePlanningWorkItem,
} from "../packages/engine/src/index.js";

const digest = (value: string): string => `sha256:${value.padEnd(64, "0")}`;

function candidate(overrides: Partial<IndexCandidate> = {}): IndexCandidate {
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
    state: "planning",
    source_observation_batch_ids: ["batch:1"],
    created_at: "2026-08-10T00:00:00.000Z",
    issue_ids: [],
    ...overrides,
  };
}

function seed(referenceId = "artifact:owner", changeKind = "updated"): CandidatePlanningSeedChange {
  return {
    reference_type: "artifact",
    reference_id: referenceId,
    change_kind: changeKind,
    cause_references: [{ cause_type: "artifact", cause_id: referenceId }],
    target_artifact_version_id: `version:${referenceId}`,
  };
}

function dependency(recordId: string, owner: string, dependsOn: string, role = "import"): RecordArtifactDependency {
  return {
    dependency_entry_id: `dependency:${recordId}:${dependsOn}`,
    workspace_id: "workspace:1",
    record_id: recordId,
    owner_artifact_id: owner,
    owner_artifact_version_id: `version:${owner}`,
    dependency_artifact_id: dependsOn,
    dependency_artifact_version_id: `version:${dependsOn}`,
    dependency_role: role,
    producer_id: "plugin:language",
    producer_version: "1.0.0",
    valid_from_generation: 1,
  };
}

const capability: PluginCapabilityDeclaration = {
  plugin_id: "plugin:language",
  plugin_version: "1.0.0",
  capability: "core:definitions",
  capability_contract_version: "1",
  precision: "exact",
  coverage: { language_ids: ["language:test"], artifact_kinds: ["source"], project_context_required: false, excluded_construct_codes: [] },
  limitations: [],
};

function input(overrides: Partial<CandidatePlannerInput> = {}): CandidatePlannerInput {
  return {
    candidate: candidate(),
    frozen_base: {
      snapshot_id: "snapshot:1",
      generation: 7,
      registry_snapshot_id: "registry:base",
      resolution_lock_id: "lock:1",
      configuration_revision_id: "config:base",
      source_state_digest: digest("source"),
      source_observation_batch_ids: ["batch:1"],
      tuple_digest: digest("tuple"),
    },
    seeds: [seed()],
    owned_records: [
      { record_id: "record:owner", record_digest: digest("owner"), workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:artifact:owner", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 },
      { record_id: "record:consumer", record_digest: digest("consumer"), workspace_id: "workspace:1", owner_artifact_id: "artifact:consumer", owner_artifact_version_id: "version:artifact:consumer", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 },
    ],
    owned_projections: [{
      projection_record_id: "projection:owner",
      projection_kind: "core:graph",
      projection_key: "owner",
      owner_artifact_id: "artifact:owner",
      owner_artifact_version_id: "version:artifact:owner",
      content_digest: digest("projection"),
      source_artifact_version_ids: ["version:artifact:owner"],
      source_record_ids: ["record:owner"],
      source_projection_record_ids: [],
      generator: "core:graph",
      generator_version: "1.0.0",
      generator_configuration_digest: digest("generator"),
    }],
    artifact_dependencies: [dependency("record:consumer", "artifact:consumer", "artifact:owner")],
    projection_dependencies: [],
    lookup_dependencies: [],
    lookup_results: [],
    plugin_capabilities: [capability],
    prerequisites: [],
    fallback_authorizations: [],
    target_registry_snapshot_id: "registry:target",
    target_configuration_revision_id: "config:target",
    created_at: "2026-08-10T00:00:01.000Z",
    ...overrides,
  };
}

function lookupInput(options: {
  operation?: "artifact_find" | "artifact_list" | "record_get" | "record_query";
  scope?: "exact_address" | "exact_selector";
  previous?: string;
  current?: string;
  completeness?: "complete" | "policy_limited";
  journaled?: boolean;
  change_kind?: "addition" | "removal" | "mutation" | "none";
  fallback?: "plugin_partition" | "plugin" | "workspace";
}): CandidatePlannerInput {
  const operation = options.operation ?? "record_query";
  return input({
    seeds: [],
    lookup_dependencies: [{
      lookup_dependency_id: "lookup:1",
      workspace_id: "workspace:1",
      consumer_type: "record_set",
      consumer_id: "record-set:empty",
      owner_artifact_id: "artifact:owner",
      owner_artifact_version_id: "version:artifact:owner",
      operation,
      normalized_selector_or_address: "{}",
      selector_digest: digest("selector"),
      previous_result_set_digest: options.previous ?? digest("empty"),
      invalidation_scope: options.scope ?? (operation === "record_query" || operation === "artifact_list" ? "exact_selector" : "exact_address"),
      valid_from_generation: 1,
    }],
    lookup_results: [{
      lookup_dependency_id: "lookup:1",
      current_result_set_digest: options.current ?? digest("changed"),
      completeness: options.completeness ?? "complete",
      journal_covers_membership_dimensions: options.journaled ?? true,
      membership_change_kind: options.change_kind ?? "addition",
    }],
    fallback_authorizations: options.fallback === undefined ? [] : [{ operation, scope: options.fallback }],
  });
}

function artifactWork(id: string, operation: "analyze" | "close" = "analyze"): ArtifactWorkItem {
  return {
    work_item_id: id,
    workspace_id: "workspace:1",
    artifact_id: `artifact:${id}`,
    ...(operation === "analyze" ? { target_artifact_version_id: `version:${id}` } : { target_tombstone_id: `tombstone:${id}` }),
    operation,
    plugin_id: "plugin:language",
    plugin_version: "1.0.0",
    capabilities: ["core:definitions"],
    expected_replacement_scopes: [],
    reason_codes: ["core:dependency_updated"],
    cause_references: [{ cause_type: "artifact", cause_id: `artifact:${id}` }],
    analysis_context_digest: digest(`context-${id}`),
    work_item_digest: digest(`work-${id}`),
  };
}

function projectionWork(id: string, operation: "rebuild" | "close" = "rebuild"): ProjectionWorkItem {
  return {
    projection_work_item_id: id,
    workspace_id: "workspace:1",
    owner_artifact_id: `artifact:${id}`,
    ...(operation === "rebuild" ? { owner_artifact_version_id: `version:${id}` } : { target_tombstone_id: `tombstone:${id}` }),
    projection_kind: "core:graph",
    operation,
    generator: "core:graph",
    generator_version: "1.0.0",
    generator_configuration_digest: digest(`generator-${id}`),
    source_selection: {},
    base_projection_set_digest: digest(`base-${id}`),
    reason_codes: ["core:dependency_updated"],
    cause_references: [{ cause_type: "artifact", cause_id: `artifact:${id}` }],
    work_item_digest: digest(`projection-${id}`),
  };
}

describe("Phase 9 candidate planning", () => {
  it("invalidates owner and transitive dependency consumers with reproducible paths", () => {
    const plan = new CandidatePlanner().plan(input({
      owned_records: [
        ...input().owned_records,
        { record_id: "record:transitive", record_digest: digest("transitive"), workspace_id: "workspace:1", owner_artifact_id: "artifact:transitive", owner_artifact_version_id: "version:artifact:transitive", category: "entity", kind: "test:symbol", universal_kind: "definition", valid_from_generation: 1 },
      ],
      artifact_dependencies: [
        dependency("record:consumer", "artifact:consumer", "artifact:owner"),
        dependency("record:transitive", "artifact:transitive", "artifact:consumer"),
      ],
    }));
    expect(plan.invalidation.affected_artifacts.map((entry) => entry.artifact_id)).toEqual(["artifact:consumer", "artifact:owner", "artifact:transitive"]);
    const consumer = plan.invalidation.affected_records.find((entry) => entry.record_id === "record:consumer");
    expect(consumer?.invalidation_path.map((step) => step.step_type)).toEqual(["seed", "artifact_dependency", "owner"]);
    expect(consumer?.invalidation_path.map((step) => step.ordinal)).toEqual([0, 1, 2]);
  });

  it("orders seeds and equivalent paths deterministically", () => {
    const forward = new CandidatePlanner().plan(input({ seeds: [seed("artifact:z"), seed("artifact:a")], artifact_dependencies: [] }));
    const reverse = new CandidatePlanner().plan(input({ seeds: [seed("artifact:a"), seed("artifact:z")], artifact_dependencies: [] }));
    expect(forward.invalidation.seeds).toEqual(reverse.invalidation.seeds);
    expect(forward.invalidation.contract.plan_digest).toBe(reverse.invalidation.contract.plan_digest);
  });

  it.each([
    ["configuration_revision", "configuration_changed", "config:target"],
    ["registry_snapshot", "registry_changed", "registry:target"],
  ] as const)("conservatively invalidates the workspace for a %s seed", (reference_type, change_kind, reference_id) => {
    const plan = new CandidatePlanner().plan(input({ seeds: [{ reference_type, reference_id, change_kind, cause_references: [{ cause_type: reference_type, cause_id: reference_id }] }] }));
    expect(plan.invalidation.maximum_scope).toBe("workspace");
    expect(plan.invalidation.affected_artifacts.map((entry) => entry.artifact_id)).toEqual(["artifact:consumer", "artifact:owner"]);
  });

  it("invalidates owner projections and projections reached through source records", () => {
    const plan = new CandidatePlanner().plan(input({
      owned_projections: [input().owned_projections[0]!, { ...input().owned_projections[0]!, projection_record_id: "projection:consumer", owner_artifact_id: "artifact:projection-owner", owner_artifact_version_id: "version:artifact:projection-owner", source_record_ids: ["record:consumer"] }],
      projection_dependencies: [{ projection_record_id: "projection:consumer", source_type: "record", source_id: "record:consumer" }],
    }));
    expect(plan.invalidation.affected_projections.map((entry) => entry.projection_record_id)).toEqual(["projection:consumer", "projection:owner"]);
  });

  it("invalidates unchanged empty lookups only when the complete digest changes", () => {
    const same = new CandidatePlanner().plan(lookupInput({ current: digest("empty"), change_kind: "none" }));
    expect(same.lookup_decisions).toEqual([{ lookup_dependency_id: "lookup:1", consumer_id: "record-set:empty", previous_result_set_digest: digest("empty"), current_result_set_digest: digest("empty"), changed: false, selected_scope: "exact_selector" }]);
    expect(same.invalidation.affected_records).toEqual([]);
  });

  it("invalidates an empty lookup when a future member changes its result digest", () => {
    const plan = new CandidatePlanner().plan(lookupInput({}));
    expect(plan.lookup_decisions).toContainEqual(expect.objectContaining({ consumer_id: "record-set:empty", changed: true }));
  });

  it.each(["addition", "removal", "mutation"] as const)("retains an exact address for a journaled %s", (change_kind) => {
    const plan = new CandidatePlanner().plan(lookupInput({ operation: "record_get", scope: "exact_address", change_kind }));
    expect(plan.lookup_decisions[0]).toMatchObject({ changed: true, selected_scope: "exact_address" });
    expect(plan.invalidation.maximum_scope).toBe("targeted");
  });

  it("retains a fully journaled exact selector", () => {
    expect(new CandidatePlanner().plan(lookupInput({ journaled: true })).lookup_decisions[0]?.selected_scope).toBe("exact_selector");
  });

  it.each([
    ["plugin_partition", "plugin"],
    ["plugin", "plugin"],
    ["workspace", "workspace"],
  ] as const)("widens an unprovable selector to its authorized %s scope", (fallback, maximum) => {
    const plan = new CandidatePlanner().plan(lookupInput({ journaled: false, fallback }));
    expect(plan.lookup_decisions[0]?.selected_scope).toBe(fallback);
    expect(plan.invalidation.maximum_scope).toBe(maximum);
    expect(plan.invalidation.contract.fallback_scopes).toEqual([fallback]);
  });

  it("widens policy-limited lookup results even with journal coverage", () => {
    expect(new CandidatePlanner().plan(lookupInput({ completeness: "policy_limited", fallback: "plugin" })).lookup_decisions[0]?.selected_scope).toBe("plugin");
  });

  it("rejects an incomplete lookup plan when no fallback is authorized", () => {
    expect(() => new CandidatePlanner().plan(lookupInput({ journaled: false }))).toThrowError(/core:invalidation_plan_incomplete/u);
  });

  it("builds a complete descriptor-backed plan and frozen manifest", () => {
    const plan = new CandidatePlanner().plan(input());
    expect(plan.invalidation.contract.completeness.overall_status).toBe("complete");
    expect(plan.invalidation.contract.affected_record_set.entry_count).toBe(plan.invalidation.affected_records.length);
    expect(plan.manifest).toMatchObject({ target_registry_snapshot_id: "registry:target", target_configuration_revision_id: "config:target" });
    expect(Object.isFrozen(plan.manifest)).toBe(true);
  });

  it("creates exact per-plugin work and groups that plugin's capabilities", () => {
    const plan = new CandidatePlanner().plan(input({
      artifact_dependencies: [],
      plugin_capabilities: [
        capability,
        { ...capability, capability: "core:references" },
        { ...capability, plugin_id: "plugin:enricher", plugin_version: "2.0.0", capability: "framework:bindings" },
      ],
    }));
    expect(plan.artifact_work_items.map((entry) => [entry.plugin_id, entry.capabilities])).toEqual([
      ["plugin:enricher", ["framework:bindings"]],
      ["plugin:language", ["core:definitions", "core:references"]],
    ]);
  });

  it("allows manifest supersession only while planning", () => {
    const planning = new CandidatePlanner().plan(input({ candidate: candidate({ work_manifest_id: "manifest:old" }) }));
    expect(planning.manifest.supersedes_work_manifest_id).toBe("manifest:old");
    expect(() => new CandidatePlanner().plan(input({ candidate: candidate({ state: "analyzing", work_manifest_id: "manifest:old" }) }))).toThrowError(/replan/u);
  });

  it("rejects target registry, configuration, and frozen-base drift", () => {
    expect(() => new CandidatePlanner().plan(input({ target_registry_snapshot_id: "registry:wrong" }))).toThrowError(/registry/u);
    expect(() => new CandidatePlanner().plan(input({ target_configuration_revision_id: "config:wrong" }))).toThrowError(/configuration/u);
    expect(() => new CandidatePlanner().plan(input({ frozen_base: { ...input().frozen_base, snapshot_id: "snapshot:wrong" } }))).toThrowError(/base/u);
  });

  it("forces a replan when analysis discovers new scope", () => {
    expect(() => new CandidatePlanner().plan(input({ analysis_discovered_scope: true }))).toThrowError(/replan/u);
  });
});

describe("Phase 9 candidate execution DAG", () => {
  it("rejects duplicate work identities", () => {
    expect(() => buildCandidateExecutionDag([artifactWork("work:1"), artifactWork("work:1")], [])).toThrowError(/duplicate/u);
  });

  it("rejects unknown prerequisites", () => {
    expect(() => buildCandidateExecutionDag([artifactWork("work:1")], [{ work_item_id: "work:1", prerequisite_work_item_id: "missing", reason: "plugin_dependency" }])).toThrowError(/unknown prerequisite/u);
  });

  it("rejects a cycle before any work executes", () => {
    expect(() => buildCandidateExecutionDag([artifactWork("work:a"), artifactWork("work:b")], [
      { work_item_id: "work:a", prerequisite_work_item_id: "work:b", reason: "plugin_dependency" },
      { work_item_id: "work:b", prerequisite_work_item_id: "work:a", reason: "capability_input" },
    ])).toThrowError(/cycle/u);
  });

  it("includes staged producers and projection sources as prerequisites", () => {
    const dag = buildCandidateExecutionDag([artifactWork("producer"), artifactWork("consumer"), projectionWork("projection")], [
      { work_item_id: "consumer", prerequisite_work_item_id: "producer", reason: "staged_record_input" },
      { work_item_id: "projection", prerequisite_work_item_id: "consumer", reason: "projection_source" },
    ]);
    expect(dag.levels).toEqual([["producer"], ["consumer"], ["projection"]]);
  });

  it("requires every projection to wait for all artifact work", () => {
    const dag = buildCandidateExecutionDag([projectionWork("projection"), artifactWork("a"), artifactWork("b")], []);
    expect(dag.prerequisites.get("projection")).toEqual(["a", "b"]);
    expect(dag.levels).toEqual([["a", "b"], ["projection"]]);
  });

  it("has stable order and digest for reordered inputs", () => {
    const work = [artifactWork("a"), artifactWork("b")];
    const edge = [{ work_item_id: "b", prerequisite_work_item_id: "a", reason: "plugin_dependency" as const }];
    const first = buildCandidateExecutionDag(work, edge);
    const second = buildCandidateExecutionDag([...work].reverse(), edge);
    expect(second.levels).toEqual(first.levels);
    expect(second.dag_digest).toBe(first.dag_digest);
  });

  it("runs one level concurrently and accepts all results before advancing", async () => {
    const dag = buildCandidateExecutionDag([artifactWork("a"), artifactWork("b"), artifactWork("c")], [
      { work_item_id: "c", prerequisite_work_item_id: "a", reason: "plugin_dependency" },
      { work_item_id: "c", prerequisite_work_item_id: "b", reason: "plugin_dependency" },
    ]);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (work: CandidatePlanningWorkItem) => {
      events.push(`execute:${work.work_item_id}`);
      if (work.work_item_id === "a") await held;
      if (work.work_item_id === "b") release();
      return { work_item_id: work.work_item_id, result_type: "fact_delta" as const, result_digest: digest(work.work_item_id) };
    });
    const accept = vi.fn(async (result: { readonly work_item_id: string }) => { events.push(`accept:${result.work_item_id}`); });
    await executeCandidateDag(dag, execute, accept);
    expect(events.indexOf("execute:c")).toBeGreaterThan(events.indexOf("accept:a"));
    expect(events.indexOf("execute:c")).toBeGreaterThan(events.indexOf("accept:b"));
  });

  it("closes artifact and projection work without invoking a worker", async () => {
    const dag = buildCandidateExecutionDag([artifactWork("artifact-close", "close"), projectionWork("projection-close", "close")], []);
    const execute = vi.fn();
    const accepted = await executeCandidateDag(dag, execute, async () => undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(accepted.map((result) => result.result_type)).toEqual(["closed", "closed"]);
  });
});
