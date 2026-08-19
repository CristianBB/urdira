import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { ArtifactWorkItem, IndexCandidate, ProjectionWorkItem } from "@urdira/contracts";
import { canonicalSha256 } from "@urdira/plugin-sdk";
import { CandidateExecutor, buildCandidateExecutionDag, type AcceptedManifestPersistencePort, type CandidateExecutionInput, type ValidatedStagedRecord } from "../packages/engine/src/index.js";

const digest = (value: unknown): string => canonicalSha256(value);

function candidate(): IndexCandidate {
  return { candidate_generation_id: "candidate:execution", workspace_id: "workspace:1", target_registry_snapshot_id: "registry:target", target_configuration_revision_id: "config:target", trigger_kind: "source_change", state: "analyzing", source_observation_batch_ids: [], issue_ids: [], created_at: "2026-08-10T00:00:00.000Z" };
}

function workItem(id: string, operation: "analyze" | "close" = "analyze"): ArtifactWorkItem {
  return { work_item_id: id, workspace_id: "workspace:1", artifact_id: `artifact:${id}`, ...(operation === "close" ? { target_tombstone_id: `tombstone:${id}` } : { target_artifact_version_id: `version:${id}` }), operation, plugin_id: "plugin:synthetic", plugin_version: "1.0.0", capabilities: ["core:definitions"], expected_replacement_scopes: [], reason_codes: [], cause_references: [], analysis_context_digest: digest(`context:${id}`), work_item_digest: digest(`work:${id}`) };
}

