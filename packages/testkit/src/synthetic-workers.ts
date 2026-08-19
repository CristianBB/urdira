import {
  WorkerProcessCrash,
  canonicalSha256,
  type PluginAnalysisSession,
  type PluginRecordSelector,
  type PluginWorkerCall,
  type PluginWorkerCallEnvelope,
  type PluginWorkerOutcomeEnvelope,
  type WorkerExecutionMetrics,
  type WorkerTransport,
} from "@urdira/plugin-sdk";

export interface SyntheticSessionRequest {
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
  readonly payload: unknown;
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly cancellation_signal: AbortSignal;
}

export interface SyntheticWorkerOptions {
  readonly create_session: (request: SyntheticSessionRequest) => PluginAnalysisSession;
  readonly transport_script?: Readonly<{
    readonly delay_ms?: number;
    readonly response_mode?: "valid" | "malformed" | "invalid_payload";
    readonly crash_workspace_ids?: readonly string[];
  }>;
}

export type SyntheticWorkerStep =
  | { readonly operation: "list_artifacts"; readonly language_id: string }
  | { readonly operation: "read_artifact_uri"; readonly normalized_uri: string }
  | { readonly operation: "read_payload_artifact" }
  | { readonly operation: "query_records"; readonly selector: PluginRecordSelector }
  | { readonly operation: "get_staged_record"; readonly staged_record_id: string };

export interface SyntheticPartition {
  readonly partition_key: string;
  readonly language_ids: readonly string[];
  readonly member_artifact_ids: readonly string[];
  readonly configuration_artifact_ids: readonly string[];
  readonly resolution_roots: readonly string[];
  readonly capabilities: readonly string[];
}

export interface SyntheticDeltaDefinition {
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly capability: string;
  readonly record_kind: string;
  readonly universal_kind: string;
  readonly facets: readonly string[];
  readonly body: Readonly<Record<string, unknown>>;
  readonly dependency?: Readonly<{
    dependency_artifact_id: string;
    dependency_artifact_version_id: string;
    dependency_role: string;
    dependency_basis: string;
  }>;
}

export interface SyntheticProjectionDefinition {
  readonly projection_kind: string;
  readonly steps: readonly SyntheticWorkerStep[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SyntheticWorkerDefinition {
  readonly options: SyntheticWorkerOptions;
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly supported_calls: readonly PluginWorkerCall[];
  readonly discovery_steps: readonly SyntheticWorkerStep[];
  readonly partitions: readonly SyntheticPartition[];
  readonly analysis_steps: readonly SyntheticWorkerStep[];
  readonly delta: SyntheticDeltaDefinition;
  readonly projection?: SyntheticProjectionDefinition;
}

export interface SyntheticPluginWorker extends WorkerTransport {
  readonly worker_kind: "generic_script";
  readonly plugin_id: string;
  readonly plugin_version: string;
  trace(request_id: string): SyntheticWorkerTrace | undefined;
}

export interface SyntheticWorkerTrace {
  readonly plugin_id: string;
  readonly plugin_version: string;
  readonly manifest: Awaited<ReturnType<PluginAnalysisSession["finalize"]>>["manifest"];
  readonly input_artifact_version_ids: readonly string[];
  readonly input_record_ids: readonly string[];
  readonly analysis_input_digest: string;
}

const ZERO_METRICS: WorkerExecutionMetrics = Object.freeze({
  memory_bytes: 0,
  output_bytes: 0,
  records: 0,
  dependencies: 0,
  context_operations: 0,
  context_bytes: 0,
  recursion_depth: 0,
});

function artifactIdFromPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkerProcessCrash("Synthetic artifact payload is invalid.");
  }
  const payloadRecord = payload as Record<string, unknown>;
  const workItem = payloadRecord["work_item"] ?? payloadRecord["projection_work_item"];
  const artifactId = workItem !== null && typeof workItem === "object" && !Array.isArray(workItem)
    ? (workItem as Record<string, unknown>)["artifact_id"] ?? (workItem as Record<string, unknown>)["owner_artifact_id"]
    : undefined;
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new WorkerProcessCrash("Synthetic artifact payload is invalid.");
  }
  return artifactId;
}

