import { describe, expect, it } from "vitest";
import type { QueryExpression, QueryRequest, QueryScope } from "@urdira/contracts";
import { CanonicalRecordQueryDataPort, CursorCache, QueryEngine, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem } from "../packages/engine/src/index.js";
import { executePipeline } from "../packages/engine/src/pipeline-executor.js";
import { stageSetHandle } from "../packages/engine/src/stage-set-handle.js";
import { PIPELINE_EXAMPLE_RESOLVE_REFERENCES_TO_SOURCE, PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES, PIPELINE_EXAMPLE_SEARCH_TO_SOURCE } from "../packages/mcp/src/index.js";
import { buildTaskPlannerWorkspace } from "./support/task-planner-workspace.js";

/**
 * Real pipeline composition coverage: `QueryEngine.evaluate`'s pipeline
 * branch used to forward every `source.operation`/`expand.operation`
 * stage's `operation_arguments` to `evaluateOperation` VERBATIM, so the
 * `stage_output` `SubjectSelector` variant that lets a caller bind an
 * earlier stage's output into a later stage's arguments was resolved
 * nowhere -- a pipeline like `search_text -> get_source(stage_output(...))`
 * silently produced empty results. These tests drive the REAL
 * `QueryEngine`/pipeline-executor dispatch (model: `phase11-recipe-executor.test.ts`'s
 * scriptable `FakeDataPort` harness) plus, for the two examples now
 * documented in `MCP_SERVER_INSTRUCTIONS`, the REAL task-planner fixture
 * workspace (model: `tests/support/task-planner-workspace.ts`) so "works"
 * means "verified against a live workspace", not just a mock.
 */

function scope(workspaceId: string): QueryScope {
  return { scope_type: "single_workspace", workspace_id: workspaceId };
}

