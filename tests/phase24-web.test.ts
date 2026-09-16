import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startUrdiraWeb, type UrdiraWebHandle } from "../packages/web/src/server/index.js";
import { graphDataFromPage } from "../packages/web/src/client/graph-data.js";
import { buildOperationRequest, buildSearchRequest } from "../packages/web/src/client/query.js";
import { resolveThemePreference, toggledTheme } from "../packages/web/src/client/theme.js";
import { operationAvailability, shouldUseRetainedSnapshot, workspaceHealthIssue, workspaceV4Lanes } from "../packages/web/src/client/workspace-health.js";
import {
  initialSchemaValue,
  parseMcpRequest,
  selectSchemaVariant,
  updateRequestPath,
  validateMcpRequest,
} from "../packages/web/src/client/mcp-request-schema.js";
import { nextQueryCursor, queryChoices } from "../packages/web/src/client/query-choices.js";
import {
  humanizeKind,
  pageNavigation,
  presentResultPage,
  symbolSelectorForChoice,
} from "../packages/web/src/client/result-presentation.js";
import {
  disambiguateChoices,
  filterChoices,
  groupPresentationItems,
  isGeneratedArtifactPath,
  structuredCollectionLayout,
  visibleArtifactChoices,
} from "../packages/web/src/client/presentation.js";
import { createUrdiraToolDefinitions } from "../packages/mcp/src/index.js";
import { CLI_COMMAND_CATALOG } from "../packages/cli/src/index.js";
import { cliFieldChoices, visibleCliOptions } from "../packages/web/src/client/cli-form.js";
import { pipelineMcpExamples, pipelinePresentation } from "../packages/web/src/client/mcp-pipeline-examples.js";

const handles: UrdiraWebHandle[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map((handle) => handle.close())); });

