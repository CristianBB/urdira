import { describe, expect, it, vi } from "vitest";
import type { LocalIpcRequestOptions, UceResponse } from "../packages/daemon/src/index.js";
import { normalizeQueryRequest } from "../packages/engine/src/index.js";
import { operationRegistry, recipeRegistry, type QueryRequest } from "@urdira/contracts";
import {
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_NAMES,
  McpProtocolError,
  createUrdiraMcpServer,
  createUrdiraToolDefinitions,
  formatUrdiraResult,
  type UrdiraMcpToolDefinition,
} from "../packages/mcp/src/index.js";

function success(payload: unknown): UceResponse {
  return { protocol_version: 1, request_id: "request-1", outcome: "success", payload };
}

const scope = { scopeType: "single_workspace", workspaceId: "workspace-1" };
const options = {
  freshness: "snapshot",
  waitTimeoutMs: 0,
  coverageRequirement: "accept_reported",
  evidence: { evidence: "summary", evidenceChainDepth: 1 },
  diagnostics: { diagnostics: "relevant", diagnosticDetail: false },
  snippets: { mode: "none", maxCharactersPerSnippet: 0, maxTotalCharacters: 0, contextLines: 0 },
  registry: { registry: "none" },
  responseBudget: { maxItems: 10, maxCharacters: 10_000 },
};

function tool(definitions: readonly UrdiraMcpToolDefinition[], name: string): UrdiraMcpToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return definition;
}

