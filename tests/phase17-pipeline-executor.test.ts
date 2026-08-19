import { describe, expect, it } from "vitest";
import type { QueryExpression, QueryRequest, QueryScope } from "@urdira/contracts";
import { CursorCache, QueryEngine, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem } from "../packages/engine/src/index.js";
import { executePipeline } from "../packages/engine/src/pipeline-executor.js";
import { PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES, PIPELINE_EXAMPLE_SEARCH_TO_SOURCE } from "../packages/mcp/src/index.js";
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
  return {
    api_version: 1,
    scope: scope(workspaceId),
    expression: { expression_type: "pipeline", stages, outputs } as unknown as QueryExpression,
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
});

describe("pipeline MCP instruction examples verified against a real workspace", () => {
  function pipelineRequest(workspaceId: string, expression: unknown): QueryRequest {
    return {
      api_version: 1,
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
});