function executionInput(overrides: Partial<CandidateExecutionInput> = {}): CandidateExecutionInput {
  const work = [workItem("a"), workItem("b"), workItem("c")];
  return {
    candidate: candidate(),
    plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: work, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(work, [{ work_item_id: "c", prerequisite_work_item_id: "a", reason: "staged_record_input" }]) },
    context_port: { async open(item, acceptedStagedEntries) { return { work_item_id: item.work_item_id, acceptedStagedEntries } as never; } },
    worker_port: { async execute(item) { const workItemId = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; return { outcome: "success", result_type: "fact_delta", work_item_id: workItemId, validation_input: { raw_delta: { fact_delta_id: `delta:${workItemId}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } }; } },
    acceptance: { async accept(value: unknown) { const workItemId = (value as { raw_delta: { fact_delta_id: string } }).raw_delta.fact_delta_id.replace("delta:", ""); return { delta: { delta_digest: digest(`delta:${workItemId}`) }, validated_staged_records: [{ staged_record_id: `staged:${workItemId}`, producing_work_item_id: workItemId, proposal_record_key: `proposal:${workItemId}`, validated_record_digest: digest(`record:${workItemId}`), transitive_artifact_version_ids: [] }] }; }, async discard() {} } as never,
    cancellation_signal: new AbortController().signal,
    candidate_validation_port: { async validate() {} },
    accepted_manifest_persistence: { async persist() {}, async discard() {} },
    projection_validation_context: { base_artifact_version_ids: ["version:owner"], base_record_ids: [], base_projection_record_ids: [] },
    ...overrides,
  };
}

function projectionWorkItem(id = "projection:1"): ProjectionWorkItem {
  return { projection_work_item_id: id, workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:test", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest(`work:${id}`) };
}

function projectionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { projection_record_id: "projection-record:1", projection_kind: "core:test", projection_key: "key", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner"], source_record_ids: [], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: {}, ...overrides };
}

function projectionExecutionInput(projections: readonly Record<string, unknown>[], overrides: Record<string, unknown> = {}): CandidateExecutionInput {
  const item = projectionWorkItem();
  const output = { outcome: "success", result_type: "projection_set", work_item_id: item.projection_work_item_id, projection_set: { projections, projection_set_digest: digest(projections) } };
  return executionInput({ plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: [], projection_work_items: [item], lookup_decisions: [], dag: buildCandidateExecutionDag([item as never], []) }, worker_port: { async execute() { return output; } }, ...overrides } as never);
}

function typescriptShapedFactDeltaEnvelope(workItemId: string): Record<string, unknown> {
  return { outcome: "success", result_type: "fact_delta", work_item_id: workItemId, validation_input: { raw_delta: { fact_delta_id: `delta:${workItemId}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } };
}

function rustShapedFactDeltaEnvelope(workItemId: string): Record<string, unknown> {
  return { work_item_id: workItemId, result_type: "fact_delta", outcome: "success", validation_input: { raw_delta: { fact_delta_id: `delta:${workItemId}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } };
}

describe("Phase 9 candidate execution", () => {
  it("requires manifest discard in the declared persistence port", () => {
    expectTypeOf<AcceptedManifestPersistencePort>().toMatchTypeOf<{
      persist(record: { fact_delta_id: string; plugin_input_access_manifest_id: string; manifest_digest: string; manifest: unknown }): Promise<void>;
      discard(key: { fact_delta_id: string; plugin_input_access_manifest_id: string; manifest_digest: string }): Promise<void>;
    }>();
  });

  it("overlaps equal-depth work and exposes accepted prerequisites only downstream", async () => {
    const events: string[] = [];
    const input = executionInput({
      context_port: { async open(item, acceptedStagedEntries) { events.push(`open:${item.work_item_id}:${acceptedStagedEntries.map((entry) => entry.staged_record_id).join(",")}`); return { item } as never; } },
      worker_port: { async execute(item) { const workItemId = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; events.push(`run:${workItemId}`); return { outcome: "success", result_type: "fact_delta", work_item_id: workItemId, validation_input: { raw_delta: { fact_delta_id: `delta:${workItemId}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } }; } },
      acceptance: { async accept(value: unknown) { const workItemId = (value as { raw_delta: { fact_delta_id: string } }).raw_delta.fact_delta_id.replace("delta:", ""); events.push(`accept:${workItemId}`); return { delta: { delta_digest: digest(`delta:${workItemId}`) }, validated_staged_records: [{ staged_record_id: `staged:${workItemId}`, producing_work_item_id: workItemId, proposal_record_key: `proposal:${workItemId}`, validated_record_digest: digest(`record:${workItemId}`), transitive_artifact_version_ids: [] }] }; } } as never,
    });
    const results = await new CandidateExecutor().execute(input);
    expect(results.map((entry) => entry.work_item_id)).toEqual(["a", "b", "c"]);
    expect(events.indexOf("run:c")).toBeGreaterThan(events.indexOf("accept:a"));
  });

  it("discards late output after cancellation and does not invoke close workers", async () => {
    const controller = new AbortController();
    const worker = vi.fn(async (item: ArtifactWorkItem) => { controller.abort(); return { kind: "fact_delta", work_item_id: item.work_item_id }; });
    const close = workItem("closed", "close");
    const work = [close];
    const input = executionInput({ cancellation_signal: controller.signal, plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: work, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(work, []) }, worker_port: { execute: worker } });
    const results = await new CandidateExecutor().execute(input);
    expect(worker).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ work_item_id: "closed", result_type: "closed" });
  });

  it("rejects result-shaped worker output unless it carries a validated acceptance input", async () => {
    const input = executionInput({ worker_port: { async execute(item) { return { result_type: "fact_delta", result_digest: digest(item), work_item_id: "a" }; } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code: "core:analyzer_failed", phase: "analysis", scope: expect.objectContaining({ scope_type: "work_item", work_item_type: "artifact" }) });
  });

  it("rejects a success result with fields outside the exact worker shape", async () => {
    const input = executionInput({ worker_port: { async execute(item) {
      return { outcome: "success", result_type: "fact_delta", work_item_id: (item as ArtifactWorkItem).work_item_id, validation_input: {}, result_digest: digest(item) };
    } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code: "core:analyzer_failed", phase: "analysis" });
  });

  it("rejects a projection success shape with fields outside its exact set", async () => {
    const projectionWork = { projection_work_item_id: "projection:1", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", projection_kind: "core:test", operation: "rebuild", generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), source_selection: {}, base_projection_set_digest: digest("base"), reason_codes: [], cause_references: [], work_item_digest: digest("projection-work") } as ProjectionWorkItem;
    const projection = { projection_record_id: "projection-record:1", projection_kind: "core:test", projection_key: "key", workspace_id: "workspace:1", owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner", source_artifact_version_ids: ["version:owner"], source_record_ids: [], source_projection_record_ids: [], generator: "core:test", generator_version: "1.0.0", generator_configuration_digest: digest("config"), payload: {} };
    const input = executionInput({ plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: [], projection_work_items: [projectionWork], lookup_decisions: [], dag: buildCandidateExecutionDag([projectionWork as never], []) }, worker_port: { async execute(item) { return { outcome: "success", result_type: "projection_set", work_item_id: (item as ProjectionWorkItem & { work_item_id: string }).work_item_id, projection_set: { projections: [projection], projection_set_digest: digest([projection]), unexpected: true } }; } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code: "core:projection_output_invalid", phase: "projection" });
  });

  it.each([
    ["duplicate projection IDs", [projectionRecord(), projectionRecord({ projection_key: "other" })]],
    ["duplicate projection keys", [projectionRecord(), projectionRecord({ projection_record_id: "projection-record:2" })]],
    ["undeclared source IDs", [projectionRecord({ source_artifact_version_ids: ["version:undeclared"] })]],
  ] as const)("rejects %s before accepting projection output", async (_name, projections) => {
    await expect(new CandidateExecutor().execute(projectionExecutionInput(projections))).rejects.toMatchObject({ code: "core:projection_output_invalid", scope: expect.objectContaining({ scope_type: "projection" }) });
  });

  it.each([
    ["a mismatched projection kind", projectionRecord({ projection_kind: "core:other" })],
    ["a source set without the owner version", projectionRecord({ source_artifact_version_ids: ["version:unrelated"] })],
  ] as const)("rejects %s at the executor boundary", async (_name, projection) => {
    await expect(new CandidateExecutor().execute(projectionExecutionInput([projection], { projection_validation_context: { base_artifact_version_ids: ["version:owner", "version:unrelated"], base_record_ids: [], base_projection_record_ids: [] } }))).rejects.toMatchObject({ code: "core:projection_output_invalid", phase: "projection" });
  });

  it("runs a whole-candidate validation barrier before any projection worker", async () => {
    const artifact = workItem("artifact-before-projection");
    const projection = projectionWorkItem();
    const events: string[] = [];
    const input = executionInput({
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: [artifact], projection_work_items: [projection], lookup_decisions: [], dag: buildCandidateExecutionDag([artifact, projection as never], []) },
      worker_port: { async execute(item: ArtifactWorkItem | ProjectionWorkItem) { events.push(`worker:${"projection_work_item_id" in item ? "projection" : "artifact"}`); const id = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; return "projection_work_item_id" in item ? { outcome: "success", result_type: "projection_set", work_item_id: id, projection_set: { projections: [projectionRecord()], projection_set_digest: digest([projectionRecord()]) } } : { outcome: "success", result_type: "fact_delta", work_item_id: id, validation_input: { raw_delta: { fact_delta_id: `delta:${id}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } }; } },
      candidate_validation_port: { async validate() { events.push("candidate-validation"); } },
    } as never);
    await new CandidateExecutor().execute(input);
    expect(events).toEqual(["worker:artifact", "candidate-validation", "worker:projection"]);
  });

  it("validates projection sources against accepted staged entries", async () => {
    const artifact = workItem("artifact-before-projection");
    const projection = projectionWorkItem();
    const output = projectionRecord({ source_record_ids: ["staged:artifact-before-projection"] });
    const input = executionInput({
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: [artifact], projection_work_items: [projection], lookup_decisions: [], dag: buildCandidateExecutionDag([artifact, projection as never], []) },
      worker_port: { async execute(item: ArtifactWorkItem | ProjectionWorkItem) { const id = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; return "projection_work_item_id" in item ? { outcome: "success", result_type: "projection_set", work_item_id: id, projection_set: { projections: [output], projection_set_digest: digest([output]) } } : typescriptShapedFactDeltaEnvelope(id); } },
    } as never);
    await expect(new CandidateExecutor().execute(input)).resolves.toHaveLength(2);
  });

  it("passes validated staged entries and persists the accepted manifest before visibility", async () => {
    const events: string[] = [];
    let downstreamEntries: readonly unknown[] = [];
    const input = executionInput({
      context_port: { async open(item: ArtifactWorkItem, entries: readonly ValidatedStagedRecord[]) { if (item.work_item_id === "c") downstreamEntries = entries; events.push(`context:${item.work_item_id}`); return { item } as never; } },
      accepted_manifest_persistence: { async persist() { events.push("manifest"); }, async discard() {} },
      worker_port: { async execute(item: ArtifactWorkItem | ProjectionWorkItem) { const id = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; return { outcome: "success", result_type: "fact_delta", work_item_id: id, validation_input: { raw_delta: { fact_delta_id: `delta:${id}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:1", manifest_digest: digest("manifest") } } }; } },
    } as never);
    await new CandidateExecutor().execute(input);
    expect(downstreamEntries[0]).toMatchObject({ staged_record_id: "staged:a", proposal_record_key: "proposal:a" });
    expect(events.indexOf("manifest")).toBeLessThan(events.indexOf("context:c"));
  });

  it("rolls back accepted output when cancellation arrives after acceptance", async () => {
    const controller = new AbortController();
    const discarded: string[] = [];
    const input = executionInput({ cancellation_signal: controller.signal, accepted_manifest_persistence: { async persist() { throw new Error("late output must not persist"); }, async discard() { discarded.push("unexpected"); } }, acceptance: { async accept(value: unknown) { controller.abort(); const id = (value as { raw_delta: { fact_delta_id: string } }).raw_delta.fact_delta_id; return { delta: { fact_delta_id: id, delta_digest: digest(id) }, validated_staged_records: [{ staged_record_id: "staged:late", producing_work_item_id: "a", proposal_record_key: "proposal:late", validated_record_digest: digest("late"), transitive_artifact_version_ids: [] }], acceptance: "inserted" }; }, async discard() {} } as never });
    await expect(new CandidateExecutor().execute(input)).resolves.toEqual([]);
    expect(discarded).toEqual([]);
  });

  it("discards a persisted manifest when cancellation arrives after persistence", async () => {
    const controller = new AbortController();
    const persisted = new Set<string>();
    const discarded: string[] = [];
    const persistence: AcceptedManifestPersistencePort = {
      async persist(record) {
        persisted.add(record.plugin_input_access_manifest_id);
        controller.abort();
      },
      async discard(key) {
        discarded.push(key.plugin_input_access_manifest_id);
        persisted.delete(key.plugin_input_access_manifest_id);
      },
    };
    const work = [workItem("a")];
    const input = executionInput({ cancellation_signal: controller.signal, accepted_manifest_persistence: persistence, acceptance: { async accept(value: unknown) { const id = (value as { raw_delta: { fact_delta_id: string } }).raw_delta.fact_delta_id; return { delta: { fact_delta_id: id, delta_digest: digest(id) }, validated_staged_records: [{ staged_record_id: "staged:a", producing_work_item_id: "a", proposal_record_key: "proposal:a", validated_record_digest: digest("a"), transitive_artifact_version_ids: [] }] }; }, async discard() {} }, plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: work, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(work, []) } } as never);
    await expect(new CandidateExecutor().execute(input)).resolves.toEqual([]);
    expect(discarded).toEqual(["manifest:synthetic"]);
    expect(persisted).toEqual(new Set());
  });

  it("discards only the manifest associated with the cancelled accepted delta", async () => {
    const persisted = new Map<string, { fact_delta_id: string; manifest_digest: string }>();
    const discarded: string[] = [];
    const persistence: AcceptedManifestPersistencePort = {
      async persist(record) {
        persisted.set(record.plugin_input_access_manifest_id, { fact_delta_id: record.fact_delta_id, manifest_digest: record.manifest_digest });
        if (record.fact_delta_id === "delta:b") controller.abort();
      },
      async discard(key) {
        discarded.push(key.plugin_input_access_manifest_id);
        persisted.delete(key.plugin_input_access_manifest_id);
      },
    };
    const firstWork = [workItem("a")];
    await new CandidateExecutor().execute(executionInput({
      accepted_manifest_persistence: persistence,
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: firstWork, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(firstWork, []) },
      worker_port: { async execute(item: ArtifactWorkItem) {
        const envelope = typescriptShapedFactDeltaEnvelope((item as ArtifactWorkItem).work_item_id);
        const acceptedManifest = (envelope["validation_input"] as { accepted_manifest: { plugin_input_access_manifest_id: string; manifest_digest: string } }).accepted_manifest;
        acceptedManifest.plugin_input_access_manifest_id = "manifest:a";
        acceptedManifest.manifest_digest = digest("manifest:a");
        return envelope;
      } } as never,
    }));
    const controller = new AbortController();
    const secondWork = [workItem("b")];
    await expect(new CandidateExecutor().execute(executionInput({
      cancellation_signal: controller.signal,
      accepted_manifest_persistence: persistence,
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: secondWork, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(secondWork, []) },
      worker_port: { async execute(item: ArtifactWorkItem) {
        const envelope = typescriptShapedFactDeltaEnvelope((item as ArtifactWorkItem).work_item_id);
        const acceptedManifest = (envelope["validation_input"] as { accepted_manifest: { plugin_input_access_manifest_id: string; manifest_digest: string } }).accepted_manifest;
        acceptedManifest.plugin_input_access_manifest_id = "manifest:b";
        acceptedManifest.manifest_digest = digest("manifest:b");
        return envelope;
      } } as never,
    }))).resolves.toEqual([]);
    expect(discarded).toEqual(["manifest:b"]);
    expect(persisted).toEqual(new Map([["manifest:a", { fact_delta_id: "delta:a", manifest_digest: digest("manifest:a") }]]));
  });

  it("attempts manifest rollback even when accepted-delta rollback fails", async () => {
    const controller = new AbortController();
    const discarded: string[] = [];
    const work = [workItem("a")];
    const input = executionInput({
      cancellation_signal: controller.signal,
      accepted_manifest_persistence: { async persist() { controller.abort(); }, async discard(_key: { plugin_input_access_manifest_id: string }) { discarded.push("manifest:synthetic"); } },
      acceptance: { async accept(value: unknown) { const id = (value as { raw_delta: { fact_delta_id: string } }).raw_delta.fact_delta_id; return { delta: { fact_delta_id: id, delta_digest: digest(id) }, validated_staged_records: [{ staged_record_id: "staged:a", producing_work_item_id: "a", proposal_record_key: "proposal:a", validated_record_digest: digest("a"), transitive_artifact_version_ids: [] }] }; }, async discard() { throw new Error("delta rollback failed"); } },
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: work, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(work, []) },
    } as never);
    await expect(new CandidateExecutor().execute(input)).rejects.toThrow("delta rollback failed");
    expect(discarded).toEqual(["manifest:synthetic"]);
  });

  it.each(["typescript-shaped", "rust-shaped"] as const)("accepts the explicit %s worker envelope only through validation", async (shape) => {
    const input = executionInput({ worker_port: { async execute(item) { const id = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; return shape === "typescript-shaped" ? typescriptShapedFactDeltaEnvelope(id) : rustShapedFactDeltaEnvelope(id); } } });
    await expect(new CandidateExecutor().execute(input)).resolves.toHaveLength(3);
  });

  it("maps closed worker failures to their exact analysis phase and issue code", async () => {
    const input = executionInput({ worker_port: { async execute() { return { outcome: "failed", failure_code: "synthetic-failure" }; } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code: "core:analyzer_failed", phase: "analysis" });
  });

  it.each([
    ["inputs_incomplete", "core:plugin_inputs_incomplete"],
    ["unsupported", "core:plugin_unsupported"],
    ["cancelled", "core:plugin_cancelled"],
    ["resource_exhausted", "core:plugin_resource_exhausted"],
  ] as const)("maps %s to its exact analysis issue code", async (outcome, code) => {
    const input = executionInput({ worker_port: { async execute() { return { outcome }; } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code, phase: "analysis" });
  });

  it.each([
    ["failed", "core:projection_generator_failed"],
    ["inputs_incomplete", "core:plugin_inputs_incomplete"],
    ["unsupported", "core:plugin_unsupported"],
    ["cancelled", "core:plugin_cancelled"],
    ["resource_exhausted", "core:plugin_resource_exhausted"],
    ["unknown", "core:projection_output_invalid"],
  ] as const)("maps projection closed outcome %s to its exact phase and issue code", async (outcome, code) => {
    const input = projectionExecutionInput([], { worker_port: { async execute() { return { outcome }; } } });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code, phase: "projection", scope: expect.objectContaining({ scope_type: "projection", projection_work_item_id: "projection:1" }) });
  });

  it("discards a late analysis result after cancellation", async () => {
    const controller = new AbortController();
    const input = executionInput({ cancellation_signal: controller.signal, worker_port: { async execute(item) {
      controller.abort();
      return { outcome: "success", result_type: "fact_delta", work_item_id: (item as ArtifactWorkItem).work_item_id, validation_input: {} };
    } } });
    await expect(new CandidateExecutor().execute(input)).resolves.toEqual([]);
  });

  it("does not start a downstream worker when a prerequisite has no visible staged acceptance", async () => {
    const work = [workItem("producer"), workItem("consumer")];
    const runs: string[] = [];
    const input = executionInput({
      plan: { invalidation: {} as never, manifest: {} as never, artifact_work_items: work, projection_work_items: [], lookup_decisions: [], dag: buildCandidateExecutionDag(work, [{ work_item_id: "consumer", prerequisite_work_item_id: "producer", reason: "staged_record_input" }]) },
      worker_port: { async execute(item) { const workItemId = "work_item_id" in item ? item.work_item_id : item.projection_work_item_id; runs.push(workItemId); return { outcome: "success", result_type: "fact_delta", work_item_id: workItemId, validation_input: { raw_delta: { fact_delta_id: `delta:${workItemId}` }, accepted_manifest: { plugin_input_access_manifest_id: "manifest:synthetic", manifest_digest: digest("manifest:synthetic") } } }; } },
      acceptance: { async accept() { return { delta: { delta_digest: digest("producer") }, validated_staged_records: [] }; } } as never,
    });
    await expect(new CandidateExecutor().execute(input)).rejects.toMatchObject({ code: "core:plugin_inputs_incomplete" });
    expect(runs).toEqual(["producer"]);
  });
});