const options = {
  freshness: "current" as const,
  wait_timeout_ms: 0,
  coverage_requirement: "accept_reported" as const,
  evidence: { evidence: "summary" as const, evidence_chain_depth: 1 },
  diagnostics: { diagnostics: "none" as const, diagnostic_detail: false },
  snippets: { mode: "none" as const, max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
  registry: { registry: "none" as const, include_payload_schemas: false },
  response_budget: { max_items: 1_000, max_characters: 1_000_000 },
};

function pipelineQuery(stages: readonly unknown[], outputs: readonly { readonly stage_id: string; readonly output: string }[], workspaceId = "workspace:pipeline-test"): QueryRequest {
  const publicStages = stages.map((stage) => {
    const value = stage as Record<string, unknown>;
    if (value["operator"] === "source.operation" || value["operator"] === "expand.operation") {
      const stageArguments = value["arguments"] as Record<string, unknown>;
      const operationArguments = (stageArguments["operation_arguments"] ?? {}) as Record<string, unknown>;
      return {
        stage_id: value["stage_id"],
        stage_type: "operation",
        operation: operationArguments["operation"] ?? stageArguments["operation"],
        operation_version: 3,
        arguments: operationArguments,
      };
    }
    return {
      stage_id: value["stage_id"],
      stage_type: "operator",
      operator: value["operator"],
      inputs: value["inputs"],
      arguments: value["arguments"],
    };
  });
  return {
    api_version: 3,
    scope: scope(workspaceId),
    expression: { expression_type: "pipeline", stages: publicStages, outputs: outputs.map((output) => ({ ...output, name: output.output })) } as unknown as QueryExpression,
    options,
  };
}

function subj(value: Readonly<Record<string, unknown>>, key: string): QueryStreamItem {
  return { value, stable_sort_key: key };
}

type Handler = (operation: OperationInvocation) => OperationEvaluation | Promise<OperationEvaluation>;

class FakeDataPort implements QueryDataPort {
  constructor(private readonly handlers: Readonly<Record<string, Handler>>) {}
  async execute(operation: OperationInvocation): Promise<OperationEvaluation> {
    const handler = this.handlers[operation.operation_id];
    if (handler === undefined) return { streams: {} };
    return handler(operation);
  }
}

function engineFor(handlers: Readonly<Record<string, Handler>>): QueryEngine {
  return new QueryEngine({ data_port: new FakeDataPort(handlers), cursor_cache: new CursorCache({ signing_secret: "pipeline-executor-test" }), now: () => "2026-08-14T00:00:00.000Z" });
}

function items(page: Awaited<ReturnType<QueryEngine["execute"]>>, stream: string): readonly QueryStreamItem[] {
  return page.streams[stream]?.items ?? [];
}

describe("pipeline executor: stage_output resolution", () => {
  it("executes a v3 dependent chain and preserves declared output aliases", async () => {
    const calls: string[] = [];
    const engine = engineFor({
      "core:search_text": () => { calls.push("search"); return { streams: { matches: [], subjects: [subj({ subject_type: "record", record_id: "rec-root" }, "1")] } }; },
      "core:find_related_tests": (operation) => { calls.push("tests"); expect(operation.arguments).toMatchObject({ subjects: [{ subject_type: "record", record_id: "rec-root" }] }); expect(operation.input_handles?.has("find.subjects")).toBe(true); return { streams: { tests: [subj({ subject_type: "record", record_id: "rec-test" }, "2")], fixtures: [], mocks: [], helpers: [] } }; },
      "core:get_source": (operation) => { calls.push("source"); expect(operation.arguments).toMatchObject({ subjects: [{ subject_type: "record", record_id: "rec-test" }] }); expect(operation.input_handles?.has("tests.tests")).toBe(true); return { streams: { sources: [subj({ subject_type: "artifact", artifact_id: "art-1" }, "3")] } }; },
    });
    const request: QueryRequest = {
      api_version: 3,
      scope: scope("workspace:pipeline-v3"),
      expression: {
        expression_type: "pipeline",
        stages: [
          { stage_id: "find", stage_type: "operation", operation: "core:search_text", operation_version: 3, arguments: { pattern: "formatWireName" } },
          { stage_id: "tests", stage_type: "operation", operation: "core:find_related_tests", arguments: { relationship_scope: "both", include_fixtures: true }, bindings: { subjects: { stage_id: "find", output: "subjects" } } },
          { stage_id: "source", stage_type: "operation", operation: "core:get_source", arguments: { source: { mode: "relevant", max_characters_per_snippet: 100, max_total_characters: 1000, context_lines: 1 } }, bindings: { subjects: { stage_id: "tests", output: "tests" } } },
        ],
        outputs: [{ name: "test_sources", stage_id: "source", output: "sources" }],
      } as unknown as QueryExpression,
      options,
    };
    const page = await engine.execute(request);
    expect(calls).toEqual(["search", "tests", "source"]);
    expect(items(page, "test_sources").map((item) => item.stable_sort_key)).toEqual(["3"]);
    expect(page.streams["sources"]).toBeUndefined();
  });

  it("preserves lexical artifact identity when binding a stage output into get_source", async () => {
    const received: { source?: unknown } = {};
    const engine = engineFor({
      "core:search_text": () => ({ streams: { matches: [subj({ subject_type: "entity", universal_kind: "core:artifact", record_id: "artifact-record:artv-1", source_span: { artifact_version_id: "artv-1", start_byte: "40", end_byte: "41", start_line: "12", end_line: "12" }, body: { artifact_id: "sha256:artifact", artifact_version_id: "artv-1", path: "src/task.ts" } }, "1")] } }),
      "core:get_source": (operation) => {
        received.source = operation.arguments;
        return { streams: { sources: [subj({ subject_type: "artifact", record_id: "artifact-record:artv-1" }, "1")] } };
      },
    });
    const request = pipelineQuery(
      [
        { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "x" } } },
        { stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "search", output: "matches" }], source: { mode: "relevant", max_characters_per_snippet: 100, max_total_characters: 1000, context_lines: 1 } } } },
      ],
      [{ stage_id: "source", output: "sources" }],
    );
    await engine.execute(request);
    expect(received.source).toMatchObject({ subjects: [{ subject_type: "artifact", artifact_id: "sha256:artifact", artifact_version_id: "artv-1", source_span: { artifact_version_id: "artv-1", start_byte: "40", end_byte: "41", start_line: "12", end_line: "12" } }] });
  });

  it("resolves a stage_output selector embedded in an ARRAY field into a concrete record selector for every item the referenced stage produced", async () => {
    const received: { source?: unknown } = {};
    const engine = engineFor({
      "core:search_text": () => ({ streams: { matches: [subj({ subject_type: "entity", record_id: "rec-a" }, "1"), subj({ subject_type: "entity", record_id: "rec-b" }, "2")], subjects: [] } }),
      "core:get_source": (operation) => {
        received.source = operation.arguments;
        return { streams: { sources: [subj({ subject_type: "artifact", record_id: "rec-a" }, "1")] } };
      },
    });
    const request = pipelineQuery(
      [
        { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "x", syntax: "literal" } } },
        { stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "search", output: "matches" }], source: { mode: "relevant", max_characters_per_snippet: 100, max_total_characters: 1000, context_lines: 1 } } } },
      ],
      [{ stage_id: "source", output: "sources" }],
    );
    const page = await engine.execute(request);
    // Before the fix, `subjects` would have been the raw, unresolved
    // stage_output placeholder object -- get_source had no way to turn
    // that into records, so `sources` came back empty.
    expect(received.source).toMatchObject({ subjects: [{ subject_type: "record", record_id: "rec-a" }, { subject_type: "record", record_id: "rec-b" }] });
    expect(items(page, "sources")).toHaveLength(1);
  });

  it("resolves a stage_output selector used as a SCALAR field's whole value into a single concrete record selector", async () => {
    const received: { references?: unknown } = {};
    const engine = engineFor({
      "core:resolve_symbol": () => ({ streams: { declarations: [subj({ subject_type: "entity", record_id: "rec-ts" }, "1")], candidates: [] } }),
      "core:find_references": (operation) => {
        received.references = operation.arguments;
        return { streams: { references: [subj({ subject_type: "record", record_id: "rec-ref" }, "1")], owners: [] } };
      },
    });
    const request = pipelineQuery(
      [
        { stage_id: "resolve", operator: "source.operation", inputs: [], arguments: { operation: "core:resolve_symbol", operation_arguments: { reference: "TaskService" } } },
        { stage_id: "references", operator: "source.operation", inputs: [], arguments: { operation: "core:find_references", operation_arguments: { target: { subject_type: "stage_output", stage_id: "resolve", output: "declarations" }, include_declarations: false } } },
      ],
      [{ stage_id: "references", output: "references" }],
    );
    const page = await engine.execute(request);
    expect(received.references).toMatchObject({ target: { subject_type: "record", record_id: "rec-ts" } });
    expect(items(page, "references")).toHaveLength(1);
  });

  it("rejects a stage_output selector referencing an unknown stage with a typed error at request-validation time, never silent empty", async () => {
    const engine = engineFor({ "core:get_source": () => ({ streams: { sources: [] } }) });
    const request = pipelineQuery(
      [
        { stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "missing", output: "matches" }], source: { mode: "relevant", max_characters_per_snippet: 100, max_total_characters: 1000, context_lines: 1 } } } },
      ],
      [{ stage_id: "source", output: "sources" }],
    );
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "core:stage_reference_invalid" });
  });

  it("rejects a stage_output selector referencing an unknown OUTPUT of a real earlier stage", async () => {
    const engine = engineFor({
      "core:search_text": () => ({ streams: { matches: [], subjects: [] } }),
      "core:get_source": () => ({ streams: { sources: [] } }),
    });
    const request = pipelineQuery(
      [
        { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "x" } } },
        { stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "search", output: "not_a_real_output" }], source: { mode: "relevant", max_characters_per_snippet: 100, max_total_characters: 1000, context_lines: 1 } } } },
      ],
      [{ stage_id: "source", output: "sources" }],
    );
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "core:stage_reference_invalid" });
  });

  it("the pipeline executor's own runtime check also rejects an unknown stage_output referent (defense in depth, bypassing request validation)", async () => {
    const port: QueryDataPort = { execute: async () => ({ streams: { sources: [] } }) };
    await expect(
      executePipeline({
        stages: [{ stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "missing", output: "matches" }] } } } as never],
        outputs: [{ stage_id: "source", output: "sources" }],
        scope: scope("workspace:direct"),
        port,
      }),
    ).rejects.toMatchObject({ code: "core:stage_reference_invalid" });
  });
});