describe("local Urdira web composition", () => {
  it("resolves and toggles a persistent light or dark interface theme", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
    expect(resolveThemePreference(null, true)).toBe("dark");
    expect(resolveThemePreference("unsupported", false)).toBe("light");
    expect(toggledTheme("light")).toBe("dark");
    expect(toggledTheme("dark")).toBe("light");
  });

  it("builds graph data only from structured entities and relations", () => {
    const graph = graphDataFromPage({
      result_sets: [{
        confirmed: {
          result_bundles: [{
            primary_result: {
              body: {
                subjects: [
                  { entity_id: "entity:controller", name: "UserController", kind: "class", path: "src/user-controller.ts", source_span: { start_line: 10 } },
                  { entity_id: "entity:service", name: "UserService", kind: "class", path: "src/user-service.ts", source_span: { start_line: 24 } },
                ],
                relation_kinds: ["calls"],
              },
            },
          }, {
            primary_result: {
              body: {
                subjects: [
                  { entity_id: "entity:controller", name: "UserController", kind: "class", path: "src/user-controller.ts" },
                  { entity_id: "entity:service", name: "UserService", kind: "class", path: "src/user-service.ts" },
                ],
                relation_kinds: ["jsts:relation_calls"],
              },
            },
          }, {
            primary_result: { body: { summary: "entity:fake calls entity:other" } },
          }],
        },
      }],
    }, "entity:root");

    expect(graph.edges).toEqual([expect.objectContaining({ source: "entity:controller", target: "entity:service", label: "Calls", classification: "confirmed", sourceLabel: "UserController", targetLabel: "UserService" })]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["entity:root", "entity:controller", "entity:service"]);
    expect(graph.nodes.map((node) => node.label)).toEqual(["root", "UserController", "UserService"]);
    expect(graph.nodes[1]).toMatchObject({ kind: "Class", path: "src/user-controller.ts", line: 10 });
  });

  it("normalizes generic container records to the same readable graph relation", () => {
    const graph = graphDataFromPage({ result_sets: [{ confirmed: { result_bundles: [{
      primary_result: { body: { subjects: [{ entity_id: "entity:fn", name: "run" }, { entity_id: "entity:file", name: "main.ts" }], relation_kinds: ["contains"] } },
    }, {
      primary_result: { kind: "jsts:entity_container", body: { source: { entity_id: "entity:fn", name: "run" }, target: { entity_id: "entity:file", name: "main.ts" } } },
    }] } }] }, "");
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.label).toBe("Contains");
  });

  it("builds contract-valid lexical, semantic, and hybrid requests with object freshness", async () => {
    const calls: Array<{ readonly call: string; readonly payload: unknown }> = [];
    const queryTool = createUrdiraToolDefinitions({
      client: {
        call: async (call, payload) => {
          calls.push({ call, payload });
          return { protocol_version: 1, request_id: "request", outcome: "success" as const, payload: { streams: {}, completeness: { overall_status: "complete", dimensions: [] }, diagnostics: [] } };
        },
      },
    }, { presentation_profile: "web" }).find((tool) => tool.name === "urdira_query");
    if (!queryTool) throw new Error("urdira_query is not registered");

    const requests = (["lexical", "semantic", "hybrid"] as const).map((mode) => buildSearchRequest("workspace:urdira:test", mode, "daemon compatibility"));
    for (const request of requests) await queryTool.invoke(request);

    expect(calls.map((entry) => (entry.payload as { expression: { operation: string } }).expression.operation)).toEqual(["core:search_text", "core:search_semantic", "core:search_hybrid"]);
    expect(requests.map((entry) => ((entry.query as { options: { freshness: unknown } }).options.freshness))).toEqual([
      { mode: "wait", required_frontier: "source", timeout_ms: 30_000 },
      { mode: "wait", required_frontier: "semantic", timeout_ms: 30_000 },
      { mode: "wait", required_frontier: "semantic", timeout_ms: 30_000 },
    ]);
  });

  it("uses the retained current snapshot when a failed scan leaves queryable stale data", () => {
    const request = buildOperationRequest("workspace:urdira:test", "core:find_artifacts", {}, 30_000, "current");
    expect((request.query as { options: { freshness: unknown } }).options.freshness).toEqual({
      mode: "current",
      required_frontier: "source",
      timeout_ms: 30_000,
    });
  });

  it("turns scan failures and operation blocks into actionable interface state", () => {
    const workspace = {
      status: "degraded",
      current_snapshot_id: "snapshot:retained",
      last_scan_error: "storage:immutable_workspace",
      index_status: {
        operation_availability: {
          available_now: ["core:find_artifacts"],
          blocked: [{ operation: "core:search_semantic", reason_code: "core:structural_stage_in_progress" }],
        },
      },
    };
    expect(workspaceHealthIssue(workspace)).toMatchObject({
      title: "The latest scan was rejected",
      technical_code: "storage:immutable_workspace",
      action: "reindex",
    });
    expect(operationAvailability(workspace, "core:find_artifacts")).toEqual({ available: true });
    expect(operationAvailability(workspace, "core:search_semantic")).toEqual({
      available: false,
      reason_code: "core:structural_stage_in_progress",
      message: "Structural indexing has not finished, so this operation is not available yet.",
    });
    expect(shouldUseRetainedSnapshot(workspace)).toBe(true);
  });

  it("distinguishes a periodic update check from real indexing", () => {
    expect(workspaceHealthIssue({ status: "indexing", indexing_activity: "checking_for_updates" })).toEqual({
      tone: "warning",
      title: "Checking for updates",
      message: "Urdira is verifying that the watcher and published snapshot are still aligned. Queries continue using the current snapshot.",
      action: "none",
    });
    expect(workspaceHealthIssue({ status: "indexing", indexing_activity: "indexing" })).toMatchObject({ title: "Indexing is in progress" });
  });

  // P4-d: `workspaceV4Lanes` projects `core:index_status`'s additive v4
  // lane fields (`v4StatusFields`, `packages/daemon/src/runtime.ts`) into
  // the small shape the workspace card renders -- generations, a
  // current/lagging flag per lane, and the last scan's kind/paths/wall time
  // plus its queryable/durable timeline milestones.
  it("projects a v4 workspace's lane generations and last-scan timeline", () => {
    const lanes = workspaceV4Lanes({
      storage_format: "v4",
      structural: { queryable_generation: 7, durable_generation: 6, queryable: true },
      lexical: { completed_generation: 5, current: false },
      semantic: { current: false },
      last_scan: { kind: "changed", changed_paths: 3, timings: { total_ms: 940 }, timeline: { queryable_at: 120, completed_at: 180 } },
    });
    expect(lanes).toEqual({
      structural: { generation_label: "q7/d6", current: true },
      lexical: { generation_label: "5", current: false },
      semantic: { generation_label: "-", current: false },
      last_scan: { kind: "changed", changed_paths: 3, wall_ms: 940, queryable_at_ms: 120, completed_at_ms: 180 },
    });
  });

  // A v3 workspace's `index_status` never sets `storage_format: "v4"` (a v3
  // payload either omits `storage_format` entirely on an older cached
  // response, or carries `"v3"`) -- `workspaceV4Lanes` must return
  // `undefined` for both, so the card renders no v4 lane block at all.
  it("returns undefined for a v3 workspace (and for a missing index_status)", () => {
    expect(workspaceV4Lanes({ storage_format: "v3", structural_ready: true })).toBeUndefined();
    expect(workspaceV4Lanes({})).toBeUndefined();
    expect(workspaceV4Lanes(undefined)).toBeUndefined();
  });

  it("builds and synchronizes MCP requests from advertised JSON schemas", () => {
    const schema = {
      type: "object",
      properties: {
        request_type: { type: "string", enum: ["query", "continuation"] },
        query: {
          type: "object",
          properties: {
            api_version: { type: "integer", const: 3 },
            expression: {
              oneOf: [
                { type: "object", properties: { expression_type: { type: "string", const: "operation" }, operation: { type: "string", enum: ["core:find_artifacts", "core:search_text"] }, arguments: { type: "object" } }, required: ["expression_type", "operation", "arguments"] },
                { type: "object", properties: { expression_type: { type: "string", const: "recipe" }, recipe_id: { type: "string", enum: ["core:trace_behavior"] }, arguments: { type: "object" } }, required: ["expression_type", "recipe_id", "arguments"] },
              ],
            },
          },
          required: ["api_version", "expression"],
        },
      },
      required: ["request_type", "query"],
    };
    const value = initialSchemaValue(schema) as Record<string, unknown>;
    expect(value).toEqual({ request_type: "query", query: { api_version: 3, expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: {} } } });
    expect(selectSchemaVariant((schema.properties.query.properties.expression as { oneOf: unknown[] }), { expression_type: "recipe" })).toBe(1);
    const updated = updateRequestPath(value, ["query", "expression", "operation"], "core:search_text") as Record<string, unknown>;
    expect((((updated["query"] as Record<string, unknown>)["expression"] as Record<string, unknown>)["operation"])).toBe("core:search_text");
    expect(parseMcpRequest(JSON.stringify(updated))).toEqual(updated);
    expect(() => parseMcpRequest("[]")).toThrow("top-level JSON object");
    expect(validateMcpRequest(updated, schema)).toEqual([]);
    expect(validateMcpRequest({ request_type: "invalid" }, schema)).toEqual(expect.arrayContaining([expect.stringContaining("must be one of"), expect.stringContaining("query is required")]));
  });

  it("advertises closed CLI values and renders them as useful selectors", () => {
    const install = CLI_COMMAND_CATALOG.find((entry) => entry.command === "agent-install");
    if (!install) throw new Error("agent-install is not registered");
    const schema = install.input_schema as { properties: { options: { properties: Record<string, { enum?: string[] }> } } };
    expect(schema.properties.options.properties["client"]?.enum).toEqual([
      "all", "claude-code", "codex", "opencode", "cursor", "vscode", "cline", "roo", "claude-desktop",
    ]);
    expect(schema.properties.options.properties["scope"]?.enum).toEqual(["user"]);

    expect(cliFieldChoices("client", install, [], []).map((choice) => [choice.value, choice.label])).toEqual([
      ["all", "All supported clients"],
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["opencode", "OpenCode"],
      ["cursor", "Cursor"],
      ["vscode", "VS Code / GitHub Copilot"],
      ["cline", "Cline"],
      ["roo", "Roo Code"],
      ["claude-desktop", "Claude Desktop"],
    ]);
    expect(cliFieldChoices("scope", install, [], []).map((choice) => choice.value)).toEqual(["user"]);
    expect(visibleCliOptions(install)).not.toContain("proposal-id");

    const add = CLI_COMMAND_CATALOG.find((entry) => entry.command === "workspace-add");
    const exportPack = CLI_COMMAND_CATALOG.find((entry) => entry.command === "index-pack-export");
    if (!add || !exportPack) throw new Error("workspace commands are not registered");
    expect(visibleCliOptions(add)).not.toContain("path");
    expect(visibleCliOptions(exportPack)).not.toEqual(expect.arrayContaining(["workspace", "out"]));
  });

  it("offers contract-valid dependent MCP pipelines with readable data flow", () => {
    const examples = pipelineMcpExamples("workspace:urdira:test");
    expect(examples.map((example) => example.id)).toEqual(["search-to-source", "resolve-to-references"]);
    expect(examples[0]?.bindings).toEqual([{
      from_stage: "search",
      output: "subjects",
      to_stage: "source",
      argument: "subjects",
      explanation: "Every subject found by the search becomes source input without copying identifiers by hand.",
    }]);
    expect(pipelinePresentation(examples[0]!.request)).toEqual({
      stages: [
        { stage_id: "search", operation: "core:search_text", label: "Search text" },
        { stage_id: "source", operation: "core:get_source", label: "Get source" },
      ],
      bindings: [{ from_stage: "search", output: "subjects", to_stage: "source", argument: "subjects" }],
      outputs: [{ name: "sources", stage_id: "source", output: "sources" }],
    });

    const queryTool = createUrdiraToolDefinitions({
      client: { call: async () => ({ protocol_version: 1, request_id: "request", outcome: "success" as const, payload: { streams: {}, completeness: { overall_status: "complete", dimensions: [] }, diagnostics: [] } }) },
    }, { presentation_profile: "web" }).find((tool) => tool.name === "urdira_query");
    if (!queryTool) throw new Error("urdira_query is not registered");
    for (const example of examples) expect(validateMcpRequest(example.request, queryTool.input_schema)).toEqual([]);
  });

  it("derives selectable files and symbols from structured query results", () => {
    const result = { structuredContent: { page: { result_sets: [{ confirmed: { has_next: true, next_cursor: "cursor:next", result_bundles: [
      { primary_result: { path: "src/app.ts", body: { path: "src/app.ts" } } },
      { primary_result: { source_span: { start_byte: 120, start_line: 8 }, body: { path: "src/app.ts", name: "App", qualified_name: "src/app.ts.App", kind: "function" } } },
    ] }, possible: { result_bundles: [] } }] } } };
    expect(queryChoices(result, "artifact")).toEqual([{ value: "src/app.ts", label: "src/app.ts" }]);
    expect(queryChoices(result, "symbol")).toEqual([{
      value: "src/app.ts.App@src/app.ts:120",
      label: "App · function",
      context: "src/app.ts:8",
      kind: "function",
      line: 8,
      name: "App",
      path: "src/app.ts",
      qualifiedName: "src/app.ts.App",
      startByte: 120,
    }]);
    expect(nextQueryCursor(result)).toBe("cursor:next");
  });

  it("builds an exact contextual symbol selector from the selected indexed choice", () => {
    expect(symbolSelectorForChoice({
      value: "run",
      label: "run · variable — src/main.ts:42",
      name: "run",
      path: "src/main.ts",
      startByte: 900,
      line: 42,
      kind: "variable",
    })).toEqual({
      subject_type: "symbol",
      name: "run",
      context_artifact: "src/main.ts",
      context_byte_offset: 900,
    });
  });

  it("keeps same-name declarations as distinct selectable symbols by source occurrence", () => {
    const result = { structuredContent: { page: { result_sets: [{ confirmed: { result_bundles: [
      { primary_result: { body: { path: "src/main.ts", name: "run", qualified_name: "src/main.ts.run", kind: "variable", start: "100", start_line: "10" } } },
      { primary_result: { body: { path: "src/main.ts", name: "run", qualified_name: "src/main.ts.run", kind: "variable", start: "900", start_line: "42" } } },
    ] }, possible: { result_bundles: [] } }] } } };
    const choices = queryChoices(result, "symbol");
    expect(choices).toHaveLength(2);
    expect(choices.map((choice) => choice.label)).toEqual([
      "run · variable — src/main.ts:10",
      "run · variable — src/main.ts:42",
    ]);
    expect(choices.map((choice) => choice.startByte)).toEqual([100, 900]);
  });

  it("derives human result labels, locations, snippets, groups, and technical identifiers", () => {
    const page = {
      returned_items: 1,
      result_sets: [{
        result_set: "members",
        confirmed: {
          total: 1,
          has_next: false,
          has_previous: false,
          result_bundles: [{
            assessment: { classification: "confirmed", completeness: "complete" },
            primary_result: {
              entity_id: "entity:opaque-value",
              universal_kind: "core:callable",
              source_span: { start_line: "42", end_line: "43", start_byte: "900" },
              body: { name: "administrativeState", kind: "function", path: "packages/engine/src/git-providers.ts" },
            },
            optional_source_snippets: [{ text: "export async function administrativeState()", span: { start_line: 42 } }],
          }],
        },
        possible: { total: 0, has_next: false, has_previous: false, result_bundles: [] },
      }],
    };
    const presented = presentResultPage(page, "core:get_outline");
    expect(presented.groups).toHaveLength(1);
    expect(presented.groups[0]?.label).toBe("Members");
    expect(presented.groups[0]?.items[0]).toMatchObject({
      title: "administrativeState",
      kind: "Function",
      path: "packages/engine/src/git-providers.ts",
      line: 42,
      endLine: 43,
      snippet: "export async function administrativeState()",
    });
    expect(presented.groups[0]?.items[0]?.technicalIds).toContain("entity:opaque-value");
    expect(humanizeKind("core:artifact")).toBe("File");
    expect(humanizeKind("core:callable")).toBe("Function");
  });

  it("reports total results and bidirectional cursors independently of truncation", () => {
    expect(pageNavigation({
      returned_items: 50,
      truncation: { truncated: false },
      result_sets: [{
        result_set: "candidates",
        confirmed: { total: 120, has_next: true, next_cursor: "cursor:next", has_previous: true, previous_cursor: "cursor:previous", result_bundles: [] },
        possible: { total: 8, has_next: false, has_previous: false, result_bundles: [] },
      }],
    })).toEqual({
      hasNext: true,
      hasPrevious: true,
      nextCursor: "cursor:next",
      previousCursor: "cursor:previous",
      returned: 50,
      total: 128,
    });
    expect(pageNavigation({ returned_items: 1, result_sets: [] }, true)).toMatchObject({
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("keeps generated build output out of primary browsing choices", () => {
    expect(isGeneratedArtifactPath(".typecheck/tests/app.js")).toBe(true);
    expect(isGeneratedArtifactPath("tests/fixtures/rust/target/debug/app")).toBe(true);
    expect(isGeneratedArtifactPath("coverage/index.html")).toBe(true);
    expect(isGeneratedArtifactPath("release/artifacts/staging/darwin-x64/bin/urdira.mjs")).toBe(true);
    expect(isGeneratedArtifactPath("packages/web/src/client/main.tsx")).toBe(false);
    expect(visibleArtifactChoices([
      { value: ".typecheck/tests/app.js", label: ".typecheck/tests/app.js" },
      { value: "packages/web/src/client/main.tsx", label: "packages/web/src/client/main.tsx" },
    ])).toEqual([{ value: "packages/web/src/client/main.tsx", label: "packages/web/src/client/main.tsx" }]);
  });

  it("filters long selectable lists and disambiguates duplicate labels", () => {
    const choices = disambiguateChoices([
      { value: "src/a.ts.status", label: "status · variable", context: "src/a.ts.status" },
      { value: "src/b.ts.status", label: "status · variable", context: "src/b.ts.status" },
      { value: "src/app.ts.App", label: "App · function", context: "src/app.ts.App" },
    ]);
    expect(choices.map((choice) => choice.label)).toEqual([
      "status · variable — src/a.ts.status",
      "status · variable — src/b.ts.status",
      "App · function",
    ]);
    expect(filterChoices(choices, "b.ts status", 20).map((choice) => choice.value)).toEqual(["src/b.ts.status"]);
  });

  it("uses readable cards for wide or nested structured collections", () => {
    expect(structuredCollectionLayout([{ name: "one", status: "ready" }])).toBe("table");
    expect(structuredCollectionLayout([{ one: 1, two: 2, three: 3, four: 4, five: 5 }])).toBe("cards");
    expect(structuredCollectionLayout([{ name: "one", capabilities: [{ name: "syntax" }] }])).toBe("cards");
  });

  it("groups visually identical result cards without discarding raw matches", () => {
    expect(groupPresentationItems([
      { id: "one", path: "src/app.ts" },
      { id: "two", path: "src/app.ts" },
      { id: "three", path: "src/other.ts" },
    ], (entry) => entry.path)).toEqual([
      { item: { id: "one", path: "src/app.ts" }, count: 2 },
      { item: { id: "three", path: "src/other.ts" }, count: 1 },
    ]);
  });

  it("binds loopback, serves the local API without a token, rejects foreign origins, and lists directories without files", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-web-"));
    await mkdir(join(root, "folder"));
    const handle = await startUrdiraWeb({ client: { call: vi.fn(async () => ({ protocol_version: 1, request_id: "r", outcome: "success" as const, payload: {} })) }, run_cli: vi.fn(async () => ({ exit_code: 0, data: {}, stdout: "{}\n" })), initial_directory: root });
    handles.push(handle);
    expect(new URL(handle.origin).hostname).toBe("127.0.0.1");
    expect(handle.url).toBe(`${handle.origin}/`);
    await expect(fetch(`${handle.origin}/api/v1/cli/commands`)).resolves.toMatchObject({ status: 200 });
    await expect(fetch(`${handle.origin}/api/v1/cli/commands`, { headers: { origin: "https://example.test" } })).resolves.toMatchObject({ status: 403 });
    const directories = await fetch(`${handle.origin}/api/v1/directories`).then((response) => response.json()) as { directories: { name: string; path: string }[] };
    expect(directories.directories.map((entry) => entry.name)).toEqual(["folder"]);
    expect(directories.directories[0]?.path).toMatch(/\/folder$/u);
    await rm(root, { recursive: true, force: true });
  });

  it("requires a matching preview proposal before executing administrative CLI handlers", async () => {
    const runCli = vi.fn(async (argv: readonly string[], onProgress?: (progress: unknown) => void) => { onProgress?.({ phase: "workspace_remove", completed: 1, total: 1 }); return { exit_code: 0, data: { argv }, stdout: "{}\n" }; });
    const handle = await startUrdiraWeb({ client: { call: vi.fn(async () => ({ protocol_version: 1, request_id: "r", outcome: "success" as const, payload: {} })) }, run_cli: runCli });
    handles.push(handle);
    const headers = { "content-type": "application/json" };
    const request = { api_version: 1, command: "workspace-remove", args: ["workspace-1"], options: { "debug-timing": true } };
    const preview = await fetch(`${handle.origin}/api/v1/cli/preview`, { method: "POST", headers, body: JSON.stringify(request) }).then((response) => response.json()) as { proposal_id: string; proposal_digest: string };
    const rejected = await fetch(`${handle.origin}/api/v1/cli/execute`, { method: "POST", headers, body: JSON.stringify(request) });
    expect(rejected.status).toBe(400);
    const accepted = await fetch(`${handle.origin}/api/v1/cli/execute`, { method: "POST", headers, body: JSON.stringify({ ...request, proposal_id: preview.proposal_id, proposal_digest: preview.proposal_digest }) });
    expect(accepted.status).toBe(202);
    const operation = await accepted.json() as { operation_id: string };
    expect(runCli.mock.calls[0]?.[0]).toContain("--dry-run");
    await vi.waitFor(() => expect(runCli.mock.calls[1]?.[0]).toContain("--confirm"));
    expect(runCli.mock.calls[1]?.[0]).toContain("--debug-timing");
    expect(runCli.mock.calls[1]?.[0]).not.toContain("true");
    const events = await fetch(`${handle.origin}/api/v1/cli/operations/${encodeURIComponent(operation.operation_id)}/events`).then((response) => response.text());
    expect(events).toContain('"type":"progress"');
    expect(events).toContain('"type":"completed"');
  });

  it("serves the structured web MCP profile through the official Streamable HTTP client", async () => {
    const handle = await startUrdiraWeb({
      client: { call: vi.fn(async () => ({ protocol_version: 1, request_id: "r", outcome: "success" as const, payload: { workspaces: [] } })) },
      run_cli: vi.fn(async () => ({ exit_code: 0, data: {}, stdout: "{}\n" })),
    });
    handles.push(handle);
    const client = new Client({ name: "urdira-web-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", handle.origin));
    await client.connect(transport);
    expect(client.getDiscoverResult()?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "urdira", version: "0.4.0" });
    expect(client.getDiscoverResult()?.capabilities.tools).toEqual({ listChanged: false });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "urdira_index_status",
      "urdira_context",
      "urdira_query",
    ]);
    expect(tools.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    const result = await client.callTool({ name: "urdira_index_status", arguments: { workspace_ids: [] } });
    expect(result.structuredContent).toEqual({ page: { workspaces: [] } });
    await client.close();
  });
});
