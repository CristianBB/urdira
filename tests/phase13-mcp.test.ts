import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { LocalIpcRequestOptions, IpcResponse } from "../packages/daemon/src/index.js";
import { normalizeQueryRequest } from "../packages/engine/src/index.js";
import { operationRegistry, recipeRegistry, type QueryRequest } from "@urdira/contracts";
import {
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_VERSION,
  buildBenchmarkInstructions,
  MCP_TOOL_NAMES,
  McpProtocolError,
  createUrdiraMcpServer,
  createUrdiraToolDefinitions,
  formatUrdiraResult,
  type UrdiraMcpToolDefinition,
} from "../packages/mcp/src/index.js";

function success(payload: unknown): IpcResponse {
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
  it("advertises the release version and a static tool catalog", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createUrdiraMcpServer({ client: { call: vi.fn(async () => success({})) } });
    const client = new Client({ name: "urdira-discovery-test", version: "1" });

    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(MCP_SERVER_VERSION).toBe("0.3.3");
      expect(client.getServerVersion()).toEqual({ name: "urdira", version: "0.3.3" });
      expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes the deterministic public tools, including the one-call context wrapper", () => {
    const definitions = createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } });
    expect(definitions.map((definition) => definition.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(definitions.map((definition) => definition.input_schema.type)).toEqual(["object", "object", "object", "object", "object"]);
    expect(definitions.map((definition) => definition.input_schema.properties?.["scope"]).filter((value) => value !== undefined)).toHaveLength(3);
    expect(definitions.map((definition) => definition.input_schema.additionalProperties)).toEqual([false, false, false, false, false]);
    expect(definitions[0]?.input_schema.properties?.["request_type"]).toBeDefined();
    expect(definitions[1]?.input_schema.required).not.toContain("options");
    const contextSeeds = definitions[1]?.input_schema.properties?.["seeds"] as { items?: { oneOf?: Array<{ oneOf?: unknown; properties?: Record<string, unknown> }> } };
    expect(contextSeeds.items?.oneOf).toHaveLength(6);
    expect(contextSeeds.items?.oneOf?.some((variant) => variant.oneOf !== undefined)).toBe(false);
    expect(contextSeeds.items?.oneOf?.some((variant) => variant.properties?.["path"] !== undefined)).toBe(true);
  });

  it("rejects malformed v3 expressions before opening the IPC client", async () => {
    const call = vi.fn(async () => success({}));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await expect(definition.invoke({
      request_type: "query",
      query: {
        api_version: 3,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        freshness: { mode: "wait", required_frontier: "source", timeout_ms: 30_000 },
        expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: {} },
      },
    })).rejects.toThrow(/\/query\/freshness.*\/query\/options\/freshness/u);
    expect(call).not.toHaveBeenCalled();
  });

  it("includes pointer, received value, and example in nested admission errors", async () => {
    const call = vi.fn(async () => success({}));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await expect(definition.invoke({
      request_type: "query",
      query: {
        api_version: 3,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: { unknown: true } },
        options: { freshness: "snapshot", wait_timeout_ms: 0 },
      },
    })).rejects.toThrow(/received true.*example/u);
    expect(call).not.toHaveBeenCalled();
  });

  it("defaults the complete context wrapper to a structural freshness wait", async () => {
    let payload: unknown;
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async (_call, value) => { payload = value; return success({}); }) } }), "urdira_context");
    await definition.invoke({ api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, task: "trace the request path", facets: ["definitions"] });
    expect((payload as { options: { freshness: unknown; required_frontier: unknown; wait_timeout_ms: unknown } }).options).toMatchObject({ freshness: "wait_for_current", required_frontier: "structural", wait_timeout_ms: 30_000 });
  });

  it("degrades a timed-out urdira_context wait into a compact plain-text notice naming source/syntax tools available now", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "core:query") {
        return {
          protocol_version: 1,
          request_id: "request-1",
          outcome: "error",
          error: {
            code: "core:freshness_wait_timeout",
            message: "Required structural frontier for workspace workspace-1 did not become current within 30000 milliseconds.",
            details: { workspace_ids: ["workspace-1"], waited_ms: 30_000, pending_observation_counts: [1], retry_after_ms: 1000 },
          },
        } satisfies IpcResponse;
      }
      return success({
        workspaces: [{
          workspace_id: "workspace-1",
          display_root: "project",
          workspace_status: "indexing",
          startup_phase: "publishing_structural",
          freshness_status: "changes_pending",
          source_ready: true,
          syntax_ready: true,
          structural_stage_1_ready: true,
          structural_ready: false,
          semantic_ready: false,
          structural_stage_ordinal: 2,
          retry_after_ms: 1000,
        }],
      });
    });
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_context");
    const result = await definition.invoke({ api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, task: "trace the request path", facets: ["definitions"] });
    expect(call.mock.calls.map(([name]) => name)).toEqual(["core:query", "core:index_status"]);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    const block = result.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text")!;
    // Plain compact text -- matching renderIndexStatusText/renderQueryPageText's
    // style -- not a JSON error dump.
    expect(() => JSON.parse(block.text)).toThrow();
    expect(block.text).toContain("core:freshness_wait_timeout");
    expect(block.text).toContain("phase=publishing_structural");
    expect(block.text).toContain("structural_stage_ordinal=2");
    expect(block.text).toContain("retry_after_ms=1000");
    expect(block.text).toContain("search_text");
    expect(block.text).toContain("get_source");
    expect(block.text).toContain("find_artifacts");
    expect(block.text).toContain("discover_definitions");
  });

  it("caps MCP query pages below the local IPC frame and leaves continuation available", async () => {
    let payload: unknown;
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async (_call, value) => { payload = value; return success({ result_sets: [] }); }) } }), "urdira_query");
    await definition.invoke({
      request_type: "query",
      query: {
        api_version: 3,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "projectService", syntax: "literal" } },
        options: { response_budget: { max_items: 200, max_characters: 100_000 } },
      },
    });
    expect((payload as { options: { response_budget: unknown } }).options.response_budget).toEqual({ max_items: 50, max_characters: 100_000 });
  });

  it("builds benchmark instructions from registered operations and examples", () => {
    const instructions = buildBenchmarkInstructions("src/example.ts");
    const queryTool = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } }), "urdira_query");
    const contextTool = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } }), "urdira_context");
    expect(instructions).toContain("core:search_text");
    expect(instructions).toContain("expression_type");
    expect(instructions).toContain('"request_type":"query","query":{"api_version":3');
    expect(instructions).toContain('"options":{"freshness":{"mode":"wait","required_frontier":"source"');
    expect(instructions).toContain('"timeout_ms":240000');
    expect(instructions).toContain("On large workspaces, use timeout_ms:240000 for post-edit freshness waits");
    expect(instructions).toContain("do not add operation_version to a direct operation expression");
    expect(instructions).toContain("exact field operation; never replace it with core, operator, or operation_id");
    expect(instructions).toContain("word_mode is only substring, identifier, or token");
    expect(instructions).toContain("subjects must be closed selector objects, never bare path strings");
    expect(instructions).toContain("arguments.filter.paths (an array)");
    expect(instructions).toContain("core:find_artifacts exposes output artifacts (not subjects)");
    expect(instructions).toContain("Do not send api_version, scope, options, or query fields to urdira_index_status");
    expect(instructions).toContain('The primary bootstrap call is exactly {"workspace_root":"<repository root>"}');
    expect(instructions).toContain("response_budget is an object, never a number");
    expect(instructions).toContain("Every urdira_context call requires top-level api_version:3");
    expect(instructions).toContain("urdira_context overrides belong under the single top-level options object");
    expect(instructions).toContain("Every freshness object requires mode, required_frontier, and timeout_ms together");
    expect(instructions).toContain("Reuse the exact query_scope object returned by urdira_index_status byte-for-byte");
    expect(instructions).toContain("After editing, wait for the structural frontier before final symbol rediscovery");
    expect(instructions).toContain("matches and subjects are output stream names for bindings, never result_projection values");
    expect(instructions).toContain("src/directory/** for a directory subtree");
    expect(instructions).toContain('"subjects":[{"subject_type":"artifact","path":"src/example.ts"}]');
    expect(instructions).toContain('symbol by known name={subject_type:"symbol",name:"QualifiedOrShortName"}');
    expect(instructions).toContain("Never put qualified_name on an entity selector");
    expect(instructions).toContain("core:search_text=>matches|subjects");
    expect(instructions).toContain("core:find_artifacts=>artifacts");
    expect(instructions).toContain("core:get_source=>sources");
    expect(instructions).toContain("core:resolve_symbol=>reference!:Text|context_artifact?:Text");
    expect(instructions).toContain("core:get_source=>subjects!:Sequence<SubjectSelector>|source!:SourceIncludeOptions");
    expect(instructions).toContain("discover_definitions.matcher={text:<non-empty string>,mode:exact|prefix|contains|semantic|hybrid}");
    expect(instructions).toContain("get_outline.container accepts only an artifact or entity selector");
    expect(queryTool?.description).toContain("get_outline.container accepts only an artifact or entity selector");
    expect(queryTool?.description).toContain("get_source requires source.mode, max_characters_per_snippet, max_total_characters, and context_lines");
    expect(queryTool?.description).toContain("search_text pipeline outputs are only matches and subjects, never artifacts");
    expect(contextTool?.description).toContain("definitions | implementations | callers | callees | dependencies | contracts | effects | tests | configuration | analogues | extension_points");
    expect(contextTool?.description).toContain("api_version: 3 is a required top-level field");
    expect(contextTool?.description).toContain("public_surfaces is an architecture view, not a context facet");
    expect(instructions).toContain("public_surfaces is an architecture view, not a core:build_context facet");
    expect(instructions).toContain("core:get_source source.mode is only signature, relevant, or body; never none");
    expect(instructions).toContain("A pipeline binding to a scalar argument requires exactly one upstream result");
    expect(instructions).toContain("Do not read source with grep, rg, find, ls, sed, cat, head, tail, or awk");
    expect(instructions).toContain("urdira_benchmark_discover");
  });

  it("teaches the public agent workflow without requiring pipelines", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Use urdira_query for a known subject or operation");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Use urdira_context for broad task discovery");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("it is not required before urdira_query");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("call once when query_scope is missing");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Narrow broad queries with an exact path, kind, context artifact, or returned entity id");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Continue with the exact cursor and the original scope");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Use Urdira before shell for scoped repository discovery and source reading");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Pipelines are optional");
  });

  it("registers the benchmark-only discovery projection without changing public tools", () => {
    const server = createUrdiraMcpServer({ client: { call: vi.fn(async () => success({})) } }, { benchmark_discover: true }) as unknown as { _registeredTools: Record<string, unknown> };
    expect(server._registeredTools["urdira_benchmark_discover"]).toBeDefined();
    expect(server._registeredTools["urdira_query"]).toBeDefined();
  });

  it("forwards monotonic MCP progress notifications and ignores stale progress", async () => {
    const notify = vi.fn();
    const call = vi.fn(async (_name: string, _payload: unknown, options?: LocalIpcRequestOptions) => {
      options?.on_progress?.({ phase: "query", completed: 1, total: 3, message: "first" });
      options?.on_progress?.({ phase: "query", completed: 0, total: 3, message: "stale" });
      options?.on_progress?.({ phase: "query", completed: 2, total: 3, message: "second" });
      return success({ result_sets: [] });
    });
    const server = createUrdiraMcpServer({ client: { call } }) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, context: unknown) => Promise<unknown> }>;
    };
    await server._registeredTools["urdira_query"]!.handler({
      request_type: "query",
      query: {
        api_version: 3,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: {} },
        options: { freshness: "snapshot", wait_timeout_ms: 0 },
      },
    }, { mcpReq: { _meta: { progressToken: "progress-1" }, signal: new AbortController().signal, notify } });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(([value]) => value.params.completed)).toEqual([1, 2]);
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

  it("keeps the agent profile unchanged while the web profile advertises and returns the structured page", async () => {
    const payload = { result_sets: [], page: { returned_items: 0, truncated: false } };
    const call = vi.fn(async () => success(payload));
    const agentServer = createUrdiraMcpServer({ client: { call } }) as unknown as {
      _registeredTools: Record<string, { outputSchema?: unknown; handler: (args: unknown, context: unknown) => Promise<Record<string, unknown>> }>;
    };
    const webServer = createUrdiraMcpServer({ client: { call } }, { presentation_profile: "web" }) as unknown as {
      _registeredTools: Record<string, { outputSchema?: unknown; handler: (args: unknown, context: unknown) => Promise<Record<string, unknown>> }>;
    };
    const args = { workspace_ids: ["workspace-1"] };
    const context = { mcpReq: { signal: new AbortController().signal, notify: vi.fn() } };

    const agentResult = await agentServer._registeredTools["urdira_index_status"]!.handler(args, context);
    const webResult = await webServer._registeredTools["urdira_index_status"]!.handler(args, context);

    expect(agentServer._registeredTools["urdira_index_status"]!.outputSchema).toBeUndefined();
    expect(agentResult["structuredContent"]).toBeUndefined();
    expect(webServer._registeredTools["urdira_index_status"]!.outputSchema).toBeDefined();
    expect(webResult["structuredContent"]).toEqual({ page: payload });
    expect(webResult["content"]).toEqual(agentResult["content"]);
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

    await tool(definitions, "urdira_analyze_change").invoke({ api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, target: { subject_type: "symbol", name: "PaymentService.capture" }, change: { change_type: "rename", new_name: "authorize" }, options: { freshness: "snapshot", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none" }, response_budget: { max_items: 10, max_characters: 10_000 } } });
    await tool(definitions, "urdira_build_context").invoke({ api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, task: "find the call path", facets: ["callers"], options: { freshness: "snapshot", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none" }, response_budget: { max_items: 10, max_characters: 10_000 } } });

    expect(call.mock.calls.map(([name]) => name)).toEqual(["core:query", "core:query"]);
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      expression: { expression_type: "operation", operation: "core:analyze_impact", arguments: { target: { subject_type: "symbol", name: "PaymentService.capture" }, change: { change_type: "rename", new_name: "authorize" } } },
      options: { response_budget: { max_items: 10, max_characters: 10_000 } },
    });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expression: { operation: "core:build_context", arguments: { task: "find the call path", facets: ["callers"] } } });
  });

  it("uses the query continuation call when the signed cursor form is supplied", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    await definition.invoke({ request_type: "continuation", continuation: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, cursor: "signed.cursor", response_budget: { max_items: 2, max_characters: 100 } } });
    expect(call).toHaveBeenCalledWith("core:query_continue", {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      cursor: "signed.cursor",
      response_budget: { max_items: 2, max_characters: 100 },
    }, expect.anything());
  });

  it("keeps index-status requests on the explicit status cursor model", async () => {
    const call = vi.fn(async (_name: string, payload: unknown) => success(payload));
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({
      request_type: "initial",
      api_version: 3,
      workspace_ids: [],
      include_capabilities: true,
      include_plugins: true,
      include_activation_issues: false,
      include_candidate_issues: false,
      response_budget: { max_items: 3, max_characters: 200 },
    });
    expect(call).toHaveBeenCalledWith("core:index_status", {
      request_type: "initial",
      api_version: 3,
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
    expect(call.mock.calls[1]?.[1]).toMatchObject({ api_version: 3, scope: { snapshot_id: "source-snapshot:7" } });
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

  /**
   * Frente Q-4 (2026-09-08): `core:compare`'s stream items are the SAME
   * flat `recordValue()` shape every other operation's `ResultSubject`
   * already uses (`subject_type`/`name`/`kind`/`path` at the TOP level),
   * plus the registry-documented `participant`/`change`/`move`/
   * `correlation` field layered on top -- decided (canonical-query-data-
   * port.ts's own doc comments, decision 25's Q-4 amendment) specifically
   * so the existing generic renderer (`describeBundle`, keyed off
   * `subject_type` at the top level) needs NO change to render these
   * streams legibly. This proves that decision empirically rather than by
   * doc-comment assertion alone: an "added" item (flat + `participant`)
   * and a "changed" item (flat, target-shaped, + a nested `change` object)
   * both render the entity's name/kind/path exactly like any other
   * operation's subject, with no raw `[object Object]`/undefined leakage.
   */
  it("renders core:compare's added/changed stream items legibly through the SAME generic renderer, no dedicated compare renderer needed", () => {
    const pageFor = (resultSet: string, primaryResult: Record<string, unknown>) => ({
      query_execution_id: "execution-compare-1",
      scope_kind: "comparison",
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: [{
        result_set: resultSet,
        confirmed: {
          classification: "confirmed", page_mode: "summary",
          result_bundles: [{ result_set: resultSet, primary_result: primaryResult, assessment: { classification: "confirmed", completeness: "complete" }, provenance_path: [], essential_related_entities: [], optional_source_snippets: [] }],
          total: 1, has_next: false, has_previous: false,
        },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false },
      }],
      expires_at: "2026-01-01T00:00:00.000Z",
      returned_items: 1,
      returned_characters: 0,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] },
      diagnostic_report: { total: 0, returned: 0, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics: [], has_more: false },
    });

    const addedResult = formatUrdiraResult(pageFor("added", {
      subject_type: "entity", record_id: "record:2", entity_id: "jsts:function:src/b.ts:1:sayHello", identity_key: "jsts:function:src/b.ts:1:sayHello",
      universal_kind: "core:function", kind: "jsts:entity_callable", classification: "confirmed", body: { name: "sayHello", kind: "function_declaration", path: "src/b.ts" },
      participant: "target",
    }));
    const addedText = addedResult.content.find((block): block is { type: "text"; text: string } => block.type === "text")!.text;
    expect(addedText).toContain("src/b.ts");
    expect(addedText).toContain("sayHello function_declaration");
    expect(addedText).not.toContain("[object Object]");

    const changedResult = formatUrdiraResult(pageFor("changed", {
      subject_type: "entity", record_id: "record:3", entity_id: "jsts:function:src/c.ts:1:farewell", identity_key: "jsts:function:src/c.ts:1:farewell",
      universal_kind: "core:function", kind: "jsts:entity_callable", classification: "confirmed", body: { name: "farewell", kind: "function_declaration", path: "src/c.ts" },
      change: {
        identity_key: "jsts:function:src/c.ts:1:farewell",
        before: { subject_type: "entity", record_id: "record:3-before", body: { name: "farewell", kind: "function_declaration", path: "src/c.ts" } },
        after: { subject_type: "entity", record_id: "record:3", body: { name: "farewell", kind: "function_declaration", path: "src/c.ts" } },
      },
    }));
    const changedText = changedResult.content.find((block): block is { type: "text"; text: string } => block.type === "text")!.text;
    expect(changedText).toContain("src/c.ts");
    expect(changedText).toContain("farewell function_declaration");
    expect(changedText).not.toContain("[object Object]");
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

  it("renders every line retained by the query response budget for a source bundle", () => {
    const snippet = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const textResult = formatUrdiraResult({
      query_execution_id: "execution-full-source",
      scope_kind: "single_workspace",
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: [{
        result_set: "sources",
        confirmed: {
          classification: "confirmed", page_mode: "summary",
          result_bundles: [{
            result_set: "sources",
            primary_result: { subject_type: "artifact", universal_kind: "core:artifact", kind: "core:source_file", body: { path: "src/complete.ts" } },
            assessment: { classification: "confirmed", completeness: "complete" },
            provenance_path: [], essential_related_entities: [],
            optional_source_snippets: [{ text: snippet, span: { artifact_version_id: "artv-complete", start_byte: "0", end_byte: String(snippet.length), start_line: "1", end_line: "20" }, truncated: false, redacted: false, redactions: [] }],
          }],
          total: 1, has_next: false, has_previous: false,
        },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false },
      }],
      expires_at: "2026-01-01T00:00:00.000Z",
      returned_items: 1,
      returned_characters: snippet.length,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] },
      diagnostic_report: { total: 0, returned: 0, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics: [], has_more: false },
    });
    const block = textResult.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text");
    expect(block?.text).toContain("    line 20");
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
      api_version: 3,
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
      api_version: 3,
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
    await tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_index_status").invoke({ request_type: "initial", api_version: 3, workspace_ids: [], include_capabilities: true, include_plugins: true, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 2, max_characters: 100 } }, { signal: controller.signal, onProgress: (event) => progress.push(event) });
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } }, options: { response_budget: { max_items: 7, max_characters: 1234 } } },
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
        api_version: 3,
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
        api_version: 3,
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

  it("teaches a new agent tool choice and dependent pipelines before the exhaustive catalog", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/^URDIRA AGENT QUICK START/u);
    expect(MCP_SERVER_INSTRUCTIONS).toContain("WHICH MCP TOOL SHOULD I CALL?");
    for (const toolName of MCP_TOOL_NAMES) expect(MCP_SERVER_INSTRUCTIONS).toContain(toolName);
    expect(MCP_SERVER_INSTRUCTIONS).toContain("PIPELINE MENTAL MODEL");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("bindings maps a downstream argument name to {stage_id, output}");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("The binding passes the complete typed upstream set");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Do not copy opaque ids out and send them back in a later MCP call");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("THREE-STAGE PIPELINE");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("resolve -> references -> source");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("If a scalar binding receives zero or multiple items");
    expect(MCP_SERVER_INSTRUCTIONS.indexOf("PIPELINE MENTAL MODEL")).toBeLessThan(MCP_SERVER_INSTRUCTIONS.indexOf("EXACT OPERATION CATALOG"));
  });

  it("puts essential pipeline semantics in the query tool and its advertised schema", () => {
    const definition = tool(createUrdiraToolDefinitions({ client: { call: vi.fn(async () => success({})) } }), "urdira_query");
    expect(definition.description).toContain("For dependent work, use one pipeline");
    expect(definition.description).toContain("bindings");
    expect(definition.description).toContain("complete upstream set");
    expect(definition.description).toContain("search -> source");

    const query = definition.input_schema.properties?.["query"] as { properties?: Record<string, unknown> };
    const expression = query.properties?.["expression"] as { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    const pipeline = expression.oneOf?.find((variant) => (variant.properties?.["expression_type"] as { const?: unknown })?.const === "pipeline");
    const stages = pipeline?.properties?.["stages"] as { description?: string; items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> } };
    const operationStage = stages.items?.oneOf?.find((variant) => variant.properties?.["operation"] !== undefined);
    expect(stages.description).toContain("topological order");
    expect((operationStage?.properties?.["arguments"] as { description?: string }).description).toContain("Static arguments only");
    expect((operationStage?.properties?.["bindings"] as { description?: string }).description).toContain("downstream argument name");
    expect((pipeline?.properties?.["outputs"] as { description?: string }).description).toContain("final streams");
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "price + tax" } } },
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text.match(/^MORE:/gm)).toHaveLength(1);
    expect(text).toContain(`"cursor":"${cursorValue}"`);
    expect(text).toContain('"request_type":"continuation"');
    expect(text).toContain('"scope":{"scope_type":"single_workspace","workspace_id":"workspace-1"}');
    expect(text).toContain('"response_budget":{"max_characters":20000,"max_items":50}');
    expect(text.split(cursorValue)).toHaveLength(2); // exactly one occurrence in the complete continuation request
  });

  it("renders a complete continuation for the web profile with the original scope and budget", () => {
    const cursor = "web.cursor.full.value";
    const result = formatUrdiraResult({
      returned_items: 1,
      result_sets: [{ result_set: "subjects", confirmed: { result_bundles: [{ primary_result: { subject_type: "artifact", body: { path: "src/a.ts" } }, assessment: { classification: "confirmed" } }], has_next: true, next_cursor: cursor }, possible: { result_bundles: [], has_next: false } }],
    }, {
      presentation_profile: "web",
      continuation_scope: { scope_type: "single_workspace", workspace_id: "web-workspace" },
      continuation_response_budget: { max_items: 3, max_characters: 900 },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain('"request_type":"continuation"');
    expect(text).toContain('"scope":{"scope_type":"single_workspace","workspace_id":"web-workspace"}');
    expect(text).toContain('"response_budget":{"max_characters":900,"max_items":3}');
    expect(text).toContain(`"cursor":"${cursor}"`);
    expect(result.structuredContent).toBeDefined();
  });

  it("does not emit an executable continuation with a fictitious scope", () => {
    const result = formatUrdiraResult({ returned_items: 1, result_sets: [{ result_set: "subjects", confirmed: { result_bundles: [{ primary_result: { body: { path: "src/a.ts" } }, assessment: { classification: "confirmed" } }], has_next: true, next_cursor: "cursor-without-scope" }, possible: { result_bundles: [], has_next: false } }] });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("continuation unavailable because the original query scope is not available");
    expect(text).not.toContain("<workspace_id>");
  });

  it("renders a TRUNCATED note with a dropped-item count when the response budget sheds bundles", async () => {
    const bigText = "x".repeat(500);
    const streams = { subjects: { items: Array.from({ length: 30 }, (_unused, index) => ({ stable_sort_key: String(index), value: { subject_type: "entity", record_id: `entity-${index}`, kind: "jsts:entity_type", body: { name: `Entity${index}`, path: `src/file-${index}.ts`, blob: bigText } } })), has_next: false, has_previous: false } };
    const call = vi.fn(async () => success({ query_execution_id: "execution-1", streams, completeness: { overall_status: "complete", dimensions: [] } }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: {
        api_version: 3,
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "NothingMatchesThis" } } },
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("coverage: partial (600 files affected)");
    expect(text).not.toContain("sha256:");
    expect(text.match(/coverage:/g)).toHaveLength(1);
  });

  // Plan 2026-09-06 (Frente S-A, §4.3): `semantic_coverage`'s raw
  // `SemanticCoverageView` renders as one `coverage: covered a/b · pending
  // · failed · excluded (set …; next: <cursor>)` line, never the generic
  // `compactPreview` fallback a non-bundle-shaped `primary_result` would
  // otherwise fall through to.
  it("renders semantic_coverage as one covered/pending/failed/excluded line naming the affected set and next cursor", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: {
        candidates: { items: [], has_next: false, has_previous: false },
        semantic_coverage: {
          items: [{
            value: {
              semantic_index_binding_id: "sha256:binding", materialization_state: "degraded",
              artifact_count: 14120, covered_artifact_count: 13980, pending_artifact_count: 90, excluded_artifact_count: 48, unsupported_artifact_count: 2, failed_artifact_count: 2,
              affected_artifact_count: 142, affected_artifact_set_id: "sha256:abcdef0123456789affectedsetid",
              affected_artifact_page: { affected_artifact_set_id: "sha256:abcdef0123456789affectedsetid", artifacts: [], total: 142, next_cursor: "eyJzZXQiOiJzaGEyNTY6YWJjZGVmMDEyMzQ1Njc4OSJ9", has_next: true, has_previous: false },
            },
            stable_sort_key: "unclassified sha256:binding",
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: "payment retry", query_class: "natural_text" } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("coverage: covered 13,980/14,120 · pending 90 · failed 2 · excluded 50");
    // Full, untruncated set id and cursor -- both are load-bearing arguments
    // for a following `core:semantic_affected_page` call, not display-only
    // ids, so (unlike every other id this renderer prints) they must never
    // be shortened with a "..." ellipsis.
    expect(text).toContain("set sha256:abcdef0123456789affectedsetid");
    expect(text).toContain("next: eyJzZXQiOiJzaGEyNTY6YWJjZGVmMDEyMzQ1Njc4OSJ9");
    expect(text.match(/coverage:/g)).toHaveLength(1);
  });

  // Plan 2026-09-06 (Frente S-A, §4.3): `core:semantic_affected_page`'s
  // single-item `SemanticAffectedArtifactPage` renders as a header plus one
  // `path (status: reason)` line per artifact, plus a MORE line naming the
  // continuation cursor when there is a next page.
  it("renders core:semantic_affected_page as one path (status: reason) line per affected document, with a MORE line for the next cursor", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-1",
      streams: {
        semantic_affected_artifacts: {
          items: [{
            value: {
              affected_artifact_set_id: "sha256:abcdef0123456789affectedsetid",
              artifacts: [
                { artifact_id: "art-a", artifact_version_id: "artv-a", display_path: "src/a.ts", coverage_status: "pending", reason_codes: ["pending_embed"], diagnostic_record_ids: [] },
                { artifact_id: "art-b", artifact_version_id: "artv-b", display_path: "src/b.ts", coverage_status: "excluded", reason_codes: ["oversized"], diagnostic_record_ids: [] },
              ],
              total: 3, next_cursor: "eyJzZXQiOiJzaGEyNTY6YWJjZGVmMDEyMzQ1Njc4OSJ9", has_next: true, has_previous: false,
            },
            stable_sort_key: "unclassified sha256:abcdef0123456789affectedsetid",
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:semantic_affected_page", arguments: { affected_artifact_set_id: "sha256:abcdef0123456789affectedsetid" } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("# 3 affected documents");
    expect(text).toContain("src/a.ts (pending: pending_embed)");
    expect(text).toContain("src/b.ts (excluded: oversized)");
    expect(text).toContain("MORE: call core:semantic_affected_page again");
    // Full, untruncated cursor -- a truncated base64url JSON blob can never
    // be decoded back into a valid {set, k, dir} object, so an agent copying
    // a shortened cursor could never actually continue paging.
    expect(text).toContain("cursor=eyJzZXQiOiJzaGEyNTY6YWJjZGVmMDEyMzQ1Njc4OSJ9");
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
    expect(text).toContain('query_scope={"scope_type":"single_workspace","workspace_id":"workspace-1"}');
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
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
        api_version: 3,
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
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } } },
    });
    const jsonBlock = result.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    const page = (JSON.parse(jsonBlock.text) as { page: { result_sets: Array<{ confirmed: Record<string, unknown> }> } }).page;
    expect(page.result_sets[0]?.confirmed["previous_cursor"]).toBeUndefined();
    expect(page.result_sets[0]?.confirmed["next_cursor"]).toBe("next.sig");
  });

  // Plan 2026-09-06 (Frente N, §5.1): inline one-line snippets attached by
  // the engine's SNIPPET_POLICY (`core:find_references`/`core:get_outline`/
  // `core:search_hybrid`/`core:search_semantic`) to bundles that never had a
  // preview at all before this plan. These fixtures mirror
  // `canonical-query-data-port.ts`'s `item()`/`semanticCandidateItem()`
  // output shape exactly: a flat `recordValue()` object plus a sibling
  // `optional_source_snippets` field, going through the same
  // `buildStreamResultSets` fallback-wrap path "preserves source snippets
  // when formatting the raw streams returned by a pipeline" (above)
  // exercises for `core:get_source`'s already-full bundle shape.
  it("renders a find_references reference's inline snippet as a compact one-line locator (\"| \" prefix, single line)", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-snippet-line",
      streams: {
        references: {
          items: [{
            stable_sort_key: "confirmed rel-1",
            value: {
              subject_type: "relation",
              record_id: "rel-1",
              universal_kind: "core:call",
              kind: "jsts:relation_call",
              classification: "confirmed",
              body: { path: "src/service.ts" },
              source_span: { artifact_version_id: "artv-1", start_byte: "800", end_byte: "812", start_line: "42", end_line: "42" },
              optional_source_snippets: [{ text: "  doStuff(x);", span: { artifact_version_id: "artv-1", start_byte: "798", end_byte: "812", start_line: "42", end_line: "42" }, truncated: false, redacted: false, redactions: [] }],
            },
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      // R14 (2026-09-08 benchmark, docs/evidence/2026-09-08-agent-benchmark-
      // inline-snippets.md): `snippet_lines` now defaults to 0 (opt-in), so
      // this test -- which exercises the compact-snippet rendering
      // mechanism itself -- opts in explicitly instead of relying on the
      // old default of 1.
      snippet_lines: 1,
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("src/service.ts:42");
    expect(text).toContain("    | doStuff(x);");
    // Compact style, unlike the search_text match style above: the locator
    // and the snippet are on separate lines, never joined with ": ".
    expect(text).not.toContain("src/service.ts:42: doStuff(x);");
    expect(text).not.toContain("optional_source_snippets");
  });

  // R14 (2026-09-08 benchmark, docs/evidence/2026-09-08-agent-benchmark-
  // inline-snippets.md, plan `generic-waddling-hartmanis.md` §0/§5.2): two
  // fresh runs of the text+policy benchmark arm with snippets ON both
  // missed task requirement 4 (the `restore.ts` allow-list) that the single
  // existing pre-snippets run of that arm got right, so `6/6 in both` did
  // not hold and R14's fallback applies -- `snippet_lines` now defaults to
  // 0 (opt-in) instead of 1. This test locks in that default: an ordinary
  // `urdira_query` call that never sets `snippet_lines` must render no
  // compact snippet line at all, even though the engine still attaches
  // `optional_source_snippets` per SNIPPET_POLICY.
  it("omits the inline compact snippet line by default (snippet_lines defaults to 0, R14)", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-snippet-default-off",
      streams: {
        references: {
          items: [{
            stable_sort_key: "confirmed rel-3",
            value: {
              subject_type: "relation",
              record_id: "rel-3",
              universal_kind: "core:call",
              kind: "jsts:relation_call",
              classification: "confirmed",
              body: { path: "src/service.ts" },
              source_span: { artifact_version_id: "artv-1", start_byte: "800", end_byte: "812", start_line: "42", end_line: "42" },
              optional_source_snippets: [{ text: "doStuff(x);", span: { artifact_version_id: "artv-1", start_byte: "798", end_byte: "812", start_line: "42", end_line: "42" }, truncated: false, redacted: false, redactions: [] }],
            },
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      // No `snippet_lines` field at all -- this is the ordinary agent call
      // shape and must fall back to the new default of 0.
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("src/service.ts:42");
    expect(text).not.toContain("    | ");
    expect(text).not.toContain("doStuff(x);");
  });

  it("renders a get_outline root member's inline snippet as its opening (signature) line", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-snippet-signature",
      streams: {
        members: {
          items: [{
            stable_sort_key: "confirmed entity-1",
            value: {
              subject_type: "entity",
              record_id: "entity-1",
              universal_kind: "core:function",
              kind: "jsts:entity_callable",
              classification: "confirmed",
              body: { name: "createTask", path: "src/task-service.ts" },
              source_span: { artifact_version_id: "artv-2", start_byte: "100", end_byte: "220", start_line: "10", end_line: "14" },
              optional_source_snippets: [{ text: "createTask(input: TaskInput): Task {", span: { artifact_version_id: "artv-2", start_byte: "100", end_byte: "137", start_line: "10", end_line: "10" }, truncated: false, redacted: false, redactions: [] }],
            },
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      // R14: opt in explicitly -- see the previous test's comment.
      snippet_lines: 1,
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:get_outline", arguments: { container: { subject_type: "artifact", path: "src/task-service.ts" } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("createTask");
    expect(text).toContain("    | createTask(input: TaskInput): Task {");
  });

  it("snippet_lines: 0 (hidden response_budget-adjacent option) disables the inline compact snippet line", async () => {
    const call = vi.fn(async () => success({
      query_execution_id: "execution-snippet-disabled",
      streams: {
        references: {
          items: [{
            stable_sort_key: "confirmed rel-2",
            value: {
              subject_type: "relation",
              record_id: "rel-2",
              universal_kind: "core:call",
              kind: "jsts:relation_call",
              classification: "confirmed",
              body: { path: "src/service.ts" },
              source_span: { artifact_version_id: "artv-1", start_byte: "800", end_byte: "812", start_line: "42", end_line: "42" },
              optional_source_snippets: [{ text: "doStuff(x);", span: { artifact_version_id: "artv-1", start_byte: "798", end_byte: "812", start_line: "42", end_line: "42" }, truncated: false, redacted: false, redactions: [] }],
            },
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      snippet_lines: 0,
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } } },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toContain("src/service.ts:42");
    expect(text).not.toContain("    | ");
    expect(text).not.toContain("doStuff(x);");
  });

  it("sheds inline compact snippets before dropping whole find_references bundles under a tight response budget", async () => {
    const streams = {
      references: {
        items: Array.from({ length: 20 }, (_unused, index) => ({
          stable_sort_key: String(index),
          value: {
            subject_type: "relation",
            record_id: `rel-${index}`,
            universal_kind: "core:call",
            kind: "jsts:relation_call",
            classification: "confirmed",
            body: { path: `src/file-${index}.ts` },
            source_span: { artifact_version_id: `artv-${index}`, start_byte: "0", end_byte: "10", start_line: "1", end_line: "1" },
            optional_source_snippets: [{ text: `callSiteNumber${index}();`, span: { artifact_version_id: `artv-${index}`, start_byte: "0", end_byte: "10", start_line: "1", end_line: "1" }, truncated: false, redacted: false, redactions: [] }],
          },
        })),
        has_next: false, has_previous: false,
      },
    };
    const call = vi.fn(async () => success({ query_execution_id: "execution-shed-snippets", streams, completeness: { overall_status: "complete", dimensions: [] } }));
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const result = await definition.invoke({
      request_type: "query",
      // R14: opt in explicitly so this test still exercises snippet
      // shedding under a tight budget rather than vacuously passing
      // because no snippet line was ever requested.
      snippet_lines: 1,
      query: {
        api_version: 3,
        scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
        expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } },
        options: { response_budget: { max_characters: 300 } },
      },
    });
    const text = (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(text).toMatch(/^TRUNCATED: dropped \d+ items? \(response_budget\)$/m);
    // `shedToBudget` trims every bundle's `optional_source_snippets` in one
    // unconditional pass BEFORE it ever drops a whole bundle from the tail
    // -- so reaching whole-bundle dropping (asserted below) proves every
    // surviving bundle's compact snippet line is already gone.
    expect(text).not.toContain("    | ");
    expect(text).not.toContain("callSiteNumber");
    expect(text).not.toContain("src/file-19.ts");
  });

  it("renders identical compact-snippet text for two identical invocations (deterministic)", async () => {
    const buildPayload = () => success({
      query_execution_id: "execution-determinism",
      streams: {
        references: {
          items: [{
            stable_sort_key: "confirmed rel-1",
            value: {
              subject_type: "relation",
              record_id: "rel-1",
              universal_kind: "core:call",
              kind: "jsts:relation_call",
              classification: "confirmed",
              body: { path: "src/service.ts" },
              source_span: { artifact_version_id: "artv-1", start_byte: "800", end_byte: "812", start_line: "42", end_line: "42" },
              optional_source_snippets: [{ text: "doStuff(x);", span: { artifact_version_id: "artv-1", start_byte: "798", end_byte: "812", start_line: "42", end_line: "42" }, truncated: false, redacted: false, redactions: [] }],
            },
          }],
          has_next: false, has_previous: false,
        },
      },
      completeness: { overall_status: "complete", dimensions: [] },
    });
    const call = vi.fn(async () => buildPayload());
    const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
    const args = {
      request_type: "query",
      // R14: opt in explicitly -- see the first snippet test's comment.
      snippet_lines: 1,
      query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace-1" }, expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } } },
    };
    const first = await definition.invoke(args);
    const second = await definition.invoke(args);
    const firstText = (first.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    const secondText = (second.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    expect(firstText).toBe(secondText);
    expect(firstText).toContain("    | doStuff(x);");
  });

  // Adversarial review 2026-09-06 (task item 1): the exact case named in the
  // review brief -- 50 bundles, each carrying a 200-character snippet (50 x
  // 200 = 10,000 chars, R13's own "50 x 200 = 10k < 20k" arithmetic), under
  // a tight `max_characters: 6000` that forces BOTH shedding stages (first
  // every bundle's snippet, then whole trailing bundles) to fire in one
  // request, not just one or the other. Confirms: (a) the final text fits
  // the budget, (b) `TRUNCATED` reflects the real dropped-item count and
  // recomputes deterministically, and (c) two identical calls produce byte-
  // identical text (no ordering/Map-iteration nondeterminism creeping in
  // once both shedding stages are exercised together).
  it("50 bundles x 200-char snippets under max_characters:6000 sheds snippets then whole bundles, and stays deterministic", async () => {
    // A real 200-character source line is not mostly whitespace, so the
    // fixture snippet below fills its full 200 characters with visible
    // content -- `formatDescriptorLine`'s compact-snippet branch trims each
    // line, and trailing spaces (an earlier draft of this test used
    // `" ".repeat(...)` padding) would silently trim away almost the whole
    // fixture, defeating the "50 x 200 = 10k" case entirely. The path is
    // realistically long (a deep monorepo path, not `src/file-N.ts`) so that
    // even after every snippet is shed (stage 1), the 50 bare descriptor
    // lines alone still exceed `max_characters: 6000` -- forcing stage 2
    // (whole-bundle dropping) to also fire in the same request, which is
    // the actual point of this test (verified empirically below, not just
    // asserted by construction).
    const pathFor = (index: number): string => `src/apps/web/src/components/workspace/panels/dashboard/deeply/nested/sibling/module/group/file-${index}.ts`;
    const snippetFor = (index: number): string => `callSiteNumber${index}_${"x".repeat(200)}`.slice(0, 200);
    const buildStreams = () => ({
      references: {
        items: Array.from({ length: 50 }, (_unused, index) => ({
          stable_sort_key: String(index).padStart(3, "0"),
          value: {
            subject_type: "relation",
            record_id: `rel-${index}`,
            universal_kind: "core:call",
            kind: "jsts:relation_call",
            classification: "confirmed",
            body: { path: pathFor(index) },
            source_span: { artifact_version_id: `artv-${index}`, start_byte: "0", end_byte: "10", start_line: "1", end_line: "1" },
            optional_source_snippets: [{ text: snippetFor(index), span: { artifact_version_id: `artv-${index}`, start_byte: "0", end_byte: "10", start_line: "1", end_line: "1" }, truncated: false, redacted: false, redactions: [] }],
          },
        })),
        has_next: false, has_previous: false,
      },
    });
    // Every fixture snippet is exactly 200 characters, all visible (no
    // trailing whitespace to be trimmed away) -- the literal "50 x 200 =
    // 10k" case R13/the review brief describe.
    expect(buildStreams().references.items.every((item) => item.value.optional_source_snippets[0]!.text.length === 200)).toBe(true);

    const invokeOnce = async (options?: { readonly maxCharacters?: number; readonly snippetLines?: number }): Promise<string> => {
      const call = vi.fn(async () => success({ query_execution_id: "execution-50x200", streams: buildStreams(), completeness: { overall_status: "complete", dimensions: [] } }));
      const definition = tool(createUrdiraToolDefinitions({ client: { call } }), "urdira_query");
      const result = await definition.invoke({
        request_type: "query",
        ...(options?.snippetLines === undefined ? {} : { snippet_lines: options.snippetLines }),
        query: {
          api_version: 3,
          scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
          expression: { expression_type: "operation", operation: "core:find_references", arguments: { target: { subject_type: "symbol", name: "doStuff" } } },
          ...(options?.maxCharacters === undefined ? {} : { options: { response_budget: { max_characters: options.maxCharacters } } }),
        },
      });
      return (result.content.find((block): block is { type: "text"; text: string } => block.type === "text"))!.text;
    };

    // Empirical preconditions (not assumed): (1) fully unbudgeted, all 50
    // snippets rendered, must exceed 6000 -- otherwise this isn't a
    // shedding case at all; (2) even with every snippet line suppressed
    // (`snippet_lines: 0` -- the same final byte shape as `shedToBudget`'s
    // stage-1 snippet strip, since the renderer treats both identically:
    // `formatDescriptorLine` never emits a "    | " line when there is
    // nothing to show), the 50 bare descriptor lines alone must ALSO
    // exceed 6000 -- otherwise stage 1 alone would already satisfy the
    // budget and stage 2 (whole-bundle dropping) would never fire.
    // R14: opt in explicitly on every call that needs snippets rendered --
    // `snippet_lines` now defaults to 0, so omitting it here would make
    // `unbudgeted` and `bareDescriptorsOnly` identical by construction
    // rather than by the shedding logic this test exists to exercise.
    const unbudgeted = await invokeOnce({ snippetLines: 1 });
    const bareDescriptorsOnly = await invokeOnce({ snippetLines: 0 });
    expect(unbudgeted.length).toBeGreaterThan(6000);
    expect(bareDescriptorsOnly.length).toBeGreaterThan(6000);

    const first = await invokeOnce({ snippetLines: 1, maxCharacters: 6000 });
    const second = await invokeOnce({ snippetLines: 1, maxCharacters: 6000 });

    // (a) Fits the budget.
    expect(first.length).toBeLessThanOrEqual(6000);
    // (c) Deterministic: identical input, byte-identical output, both calls.
    expect(first).toBe(second);
    // (b) Both shedding stages fired: EVERY snippet is gone (stage 1) AND
    // at least one whole bundle was dropped from the tail (stage 2) -- the
    // empirical preconditions above prove stage 1 alone could not have
    // been enough.
    expect(first).not.toContain("    | ");
    expect(first).not.toContain("callSiteNumber");
    const truncationMatch = /^TRUNCATED: dropped (\d+) items? \(response_budget\)$/m.exec(first);
    expect(truncationMatch).not.toBeNull();
    const droppedCount = Number(truncationMatch![1]);
    expect(droppedCount).toBeGreaterThan(0);
    expect(droppedCount).toBeLessThan(50);
    // The surviving reference count (50 - dropped) matches how many
    // locator lines actually remain in the text -- `TRUNCATED`'s count and
    // the real rendered content agree exactly, and this is recomputed
    // fresh each call (not a stale count carried over), which is exactly
    // why (c)'s determinism check above matters.
    const locatorPattern = /file-(\d+)\.ts/g;
    const survivingIndices = [...first.matchAll(locatorPattern)].map((match) => Number(match[1]));
    expect(survivingIndices.length).toBe(50 - droppedCount);
    // Whole bundles are dropped from the TAIL (highest index first): the
    // surviving set is exactly the first (50 - droppedCount) items, in
    // order -- never a scattered subset.
    expect(survivingIndices).toEqual(Array.from({ length: survivingIndices.length }, (_unused, index) => index));
  });
});