describe("pipeline executor: algebra operators", () => {
  it("passes execution-local stage handles to a handle-native relation join", async () => {
    const calls: string[] = [];
    const port: QueryDataPort = {
      execute: async (operation) => operation.operation_id === "core:find_records"
        ? { streams: { records: [subj({ subject_type: "record", record_id: "left" }, "left")] } }
        : { streams: { subjects: [subj({ subject_type: "record", record_id: "right" }, "right")] } },
      relation_exists: async () => false,
      relation_pairs_handles: async (_scope, left, right) => {
        calls.push(`${left.stage_id}.${left.output}->${right.stage_id}.${right.output}`);
        return new Set(["left\u0000right"]);
      },
    };
    const evaluation = await executePipeline({
      stages: [
        { stage_id: "left", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } },
        { stage_id: "right", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "right" } } },
        { stage_id: "joined", operator: "join", inputs: [{ stage_id: "left", output: "records" }, { stage_id: "right", output: "subjects" }], arguments: { predicate: "relation_exists", relation_selector: {}, direction: "outbound", output: "pairs" } },
      ] as never,
      outputs: [{ stage_id: "joined", output: "pairs" }],
      scope: scope("workspace:pipeline-handles"),
      port,
    });
    expect(calls).toEqual(["left.records->right.subjects"]);
    expect(evaluation.streams["pairs"]).toHaveLength(1);
  });

  it("set.union still combines two earlier stages' streams", async () => {
    const engine = engineFor({
      "core:find_records": () => ({ streams: { records: [subj({ subject_type: "record", record_id: "rec-a" }, "1")] } }),
      "core:search_text": () => ({ streams: { matches: [], subjects: [subj({ subject_type: "record", record_id: "rec-b" }, "1")] } }),
    });
    const request = pipelineQuery(
      [
        { stage_id: "records", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } },
        { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "x" } } },
        { stage_id: "combined", operator: "set.union", inputs: [{ stage_id: "records", output: "records" }, { stage_id: "search", output: "subjects" }], arguments: {} },
      ],
      [{ stage_id: "combined", output: "subjects" }],
    );
    const page = await engine.execute(request);
    expect(items(page, "subjects").map((entry) => (entry.value as { record_id: string }).record_id).sort()).toEqual(["rec-a", "rec-b"]);
  });

  it("filter narrows an earlier stage's stream by kind, composed with all/any/not", async () => {
    const engine = engineFor({
      "core:find_records": () => ({
        streams: {
          records: [
            subj({ subject_type: "record", record_id: "rec-fn", kind: "function" }, "1"),
            subj({ subject_type: "record", record_id: "rec-var", kind: "variable" }, "2"),
            subj({ subject_type: "record", record_id: "rec-cls", kind: "class" }, "3"),
          ],
        },
      }),
    });
    const request = pipelineQuery(
      [
        { stage_id: "records", operator: "source.operation", inputs: [], arguments: { operation: "core:find_records", operation_arguments: { selector: { record_categories: ["entity"] } } } },
        { stage_id: "filtered", operator: "filter", inputs: [{ stage_id: "records", output: "records" }], arguments: { predicate: { any: [{ kind: ["function"] }, { kind: ["class"] }] } } },
      ],
      [{ stage_id: "filtered", output: "subjects" }],
    );
    const page = await engine.execute(request);
    expect(items(page, "subjects").map((entry) => (entry.value as { record_id: string }).record_id).sort()).toEqual(["rec-cls", "rec-fn"]);
  });

  it("executes intersection, difference, deduplicate and select from sealed iterators", async () => {
    const engine = engineFor({
      "core:search_text": (operation) => String((operation.arguments as Record<string, unknown>)["pattern"]) === "left"
        ? { streams: { subjects: [subj({ subject_type: "record", record_id: "a" }, "a"), subj({ subject_type: "record", record_id: "shared" }, "s"), subj({ subject_type: "record", record_id: "a" }, "a-duplicate")] } }
        : { streams: { subjects: [subj({ subject_type: "record", record_id: "shared" }, "s"), subj({ subject_type: "record", record_id: "b" }, "b")] } },
    });
    const page = await engine.execute(pipelineQuery([
      { stage_id: "left", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "left" } } },
      { stage_id: "right", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "right" } } },
      { stage_id: "intersection", operator: "set.intersection", inputs: [{ stage_id: "left", output: "subjects" }, { stage_id: "right", output: "subjects" }], arguments: {} },
      { stage_id: "difference", operator: "set.difference", inputs: [{ stage_id: "left", output: "subjects" }, { stage_id: "right", output: "subjects" }], arguments: {} },
      { stage_id: "dedup", operator: "deduplicate", inputs: [{ stage_id: "left", output: "subjects" }], arguments: { identity: "subject" } },
      { stage_id: "selected", operator: "select", inputs: [{ stage_id: "intersection", output: "subjects" }, { stage_id: "difference", output: "subjects" }, { stage_id: "dedup", output: "subjects" }], arguments: { outputs: [
        { name: "intersection", input: { stage_id: "intersection", output: "subjects" }, projection: "subjects" },
        { name: "difference", input: { stage_id: "difference", output: "subjects" }, projection: "subjects" },
        { name: "dedup", input: { stage_id: "dedup", output: "subjects" }, projection: "subjects" },
      ] } },
    ], [{ stage_id: "selected", output: "intersection" }, { stage_id: "selected", output: "difference" }, { stage_id: "selected", output: "dedup" }]));
    expect(items(page, "intersection").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["shared"]);
    expect(items(page, "difference").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["a"]);
    expect(items(page, "dedup").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["a", "shared"]);
  });
});