async function executeStep(
  session: PluginAnalysisSession,
  step: SyntheticWorkerStep,
  payload: unknown,
): Promise<void> {
  switch (step.operation) {
    case "list_artifacts":
      await session.artifacts.list({ language_id: step.language_id });
      return;
    case "read_artifact_uri": {
      const artifact = await session.artifacts.find(step.normalized_uri);
      if (artifact === undefined) throw new WorkerProcessCrash("Synthetic fixture artifact is unavailable.");
      await session.artifacts.read(artifact.artifact_id);
      return;
    }
    case "read_payload_artifact":
      await session.artifacts.read(artifactIdFromPayload(payload));
      return;
    case "query_records":
      await session.records.query(step.selector);
      return;
    case "get_staged_record": {
      const record = await session.records.get({ record_type: "staged", staged_record_id: step.staged_record_id });
      if (record?.view_type !== "staged") throw new WorkerProcessCrash("Synthetic staged prerequisite is unavailable.");
      return;
    }
  }
}

function workerResult(
  request: PluginWorkerCallEnvelope,
  outcome: PluginWorkerOutcomeEnvelope["outcome"],
  payload: unknown,
): { readonly response: PluginWorkerOutcomeEnvelope; readonly metrics: WorkerExecutionMetrics } {
  return Object.freeze({ response: Object.freeze({
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call: request.call,
    outcome,
    payload,
  }), metrics: ZERO_METRICS });
}

function manifestPayload(finalized: Awaited<ReturnType<PluginAnalysisSession["finalize"]>>) {
  return {
    plugin_input_access_manifest_id: finalized.manifest.plugin_input_access_manifest_id,
    plugin_input_access_manifest_digest: finalized.manifest.manifest_digest,
    analysis_input_digest: finalized.analysis_input_digest,
  };
}

function unsupportedPayload(definition: SyntheticWorkerDefinition, request: PluginWorkerCallEnvelope) {
  return {
    candidate_issue_code: "core:plugin_unsupported",
    retryability: "not_retryable",
    message: "The synthetic fixture does not support this call.",
    details: {
      request_id: request.request_id,
      plugin_id: definition.plugin_id,
      call: request.call,
      capability: "fixture:unsupported",
    },
  };
}

function workspaceIdFromPayload(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkerProcessCrash("Synthetic call payload is invalid.");
  }
  const context = (payload as Record<string, unknown>)["context"];
  const analysisView = context !== null && typeof context === "object" && !Array.isArray(context)
    ? (context as Record<string, unknown>)["analysis_view"]
    : undefined;
  const workspaceId = analysisView !== null && typeof analysisView === "object" && !Array.isArray(analysisView)
    ? (analysisView as Record<string, unknown>)["workspace_id"]
    : undefined;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new WorkerProcessCrash("Synthetic analysis context is invalid.");
  }
  return workspaceId;
}

function artifactWorkItemFromPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkerProcessCrash("Synthetic call payload is invalid.");
  }
  const workItem = (payload as Record<string, unknown>)["work_item"];
  if (workItem === null || typeof workItem !== "object" || Array.isArray(workItem)) {
    throw new WorkerProcessCrash("Synthetic artifact work item is invalid.");
  }
  return workItem as Record<string, unknown>;
}

function projectionWorkItemFromPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WorkerProcessCrash("Synthetic call payload is invalid.");
  }
  const workItem = (payload as Record<string, unknown>)["projection_work_item"];
  if (workItem === null || typeof workItem !== "object" || Array.isArray(workItem)) {
    throw new WorkerProcessCrash("Synthetic projection work item is invalid.");
  }
  return workItem as Record<string, unknown>;
}

