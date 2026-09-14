import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { CursorCache, QueryEngine } from "../packages/engine/src/index.js";
import type { QueryRequest } from "@urdira/contracts";
import { createUrdiraMcpServer, createUrdiraToolDefinitions } from "../packages/mcp/src/index.js";

function harness(count: number, source = "long source line\n".repeat(20)) {
  const execute = vi.fn(async () => ({ streams: { records: Array.from({ length: count }, (_, index) => ({
    stable_sort_key: String(index).padStart(4, "0"), value: {
      result_set: "records", assessment: { classification: "confirmed", completeness: "complete" }, primary_result: { record_id: `record:${index}`, body: { path: `${index}.ts` } },
      optional_source_snippets: [{ text: source, span: { artifact_version_id: `version:${index}`, start_byte: "0", end_byte: String(source.length) }, truncated: false }],
    },
  })) }, diagnostics: [{ code: "test:diagnostic" }], completeness: { overall_status: "complete", dimensions: [] } }));
  const engine = new QueryEngine({ data_port: { execute }, cursor_cache: new CursorCache({ signing_secret: "page-fitting-test" }) });
  const call = vi.fn(async (name: string, payload: unknown) => ({ protocol_version: 2, request_id: "test", outcome: "success" as const,
    payload: name === "core:query" ? await engine.execute(payload as QueryRequest) : await engine.continue(payload as Parameters<QueryEngine["continue"]>[0]),
  }));
  const tools = createUrdiraToolDefinitions({ client: { call } });
  return { execute, call, engine, context: tools.find((tool) => tool.name === "urdira_context")!, query: tools.find((tool) => tool.name === "urdira_query")! };
}
const request = (max_characters: number) => ({ request_type: "query", query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "workspace:fit" }, expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } }, options: { response_budget: { max_items: 100, max_characters } } } });
const textOf = (result: Awaited<ReturnType<ReturnType<typeof harness>["query"]["invoke"]>>) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