describe("canonical handle binding boundary", () => {
  it("materializes only the bound selector required by a legacy operation", async () => {
    const record = {
      record_id: "bound-record",
      workspace_id: "workspace:handle-boundary",
      category: "entity",
      kind: "function_declaration",
      universal_kind: "core:function",
      owner_artifact_id: "artifact-1",
      owner_artifact_version_id: "artifact-version-1",
      body: { name: "bound" },
    };
    const snapshot = { records: async () => [record], test_only_allow_legacy_full_corpus_fallback: true } as never;
    const port = new CanonicalRecordQueryDataPort(snapshot);
    const handle = stageSetHandle("execution-boundary", "find", "subjects", [subj({ subject_type: "record", record_id: "bound-record" }, "bound")]);
    const evaluation = await port.execute({ operation_id: "core:find_references", result_streams: ["references", "owners"], arguments: { target: { subject_type: "stage_output", stage_id: "find", output: "subjects" } }, scope: scope("workspace:handle-boundary"), input_handles: new Map([["find.subjects", handle]]) });
    expect(evaluation.streams["references"]).toEqual([]);
  });
});

describe("pipeline final-manifest and continuation invariants", () => {
  it("streams the final pipeline handle into the manifest and preserves non-complete coverage on continuation", async () => {
    const engine = engineFor({
      "core:search_text": () => ({ streams: { subjects: [subj({ subject_type: "record", record_id: "r1" }, "1"), subj({ subject_type: "record", record_id: "r2" }, "2")] } }),
    });
    const request = pipelineQuery([
      { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "x" } } },
    ], [{ stage_id: "search", output: "subjects" }]);
    const page = await engine.execute({ ...request, options: { ...request.options, response_budget: { max_items: 1, max_characters: 10_000 } } });
    expect(page.completeness.overall_status).toBe("unknown");
    expect(page.streams["subjects"]?.items).toHaveLength(1);
    const cursor = page.streams["subjects"]?.next_cursor;
    expect(cursor).toBeDefined();
    const continuation = await engine.continue({ cursor: cursor!, response_budget: { max_items: 1, max_characters: 10_000 } });
    expect(continuation.completeness.overall_status).toBe("unknown");
    expect(continuation.streams["subjects"]?.items[0]?.stable_sort_key).toBe("2");
  });
});