function projectionReplacement(
  definition: SyntheticWorkerDefinition,
  request: PluginWorkerCallEnvelope,
  finalized: Awaited<ReturnType<PluginAnalysisSession["finalize"]>>,
) {
  const workItem = projectionWorkItemFromPayload(request.payload);
  const context = (request.payload as Record<string, Record<string, unknown>>)["context"];
  const analysisView = context?.["analysis_view"] as Record<string, unknown> | undefined;
  if (definition.projection === undefined
    || typeof workItem["projection_kind"] !== "string"
    || typeof workItem["owner_artifact_id"] !== "string"
    || typeof workItem["owner_artifact_version_id"] !== "string"
    || typeof workItem["generator_configuration_digest"] !== "string"
    || typeof analysisView?.["base_snapshot_id"] !== "string") {
    throw new WorkerProcessCrash("Synthetic projection work item is invalid.");
  }
  const core = {
    projection_record_id: `projection:${request.request_id}`,
    projection_kind: workItem["projection_kind"],
    projection_key: `${workItem["projection_kind"]}:${workItem["owner_artifact_id"]}`,
    workspace_id: workspaceIdFromPayload(request.payload),
    owner_artifact_id: workItem["owner_artifact_id"],
    owner_artifact_version_id: workItem["owner_artifact_version_id"],
    source_artifact_version_ids: finalized.input_artifact_version_ids,
    source_record_ids: finalized.input_record_ids,
    source_projection_record_ids: [],
    generator: definition.plugin_id,
    generator_version: definition.plugin_version,
    generator_configuration_digest: workItem["generator_configuration_digest"],
    created_from_snapshot_id: analysisView["base_snapshot_id"],
    valid_from_generation: 1,
    payload: definition.projection.payload,
  };
  return Object.freeze({ ...core, content_digest: canonicalSha256(core) });
}

function factDelta(
  definition: SyntheticWorkerDefinition,
  request: PluginWorkerCallEnvelope,
  finalized: Awaited<ReturnType<PluginAnalysisSession["finalize"]>>,
) {
  const delta = definition.delta;
  const workItem = artifactWorkItemFromPayload(request.payload);
  if (typeof workItem["work_item_id"] !== "string") {
    throw new WorkerProcessCrash("Synthetic artifact work item is invalid.");
  }
  const replacementScope = {
    replacement_scope_id: `scope:${request.request_id}`,
    owner_artifact_id: delta.owner_artifact_id,
    owner_artifact_version_id: delta.owner_artifact_version_id,
    capability: delta.capability,
    record_categories: ["entity"],
    record_kinds: [delta.record_kind],
    base_record_set_digest: canonicalSha256("empty-base-record-set"),
    output_completeness: "complete",
  };
  const proposedRecord = {
    proposal_record_key: `record:${request.request_id}`,
    workspace_id: workspaceIdFromPayload(request.payload),
    owner_artifact_id: delta.owner_artifact_id,
    owner_artifact_version_id: delta.owner_artifact_version_id,
    category: "entity",
    kind: delta.record_kind,
    universal_kind: delta.universal_kind,
    facets: [...delta.facets],
    schema_version: 1,
    identity_key: `${delta.record_kind}:${delta.owner_artifact_id}`,
    body: delta.body,
    evidence_references: [],
  };
  const proposedDependencies = delta.dependency === undefined ? [] : [{
    proposed_dependency_id: `dependency:${request.request_id}`,
    proposal_record_key: proposedRecord.proposal_record_key,
    ...delta.dependency,
  }];
  const core = {
    candidate_generation_id: "candidate-conformance",
    workspace_id: workspaceIdFromPayload(request.payload),
    base_snapshot_id: "snapshot-base",
    work_item_id: workItem["work_item_id"],
    plugin_id: definition.plugin_id,
    plugin_version: definition.plugin_version,
    analysis_digest: canonicalSha256({ plugin_id: definition.plugin_id, kind: "fixture-analysis" }),
    analysis_configuration_digest: canonicalSha256({ plugin_id: definition.plugin_id, kind: "fixture-configuration" }),
    owner_artifact_id: delta.owner_artifact_id,
    owner_artifact_version_id: delta.owner_artifact_version_id,
    replacement_scopes: [replacementScope],
    input_artifact_version_ids: finalized.input_artifact_version_ids,
    input_record_ids: finalized.input_record_ids,
    plugin_input_access_manifest_id: finalized.manifest.plugin_input_access_manifest_id,
    plugin_input_access_manifest_digest: finalized.manifest.manifest_digest,
    analysis_input_digest: finalized.analysis_input_digest,
    proposed_records: [proposedRecord],
    proposed_dependencies: proposedDependencies,
    completeness_claims: [{
      completeness_claim_id: `completeness:${request.request_id}`,
      capability: delta.capability,
      replacement_scope_ids: [replacementScope.replacement_scope_id],
      status: "complete",
      reason_codes: [],
      affected_artifact_ids: [],
      diagnostic_proposal_keys: [],
    }],
  };
  return Object.freeze({
    fact_delta_id: `delta:${request.request_id}`,
    ...core,
    created_at: "2026-08-09T00:00:00.000Z",
    delta_digest: canonicalSha256(core),
  });
}