describe("agent page fitting over immutable execution", () => {
  it("fits the rendered page and recovers every record without reexecuting the query", async () => {
    const h = harness(40);
    let input: unknown = request(4000);
    const ids: string[] = [];
    for (let page = 0; page < 50; page++) {
      const text = textOf(await h.query.invoke(input));
      expect(text.startsWith('{"error":')).toBe(false);
      expect(text.length).toBeLessThanOrEqual(4000);
      for (const line of text.split("\n")) {
        const record = line.match(/^identity: .*\brecord_id=([^ ]+)/u)?.[1];
        if (record !== undefined) ids.push(record);
      }
      const next = text.split("\n").find((line) => /^MORE(?: \([^)]*(?<!\.previous)\))?: /.test(line));
      if (next === undefined) break;
      input = JSON.parse(next.slice(next.indexOf(": ") + 2));
    }
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => `record:${i}`));
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts the unchanged continuation through the originating context tool", async () => {
    const h = harness(40);
    const first = textOf(await h.query.invoke(request(4000)));
    const more = first.split("\n").find((line) => line.startsWith("MORE:"))!;
    const result = await h.context.invoke(JSON.parse(more.slice(6)));
    expect(result.isError).not.toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts context continuations through SDK validation and rejects mixed envelopes", async () => {
    const h = harness(40);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createUrdiraMcpServer({ client: { call: h.call } });
    const client = new Client({ name: "continuation-regression", version: "1" });
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const initial = await client.callTool({ name: "urdira_query", arguments: request(4000) });
      const first = (initial.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const args = JSON.parse(first.split("\n").find((line) => line.startsWith("MORE:"))!.slice(6));
      const continued = await client.callTool({ name: "urdira_context", arguments: args });
      expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
      const calls = h.call.mock.calls.length;
      const mixed = await client.callTool({ name: "urdira_context", arguments: { ...args, task: "invalid mixture" } });
      expect(mixed.isError).toBe(true);
      expect(h.call.mock.calls.length).toBe(calls);
    } finally { await client.close(); await server.close(); }
  });

  it("preserves execution diagnostics on continuation", async () => {
    const h = harness(40);
    await h.query.invoke(request(4000));
    const first = await h.engine.execute(h.call.mock.calls[0]![1] as QueryRequest);
    const cursor = first.streams["records"]!.next_cursor!;
    const next = await h.engine.continue({ cursor, response_budget: (h.call.mock.calls[0]![1] as QueryRequest).options.response_budget });
    expect(first.diagnostics).toHaveLength(1);
    expect(next.diagnostics).toEqual(first.diagnostics);
  });

  it("preserves typed errors from a failed manifest read during fitting", async () => {
    const h = harness(40);
    const source = "long source line\n".repeat(20);
    h.call.mockReset();
    h.call.mockResolvedValueOnce({
      protocol_version: 2, request_id: "test", outcome: "success",
      payload: {
        query_execution_id: "execution-fitting-error",
        streams: { records: {
          items: Array.from({ length: 40 }, (_, index) => ({
            stable_sort_key: String(index).padStart(4, "0"),
            value: {
              result_set: "records", assessment: { classification: "confirmed", completeness: "complete" },
              primary_result: { record_id: `record:${index}`, body: { path: `${index}.ts` } },
              optional_source_snippets: [{ text: source, span: { artifact_version_id: `version:${index}`, start_byte: "0", end_byte: String(source.length) }, truncated: false }],
            },
          })),
          page_start_cursor: "cursor:start", has_next: false, has_previous: false, total: 40,
        } },
        diagnostics: [], completeness: { overall_status: "complete", dimensions: [] },
      },
    } as never);
    h.call.mockResolvedValueOnce({ protocol_version: 2, request_id: "test", outcome: "error", error: { code: "core:cursor_expired", message: "expired during presentation", details: {} } } as never);
    const result = await h.query.invoke(request(4000));
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error.code).toBe("core:cursor_expired");
  });

  it("fits the full JSON transport envelope", async () => {
    const h = harness(40);
    const result = await h.query.invoke({ ...request(4000), render: "json" });
    const text = textOf(result);
    expect(JSON.parse(text).error).toBeUndefined();
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it("keeps the original budget binding and validates private page bounds", async () => {
    const h = harness(40);
    await h.query.invoke(request(4000));
    const normalized = h.call.mock.calls[0]![1] as QueryRequest;
    const first = await h.engine.execute(normalized);
    const cursor = first.streams["records"]!.page_start_cursor!;
    await expect(h.engine.continue({ cursor, response_budget: normalized.options.response_budget, page_item_limit: -1 })).rejects.toMatchObject({ code: "core:budget_invalid" });
    await expect(h.engine.continue({ cursor, response_budget: { ...normalized.options.response_budget, max_characters: 8000 }, page_item_limit: 1 })).rejects.toMatchObject({ code: "core:cursor_projection_mismatch" });
    const summary = await h.engine.continue({ cursor, response_budget: normalized.options.response_budget, page_item_limit: 0 });
    expect(summary.streams["records"]).toMatchObject({ items: [], total: 40, has_next: true, next_cursor: cursor });
  });

  it("reports the minimum single-result projection instead of a moving page minimum", async () => {
    const h = harness(10, "source\n".repeat(1000));
    const text = textOf(await h.query.invoke(request(3000)));
    expect(JSON.parse(text).error.code).toBe("core:snippet_budget_impossible");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("expands only the omitted character budget for an explicit larger source projection", async () => {
    const h = harness(2, "source\n".repeat(100));
    await h.query.invoke({ request_type: "query", query: {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace:fit" },
      expression: { expression_type: "operation", operation: "core:get_source", arguments: {
        subjects: [{ subject_type: "artifact", path: "src/a.ts" }, { subject_type: "artifact", path: "src/b.ts" }],
        source: { mode: "body", max_characters_per_snippet: 30_000, max_total_characters: 60_000, context_lines: 2 },
      } },
    } });
    expect((h.call.mock.calls[0]![1] as QueryRequest).options.response_budget.max_characters).toBe(80_000);

    const explicit = harness(2, "source\n".repeat(100));
    await explicit.query.invoke({ request_type: "query", query: {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace:fit" },
      expression: { expression_type: "operation", operation: "core:get_source", arguments: {
        subjects: [{ subject_type: "artifact", path: "src/a.ts" }],
        source: { mode: "body", max_characters_per_snippet: 30_000, max_total_characters: 60_000, context_lines: 2 },
      } },
      options: { response_budget: { max_characters: 25_000 } },
    } });
    expect((explicit.call.mock.calls[0]![1] as QueryRequest).options.response_budget.max_characters).toBe(25_000);
  });
});