describe("Phase 13 Urdira MCP adapter", () => {
  it("exposes exactly four deterministically ordered public tools", () => {
    const definitions = createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } });
    expect(definitions.map((definition) => definition.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(definitions.map((definition) => definition.input_schema.type)).toEqual(["object", "object", "object", "object"]);
    expect(definitions.map((definition) => definition.input_schema.properties?.["scope"]).filter((value) => value !== undefined)).toHaveLength(2);
    expect(definitions.map((definition) => definition.input_schema.additionalProperties)).toEqual([false, false, false, false]);
    expect(definitions[0]?.input_schema.properties?.["request_type"]).toBeDefined();
    expect(definitions[1]?.input_schema.required).not.toContain("options");
  });

  it("keeps output_schema on each definition as an internal reference constant, but never advertises it to the SDK or tools/list", () => {
    // A live benchmark (2026-08-14) found that Claude Code's MCP client
    // reads ONLY `structuredContent` -- never `content[0].text` -- whenever
    // a tool declares an outputSchema, because the installed
    // @modelcontextprotocol/server@2.0.0 requires `structuredContent` on
    // every non-error result once an outputSchema exists. Every Urdira tool
    // used to declare one, so agents were silently fed a two-field stub
    // instead of the rendered text `formatUrdiraResult` builds. The fix is
    // to stop registering outputSchema with the SDK entirely;
    // `definition.output_schema` (`MCP_OUTPUT_SCHEMA`) is kept only as an
    // internal reference value, asserted here so it cannot silently drift.
    const definitions = createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } });
    expect(definitions.every((definition) => definition.output_schema.oneOf)).toBe(true);

    const server = createUrdiraMcpServer({ client: { call: vi.fn(async () => success({})) } }) as unknown as {
      _registeredTools: Record<string, { outputSchema?: unknown }>;
    };
    for (const name of MCP_TOOL_NAMES) {
      expect(server._registeredTools[name]).toBeDefined();
      expect(server._registeredTools[name]!.outputSchema).toBeUndefined();
    }
  });

  it("never advertises a render field on any tool's input schema, description, or the server instructions", () => {
    const definitions = createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } });
    for (const definition of definitions) {
      expect(definition.input_schema.properties?.["render"]).toBeUndefined();
      expect(definition.description).not.toContain("render:");
      expect(definition.description).not.toContain('"json"');
    }
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain("render:");
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain('"render"');
  });

  it("lowers analyze-change and context tools to explicit scoped query requests", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    const definitions = createUrdiraToolDefinitions({ client: { call } });
    const target = { subjectType: "symbol", name: "PaymentService.capture" };
    const change = { changeType: "rename", newName: "authorize" };

    await tool(definitions, "urdira_analyze_change").invoke({ api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, target: { subject_type: "symbol", name: "PaymentService.capture" }, change: { change_type: "rename", new_name: "authorize" }, options: { freshness: "snapshot", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none" }, response_budget: { max_items: 10, max_characters: 10_000 } } });
    await tool(definitions, "urdira_build_context").invoke({ api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, task: "find the call path", facets: ["callers"], options: { freshness: "snapshot", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none" }, response_budget: { max_items: 10, max_characters: 10_000 } } });

    expect(call.mock.calls.map(([name]) => name)).toEqual(["core:query", "core:query"]);
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      api_version: 1,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      expression: { expression_type: "operation", operation: "core:analyze_impact", arguments: { target: { subject_type: "symbol", name: "PaymentService.capture" }, change: { change_type: "rename", new_name: "authorize" } } },
      options: { response_budget: { max_items: 10, max_characters: 10_000 } },
    });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expression: { operation: "core:build_context", arguments: { task: "find the call path", facets: ["callers"] } } });
  });

  it("uses the query continuation call when the signed cursor form is supplied", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await definition.invoke({ request_type: "continuation", continuation: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, cursor: "signed.cursor", response_budget: { max_items: 2, max_characters: 100 } } });
    expect(call).toHaveBeenCalledWith("core:query_continue", {
      api_version: 1,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      cursor: "signed.cursor",
      response_budget: { max_items: 2, max_characters: 100 },
    }, expect.anything());
  });

  it("keeps index-status requests on the explicit status cursor model", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({
      request_type: "initial",
      api_version: 1,
      workspace_ids: [],
      include_capabilities: true,
      include_plugins: true,
      include_activation_issues: false,
      include_candidate_issues: false,
      response_budget: { max_items: 3, max_characters: 200 },
    });
    expect(call).toHaveBeenCalledWith("core:index_status", {
      request_type: "initial",
      api_version: 1,
      workspace_ids: [],
      include_capabilities: true,
      include_plugins: true,
      include_activation_issues: false,
      include_candidate_issues: false,
      response_budget: { max_items: 3, max_characters: 200 },
    }, expect.anything());
  });

  it("keeps the benchmark discovery projection to one observable call while preserving internal status/query evidence", async () => {
    const call = vi.fn(async (name: string, _payload: unknown = undefined) => name === "core:index_status"
      ? success({ workspaces: [{ workspace_id: "workspace-1", workspace_status: "ready", freshness_status: "equivalent", current_snapshot_id: "snapshot-1" }] })
      : success({ result_sets: [] }));
    const server = createUrdiraMcpServer({ client: { call } }, { tool_names: [], benchmark_discover: true }) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, context: unknown) => Promise<{ content: readonly { type: "text"; text: string }[] }> }>;
    };
    expect(Object.keys(server._registeredTools)).toEqual(["urdira_benchmark_discover"]);
    const result = await server._registeredTools["urdira_benchmark_discover"]!.handler({ workspace_root: "/repo", path: "packages/excalidraw/tests/fixtures/agentRestoreMetadata.json" }, {
      mcpReq: { _meta: {}, signal: new AbortController().signal, notify: vi.fn() },
    });
    expect(call.mock.calls.map(([name]) => name)).toEqual(["core:index_status", "core:query"]);
    expect(result.content[0]?.text).toContain("core:index_status");
    expect(result.content[0]?.text).toContain("core:query");
  });

  it("uses a source snapshot for benchmark discovery before structural readiness", async () => {
    const call = vi.fn(async (name: string, _payload: unknown = undefined) => name === "core:index_status"
      ? success({ workspaces: [{ workspace_id: "workspace-1", workspace_status: "indexing", source_ready: true, structural_ready: false, source_snapshot_id: "source-snapshot:7" }] })
      : success({ result_sets: [] }));
    const server = createUrdiraMcpServer({ client: { call } }, { tool_names: [], benchmark_discover: true }) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, context: unknown) => Promise<unknown> }>;
    };
    await server._registeredTools["urdira_benchmark_discover"]!.handler({ workspace_root: "/repo", path: "src/file.ts" }, { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: vi.fn() } });
    expect(call.mock.calls.map(([name]) => name)).toEqual(["core:index_status", "core:query"]);
    expect(call.mock.calls[1]?.[1]).toMatchObject({ api_version: 2, scope: { snapshot_id: "source-snapshot:7" } });
  });

  it("renders a compact text projection by default, and preserves the full JSON page verbatim under render: \"json\"", () => {
    const page = {
      query_execution_id: "execution-1",
      scope_kind: "single_workspace",
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: [{
        result_set: "subjects",
        confirmed: {
          classification: "confirmed", page_mode: "summary",
          result_bundles: [{
            result_set: "subjects",
            primary_result: { subject_type: "entity", record_id: "record:1", entity_id: "jsts:class_declaration:src/a.ts:10:Foo", identity_key: "jsts:class_declaration:src/a.ts:10:Foo", universal_kind: "core:type", kind: "jsts:entity_type", classification: "confirmed", body: { name: "Foo", kind: "class_declaration", path: "src/a.ts" } },
            assessment: { classification: "confirmed", completeness: "complete" },
            provenance_path: [], essential_related_entities: [], optional_source_snippets: [],
          }],
          total: 1, has_next: false, has_previous: false,
        },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false },
      }],
      expires_at: "2026-01-01T00:00:00.000Z",
      returned_items: 1,
      returned_characters: 0,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] },
      diagnostic_report: { total: 0, returned: 0, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics: [], has_more: false },
    };

    const textResult = formatUrdiraResult(page);
    const textBlock = textResult.content.find((block): block is { type: "text"; text: string } => block.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.text).toContain("# 1 result");
    expect(textBlock!.text).toContain("src/a.ts");
    expect(textBlock!.text).toContain("Foo class_declaration");
    expect(textBlock!.text).not.toContain("record_id");
    expect(textBlock!.text).not.toContain("record:1");
    // No duplicated JSON page, and no structuredContent at all: since no
    // tool declares an outputSchema (see the dedicated test above),
    // structuredContent is never required and is never emitted -- an MCP
    // client that reads structuredContent instead of content[0].text when
    // an outputSchema is present (the live bug this fixes) now has nothing
    // to read but the rendered text.
    expect(() => JSON.parse(textBlock!.text)).toThrow();
    expect(textResult.structuredContent).toBeUndefined();
    expect(textResult.isError).toBeUndefined();

    const jsonResult = formatUrdiraResult(page, { render: "json" });
    const jsonBlock = jsonResult.content.find((block): block is { type: "text"; text: string } => block.type === "text");
    expect(jsonBlock).toBeDefined();
    expect(JSON.parse(jsonBlock!.text)).toEqual({ page });
    expect(jsonResult.structuredContent).toBeUndefined();
    expect(jsonResult.isError).toBeUndefined();

    const failure = formatUrdiraResult({ error: { code: "core:workspace_not_found", message: "missing", details: { workspace_id: "workspace-1" } } });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toBeUndefined();
    const failureBlock = failure.content.find((block): block is { type: "text"; text: string } => block.type === "text");
    expect(failureBlock).toBeDefined();
    expect(JSON.parse(failureBlock!.text)).toMatchObject({ error: { code: "core:workspace_not_found", message: "missing", details: { workspace_id: "workspace-1" }, retryable: false } });
  });

  it("renders the first source-snippet line as a grep-style locator when the primary result has no line", () => {
    const textResult = formatUrdiraResult({
      query_execution_id: "execution-lines",
      scope_kind: "single_workspace",
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: [{
        result_set: "sources",
        confirmed: {
          classification: "confirmed", page_mode: "summary",
          result_bundles: [{
            result_set: "sources",
            primary_result: { subject_type: "entity", universal_kind: "core:artifact", kind: "core:source_file", source_span: { artifact_version_id: "artv-1", start_byte: "40", end_byte: "56", start_line: "12", end_line: "12" }, body: { path: "src/task.ts" } },
            assessment: { classification: "confirmed", completeness: "complete" },
            provenance_path: [], essential_related_entities: [],
            optional_source_snippets: [{ text: "const value = 1;", span: { artifact_version_id: "artv-1", start_byte: "40", end_byte: "56", start_line: "12", end_line: "12" }, truncated: false, redacted: false, redactions: [] }],
          }],
          total: 1, has_next: false, has_previous: false,
        },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false,
        },
      }],
      expires_at: "2026-01-01T00:00:00.000Z",
      returned_items: 1,
      returned_characters: 0,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] },
      diagnostic_report: { total: 0, returned: 0, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics: [], has_more: false },
    });
    const block = textResult.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text");
    expect(block?.text).toContain("src/task.ts:12");
    expect(block?.text).toContain("    const value = 1;");
  });

  it("preserves source snippets when formatting the raw streams returned by a pipeline", async () => {
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({
      query_execution_id: "execution-pipeline-source",
      streams: {
        sources: { items: [{
          value: {
            result_set: "sources",
            primary_result: { subject_type: "entity", universal_kind: "core:artifact", kind: "core:source_file", body: { path: "src/task.ts" } },
            assessment: { classification: "confirmed", completeness: "complete" },
            provenance_path: [],
            essential_related_entities: [],
            optional_source_snippets: [{ text: "const value = 1;", span: { artifact_version_id: "artv-1", start_byte: "40", end_byte: "56", start_line: "12", end_line: "12" }, truncated: false, redacted: false, redactions: [] }],
          },
          stable_sort_key: "confirmed\\0src/task.ts",
        }], next_cursor: undefined },
      },
      completeness: { overall_status: "complete", dimensions: [] },
      diagnostics: [],
    })) } }), "urdira_query");
    const textResult = await definition.invoke({
      request_type: "initial",
      api_version: 1,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "value", syntax: "literal" } },
    });
    const block = textResult.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text");
    expect(block?.text).toContain("src/task.ts:12");
    expect(block?.text).toContain("const value = 1;");
  });

  it("keeps bounded pipeline source evidence instead of shedding every snippet at the default text budget", async () => {
    const snippet = "const value = 1;\\n".repeat(100);
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({
      query_execution_id: "execution-pipeline-budget",
      streams: {
        sources: {
          items: Array.from({ length: 8 }, (_, index) => ({
            value: {
              result_set: "sources",
              primary_result: { subject_type: "entity", universal_kind: "core:artifact", kind: "core:source_file", body: { path: `src/task-${index}.ts` } },
              assessment: { classification: "confirmed", completeness: "complete" },
              provenance_path: [],
              essential_related_entities: [],
              optional_source_snippets: [{ text: snippet, span: { artifact_version_id: `artv-${index}`, start_byte: "0", end_byte: String(snippet.length), start_line: "1", end_line: "100" }, truncated: false, redacted: false, redactions: [] }],
            },
            stable_sort_key: `confirmed\\0src/task-${index}.ts`,
          })),
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
      diagnostics: [],
    })) } }), "urdira_query");
    const textResult = await definition.invoke({
      request_type: "initial",
      api_version: 1,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "value", syntax: "literal" } },
    });
    const block = textResult.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text");
    expect(block?.text).toContain("const value = 1;");
  });

  it("forwards cancellation and progress through the daemon boundary", async () => {
    const controller = new AbortController();
    const progress: unknown[] = [];
    const call = vi.fn(async (_name: string, _payload: unknown, requestOptions?: LocalIpcRequestOptions) => {
      requestOptions?.on_progress?.({ phase: "querying", completed: 1, total: 2 });
      expect(requestOptions?.signal).toBe(controller.signal);
      return success({ ok: true });
    });
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({ request_type: "initial", api_version: 1, workspace_ids: [], include_capabilities: true, include_plugins: true, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 2, max_characters: 100 } }, { signal: controller.signal, onProgress: (event) => progress.push(event) });
    expect(progress).toEqual([{ phase: "querying", completed: 1, total: 2 }]);
  });

  it("separates malformed adapter input from domain failures", async () => {
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } }), "urdira_query");
    await expect(definition.invoke({ apiVersion: 1, scope })).rejects.toBeInstanceOf(McpProtocolError);
  });

  it("registers the same four tools on the official MCP server without writing stdout", () => {
    const write = vi.spyOn(process.stdout, "write");
    const server = createUrdiraMcpServer({ client: { call: vi.fn(async () => success({})) } });
    expect(server).toBeDefined();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("still honors an explicit render: \"json\" through the real AJV schema validation the MCP server enforces, even though it is absent from the advertised schema", async () => {
    // `render` was removed from every advertised input_schema (see the test
    // above) so agents can no longer discover it. Every tool schema also sets
    // additionalProperties: false, so if the server's *real* wire-validation
    // path (not the direct definition.invoke() shortcut the other tests use)
    // did not separately re-admit `render`, an explicit render: "json" from a
    // debugging client would now be rejected before ever reaching invoke().
    // This reaches into the registered tool's Standard Schema object -- the
    // exact thing `tools/call` validates every request against -- to prove
    // both halves hold: the schema handed to `tools/list` stays render-free,
    // and the schema AJV actually validates against still accepts render.
    const server = createUrdiraMcpServer({ client: { call: vi.fn(async () => success({})) } }) as unknown as {
      _registeredTools: Record<string, {
        inputSchema: {
          "~standard": {
            validate: (data: unknown) => { value?: unknown; issues?: readonly { message: string }[] };
            jsonSchema: { input: () => { properties?: Record<string, unknown> } };
          };
        };
      }>;
    };
    const registeredQueryTool = server._registeredTools["urdira_query"];
    expect(registeredQueryTool).toBeDefined();
    const standard = registeredQueryTool!.inputSchema["~standard"];

    expect(standard.jsonSchema.input().properties?.["render"]).toBeUndefined();

    const args = {
      request_type: "query",
      render: "json",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    };
    const result = standard.validate(args);
    expect(result.issues).toBeUndefined();
    expect((result.value as Record<string, unknown> | undefined)?.["render"]).toBe("json");

    const rejected = standard.validate({ ...args, some_undocumented_field: true });
    expect(rejected.issues).toBeDefined();
  });

  it("fully defaults a minimal urdira_query call into an engine-valid core:query payload", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await definition.invoke({
      request_type: "query",
      query: {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
      },
    });
    const payload = call.mock.calls[0]?.[1] as QueryRequest;
    expect(payload.options).toEqual({
      freshness: "current",
      wait_timeout_ms: 0,
      coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 },
      diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
      snippets: { mode: "relevant", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 },
      registry: { registry: "none", include_payload_schemas: false },
      response_budget: { max_items: 50, max_characters: 20_000 },
    });
    expect(() => normalizeQueryRequest(payload)).not.toThrow();
  });

  it("deep-merges partial options over agent-friendly defaults", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await definition.invoke({
      request_type: "query",
      query: {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
        options: { freshness: "snapshot", snippets: { mode: "body" } },
      },
    });
    const payload = call.mock.calls[0]?.[1] as QueryRequest;
    expect(payload.options.freshness).toBe("snapshot");
    expect(payload.options.coverage_requirement).toBe("accept_reported");
    expect(payload.options.snippets).toEqual({ mode: "body", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 });
    expect(() => normalizeQueryRequest(payload)).not.toThrow();
  });

  it("defaults a workspace_root-only index-status call to a valid v3 initial payload", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({ workspace_root: "/repo" });
    expect(call).toHaveBeenCalledWith("core:index_status", {
      request_type: "initial",
      api_version: 3,
      workspace_ids: [],
      include_capabilities: false,
      include_plugins: false,
      include_activation_issues: false,
      include_candidate_issues: false,
      response_budget: { max_items: 50, max_characters: 20_000 },
      workspace_root: "/repo",
      include_configuration_issues: false,
    }, expect.anything());
  });

  it("defaults an empty index-status call to a v3 list-all payload", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({});
    expect(call).toHaveBeenCalledWith("core:index_status", {
      request_type: "initial",
      api_version: 3,
      workspace_ids: [],
      include_capabilities: false,
      include_plugins: false,
      include_activation_issues: false,
      include_candidate_issues: false,
      response_budget: { max_items: 50, max_characters: 20_000 },
    }, expect.anything());
  });

  it("exposes non-empty server instructions naming every operation and recipe", () => {
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    for (const operation of operationRegistry) expect(MCP_SERVER_INSTRUCTIONS).toContain(operation.operation_id);
    for (const recipe of recipeRegistry) expect(MCP_SERVER_INSTRUCTIONS).toContain(recipe.recipe_id);
  });

  it("renders a search_text-style match as one grep -n style line, path: matched text", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: {
        matches: {
          items: [{
            value: {
              result_set: "matches",
              primary_result: { subject_type: "entity", record_id: "artifact-record:v1", universal_kind: "core:artifact", kind: "core:source_file", body: { path: "src/billing.ts" } },
              assessment: { classification: "confirmed", completeness: "complete" },
              provenance_path: [],
              essential_related_entities: [],
              optional_source_snippets: [{ text: "  const total = price + tax;", span: { artifact_version_id: "v1", start_byte: "120", end_byte: "148" }, truncated: false, redacted: false, redactions: [] }],
            },
            stable_sort_key: "confirmed artifact-record:v1 000000000120",
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "price + tax" } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("src/billing.ts: const total = price + tax;");
    expect(text).not.toContain("record_id");
    expect(text).not.toContain("optional_source_snippets");
  });

  it("renders exactly one MORE line with the full cursor appearing once, at the end", async () => {
    const cursorValue = "signed.cursor.abcdefghijklmnopqrstuvwxyz0123456789";
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: { subjects: { items: [{ value: { subject_type: "entity", record_id: "record:1", kind: "jsts:entity_type", body: { name: "Foo", path: "src/a.ts" } }, stable_sort_key: "001" }], next_cursor: cursorValue, has_next: true, has_previous: false } },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text.match(/^MORE:/gm)).toHaveLength(1);
    expect(text.trim().split("\n").at(-1)).toBe(cursorValue);
    expect(text.split(cursorValue)).toHaveLength(2); // exactly one occurrence: the full cursor line at the end
  });

  it("renders a TRUNCATED note with a dropped-item count when the response budget sheds bundles", async () => {
    const bigText = "x".repeat(500);
    const streams = { subjects: { items: Array.from({ length: 30 }, (_unused, index) => ({ stable_sort_key: String(index), value: { subject_type: "entity", record_id: `entity-${index}`, kind: "jsts:entity_type", body: { name: `Entity${index}`, path: `src/file-${index}.ts`, blob: bigText } } })), has_next: false, has_previous: false } };
    const call = vi.fn(async () => success({ query_execution_id: "execution-1", streams, completeness: { overall_status: "complete", dimensions: [] } }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
        options: { response_budget: { max_characters: 300 } },
      },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toMatch(/^TRUNCATED: dropped \d+ items? \(response_budget\)$/m);
    expect(text.length).toBeLessThan(2000);
  });

  it("renders an empty result page as 'no results' with an actionable hint", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: { subjects: { items: [], has_next: false, has_previous: false } },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "NothingMatchesThis" } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text.startsWith("no results")).toBe(true);
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("renders a 600-artifact partial-completeness state as one coverage line, with no raw artifact ids", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`);
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: { subjects: { items: [{ value: { subject_type: "entity", record_id: "record:1", kind: "jsts:entity_type", body: { name: "Foo", path: "src/a.ts" } }, stable_sort_key: "001" }], has_next: false, has_previous: false } },
      completeness: { overall_status: "partial", dimensions: [{ capability: "core:call_relationships", status: "partial", reason_codes: [], affected_artifact_ids: ids, diagnostic_record_ids: [] }] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("coverage: partial (600 files affected)");
    expect(text).not.toContain("sha256:");
    expect(text.match(/coverage:/g)).toHaveLength(1);
  });

  it("renders an index_status page as a few compact lines per workspace", async () => {
    const call = vi.fn(async () => success({
      workspaces: [{
        workspace_id: "workspace-1",
        display_root: "urdira",
        workspace_status: "ready",
        freshness_status: "current",
        current_snapshot_id: "snapshot-9",
        capabilities: [
          { capability: "core:symbol_declarations", capability_contract_version: 1, provider_id: "jsts", provider_version: "1.0.0", status: "partial", reason_codes: [], affected_artifact_count: 0 },
          { capability: "core:call_relationships", capability_contract_version: 1, provider_id: "jsts", provider_version: "1.0.0", status: "partial", reason_codes: [], affected_artifact_count: 0 },
        ],
        plugins: [{ plugin_id: "jsts", plugin_version: "1.0.0", activation_status: "active", capability_declarations: [] }],
        configuration_issues: [],
      }],
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status");
    const result = await definition.invoke({ workspace_root: "/repo" });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("workspace_id=workspace-1");
    expect(text).toContain("ready");
    expect(text).toContain("freshness=current");
    expect(text).toContain("capabilities: 2");
    expect(text.split("\n").length).toBeLessThan(10);
    expect(result.structuredContent).toBeUndefined();
  });

  it("gives every tool a substantive description", () => {
    const definitions = createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } });
    for (const definition of definitions) expect(definition.description.length).toBeGreaterThanOrEqual(300);
  });

  it("bounds completeness dimensions to a deterministic prefix with an exact count and set id", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`);
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: {},
      completeness: { overall_status: "partial", dimensions: [{ capability: "core:call_relationships", status: "partial", reason_codes: [], affected_artifact_ids: ids, diagnostic_record_ids: [] }] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      render: "json",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const jsonBlock = result.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    const page = (JSON.parse(jsonBlock.text) as { page: { completeness_report: { dimensions: Array<{ affected_artifact_count: number; affected_artifact_ids: string[]; affected_artifact_set_id?: string }> } } }).page;
    const dimension = page.completeness_report.dimensions[0]!;
    expect(dimension.affected_artifact_count).toBe(600);
    expect(dimension.affected_artifact_ids.length).toBeLessThanOrEqual(8);
    expect(dimension.affected_artifact_set_id).toBeDefined();
  });

  it("sheds an over-budget envelope deterministically and reflects the whole envelope in returned_characters", async () => {
    const bigText = "x".repeat(500);
    const streams = { subjects: { items: Array.from({ length: 30 }, (_unused, index) => ({ stable_sort_key: String(index), value: { entity_id: `entity-${index}`, text: bigText } })), has_next: false, has_previous: false } };
    const call = vi.fn(async () => success({ query_execution_id: "execution-1", streams, completeness: { overall_status: "complete", dimensions: [] } }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const invokeOnce = () => definition.invoke({
      request_type: "query",
      render: "json",
      query: {
        api_version: 1,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
        options: { response_budget: { max_characters: 2000 } },
      },
    });
    const first = await invokeOnce();
    const second = await invokeOnce();
    const firstText = first.content.find((block): block is { type: "text"; text: string } => block.type === "text")!.text;
    const page = (JSON.parse(firstText) as { page: Record<string, unknown> }).page;
    expect(page["truncation"]).toMatchObject({ truncated: true, reason: "response_budget" });
    expect((page["truncation"] as { dropped_items: number }).dropped_items).toBeGreaterThan(0);
    expect(typeof page["returned_characters"]).toBe("number");
    expect(second).toEqual(first);
  });

  it("never emits previous_cursor in the public envelope", async () => {
    const preShaped = {
      query_execution_id: "execution-1",
      scope_kind: "single_workspace",
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: [{
        result_set: "subjects",
        confirmed: { classification: "confirmed", page_mode: "summary", result_bundles: [], total: 0, has_next: true, has_previous: true, next_cursor: "next.sig", previous_cursor: "prev.sig" },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false },
      }],
      expires_at: "2026-01-01T00:00:00.000Z",
      returned_items: 0,
      returned_characters: 0,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] },
      diagnostic_report: { total: 0, returned: 0, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics: [], has_more: false },
    };
    const call = vi.fn(async () => success(preShaped));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      render: "json",
      query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const jsonBlock = result.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    const page = (JSON.parse(jsonBlock.text) as { page: { result_sets: Array<{ confirmed: Record<string, unknown> }> } }).page;
    expect(page.result_sets[0]?.confirmed["previous_cursor"]).toBeUndefined();
    expect(page.result_sets[0]?.confirmed["next_cursor"]).toBe("next.sig");
  });
});