export function createSyntheticWorker(definition: SyntheticWorkerDefinition): SyntheticPluginWorker {
  const controllers = new Map<string, AbortController>();
  const traces = new Map<string, SyntheticWorkerTrace>();
  let terminated = false;

  return Object.freeze({
    worker_kind: "generic_script" as const,
    plugin_id: definition.plugin_id,
    plugin_version: definition.plugin_version,
    async invoke(request: PluginWorkerCallEnvelope): Promise<unknown> {
      if (terminated) throw new WorkerProcessCrash("Synthetic worker is terminated.");
      const transportScript = definition.options.transport_script;
      if (transportScript?.delay_ms !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, transportScript.delay_ms));
      }
      if (request.call !== "describe"
        && transportScript?.crash_workspace_ids?.includes(workspaceIdFromPayload(request.payload)) === true) {
        throw new WorkerProcessCrash("Synthetic scripted worker crash.");
      }
      if (transportScript?.response_mode === "malformed") return "{synthetic-malformed";
      if (!definition.supported_calls.includes(request.call)) {
        return workerResult(request, "unsupported", unsupportedPayload(definition, request));
      }
      if (request.call === "describe") {
        const payload = {
          compatibility_declaration_digest: canonicalSha256({ plugin_id: definition.plugin_id, kind: "compatibility" }),
          registry_contribution_digest: canonicalSha256({ plugin_id: definition.plugin_id, kind: "registry" }),
          supported_calls: [...definition.supported_calls],
        };
        return workerResult(request, "success", transportScript?.response_mode === "invalid_payload"
          ? { ...payload, manifest: { forbidden: true } }
          : payload);
      }
      if (request.call === "generate_projection") {
        const workItem = projectionWorkItemFromPayload(request.payload);
        if (definition.projection === undefined || workItem["projection_kind"] !== definition.projection.projection_kind) {
          return workerResult(request, "unsupported", unsupportedPayload(definition, request));
        }
      }

      const controller = new AbortController();
      controllers.set(request.cancellation_id, controller);
      try {
        const session = definition.options.create_session({
          request_id: request.request_id,
          request_digest: request.request_digest,
          call: request.call,
          payload: request.payload,
          plugin_id: definition.plugin_id,
          plugin_version: definition.plugin_version,
          cancellation_signal: controller.signal,
        });
        const steps = request.call === "discover_partitions"
          ? definition.discovery_steps
          : request.call === "generate_projection"
            ? definition.projection?.steps ?? []
            : definition.analysis_steps;
        await Promise.all(steps.map(async (step) => executeStep(session, step, request.payload)));
        const finalized = await session.finalize({});
        traces.set(request.request_id, Object.freeze({
          plugin_id: definition.plugin_id,
          plugin_version: definition.plugin_version,
          manifest: finalized.manifest,
          input_artifact_version_ids: finalized.input_artifact_version_ids,
          input_record_ids: finalized.input_record_ids,
          analysis_input_digest: finalized.analysis_input_digest,
        }));
        if (request.call === "discover_partitions") {
          return workerResult(request, "success", {
            partitions: definition.partitions,
            ...manifestPayload(finalized),
          });
        }
        if (request.call === "generate_projection") {
          return workerResult(request, "success", {
            projection_replacement_set: [projectionReplacement(definition, request, finalized)],
            ...manifestPayload(finalized),
          });
        }
        return workerResult(request, "success", {
          fact_delta: factDelta(definition, request, finalized),
          ...manifestPayload(finalized),
        });
      } finally {
        controllers.delete(request.cancellation_id);
      }
    },
    trace(request_id: string): SyntheticWorkerTrace | undefined {
      return traces.get(request_id);
    },
    async cancel(input: { readonly cancellation_id: string }): Promise<void> {
      controllers.get(input.cancellation_id)?.abort();
    },
    async reset(): Promise<unknown> {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      return { state_reset: true };
    },
    async terminate(): Promise<void> {
      terminated = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  });
}