describe("pipeline MCP instruction examples verified against a real workspace", () => {
  function pipelineRequest(workspaceId: string, expression: unknown): QueryRequest {
    return {
      api_version: 3,
      scope: scope(workspaceId),
      expression: expression as QueryExpression,
      options: { ...options, diagnostics: { diagnostics: "relevant", diagnostic_detail: true }, registry: { registry: "used", include_payload_schemas: false } },
    };
  }

  it("example (a) from MCP_SERVER_INSTRUCTIONS: search_text -> get_source in ONE call returns source for the matched artifact", async () => {
    const workspace = await buildTaskPlannerWorkspace("typescript");
    try {
      const page = await workspace.engine.execute(pipelineRequest(workspace.workspaceId, PIPELINE_EXAMPLE_SEARCH_TO_SOURCE));
      expect(items(page, "sources").length).toBeGreaterThan(0);
    } finally {
      await workspace.close();
    }
  });

  it("example (b) from MCP_SERVER_INSTRUCTIONS: resolve_symbol -> find_references in ONE call returns references to the resolved declaration", async () => {
    const workspace = await buildTaskPlannerWorkspace("typescript");
    try {
      const page = await workspace.engine.execute(pipelineRequest(workspace.workspaceId, PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES));
      expect(items(page, "references").length).toBeGreaterThan(0);
      expect(items(page, "owners").length).toBeGreaterThan(0);
    } finally {
      await workspace.close();
    }
  });

  it("three-stage example from MCP_SERVER_INSTRUCTIONS: resolve -> references -> source returns source for reference owners", async () => {
    const workspace = await buildTaskPlannerWorkspace("typescript");
    try {
      const page = await workspace.engine.execute(pipelineRequest(workspace.workspaceId, PIPELINE_EXAMPLE_RESOLVE_REFERENCES_TO_SOURCE));
      expect(items(page, "references").length).toBeGreaterThan(0);
      expect(items(page, "sources").length).toBeGreaterThan(0);
    } finally {
      await workspace.close();
    }
  });
});