export function createTypeScriptShapedWorker(options: SyntheticWorkerOptions): SyntheticPluginWorker {
  return createSyntheticWorker({
    options,
    plugin_id: "fixture:typescript",
    plugin_version: "1.0.0",
    supported_calls: ["describe", "discover_partitions", "analyze_artifact", "generate_projection"],
    discovery_steps: [
      { operation: "read_artifact_uri", normalized_uri: "tsconfig.json" },
      { operation: "list_artifacts", language_id: "languages:typescript" },
      { operation: "query_records", selector: { kind: "fixture:typescript_declaration" } },
    ],
    partitions: [
      {
        partition_key: "project:root",
        language_ids: ["languages:typescript"],
        member_artifact_ids: ["artifact-ts-source"],
        configuration_artifact_ids: ["artifact-tsconfig"],
        resolution_roots: ["src"],
        capabilities: ["core:syntax_structure", "core:symbol_declarations"],
      },
      {
        partition_key: "project:composite",
        language_ids: ["languages:typescript"],
        member_artifact_ids: ["artifact-ts-source"],
        configuration_artifact_ids: ["artifact-tsconfig"],
        resolution_roots: ["src", "types"],
        capabilities: ["core:symbol_resolution"],
      },
    ],
    analysis_steps: [{ operation: "read_payload_artifact" }],
    delta: {
      owner_artifact_id: "artifact-ts-source",
      owner_artifact_version_id: "artifact-ts-source-version",
      capability: "core:symbol_declarations",
      record_kind: "fixture:typescript_export",
      universal_kind: "core:symbol",
      facets: ["fixture:exported"],
      body: { export_name: "answer", declaration_form: "const" },
    },
    projection: {
      projection_kind: "fixture:summary",
      steps: [{ operation: "read_payload_artifact" }],
      payload: { summary: "One exported declaration." },
    },
  });
}

export function createRustShapedWorker(options: SyntheticWorkerOptions): SyntheticPluginWorker {
  return createSyntheticWorker({
    options,
    plugin_id: "fixture:rust",
    plugin_version: "1.0.0",
    supported_calls: ["describe", "discover_partitions", "analyze_artifact"],
    discovery_steps: [
      { operation: "read_artifact_uri", normalized_uri: "Cargo.toml" },
      { operation: "list_artifacts", language_id: "languages:rust" },
    ],
    partitions: [
      {
        partition_key: "crate:fixture",
        language_ids: ["languages:rust"],
        member_artifact_ids: ["artifact-cargo", "artifact-rust-module"],
        configuration_artifact_ids: ["artifact-cargo"],
        resolution_roots: ["src/lib.rs"],
        capabilities: ["core:module_dependencies", "core:syntax_structure"],
      },
      {
        partition_key: "module:fixture",
        language_ids: ["languages:rust"],
        member_artifact_ids: ["artifact-rust-module"],
        configuration_artifact_ids: ["artifact-cargo"],
        resolution_roots: ["src/lib.rs"],
        capabilities: ["core:symbol_declarations"],
      },
    ],
    analysis_steps: [
      { operation: "read_artifact_uri", normalized_uri: "Cargo.toml" },
      { operation: "read_payload_artifact" },
      { operation: "get_staged_record", staged_record_id: "staged-rust-module" },
    ],
    delta: {
      owner_artifact_id: "artifact-rust-module",
      owner_artifact_version_id: "artifact-rust-module-version",
      capability: "core:module_dependencies",
      record_kind: "fixture:rust_macro_expansion",
      universal_kind: "core:module",
      facets: ["fixture:macro_generated", "fixture:crate_member"],
      body: { module_path: "fixture", macro_expansion: true },
      dependency: {
        dependency_artifact_id: "artifact-cargo",
        dependency_artifact_version_id: "artifact-cargo-version",
        dependency_role: "fixture:macro_input",
        dependency_basis: "manifest",
      },
    },
  });
}
