import { describe, expect, it } from "vitest";
import { formatUrdiraResult } from "../packages/mcp/src/index.js";

const page = {
  query_execution_id: "query:fixture",
  returned_items: 1,
  result_sets: [{
    result_set: "sources",
    confirmed: {
      result_bundles: [{
        primary_result: {
          body: {
            path: "src/example.ts",
            name: "target",
            source_text: "export function target(): void { return; }",
            hydration: { owner: "artifact:1" },
            evidence: [{ code: "core:source" }],
            registry: { kind: "function" },
          },
        },
        optional_source_snippets: [{ text: "export function target(): void { return; }" }],
      }],
      has_next: true,
      next_cursor: "cursor:opaque-next",
    },
    possible: { result_bundles: [], has_next: false },
  }],
  completeness_report: { overall_status: "complete", dimensions: [] },
  diagnostic_report: { diagnostics: [], total: 0, returned: 0 },
};
const continuationScope = {
  scope_type: "single_workspace",
  workspace_id: "workspace:fixture",
};

describe("web MCP response payload separation", () => {
  it("keeps the complete structured page and cursor while removing duplicated detail payloads from text", () => {
    const result = formatUrdiraResult(page, { presentation_profile: "web", continuation_scope: continuationScope });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.structuredContent).toEqual({ page });
    expect(text).toContain("src/example.ts");
    const more = text.match(/^MORE: (\{.*\})$/m);
    expect(more).not.toBeNull();
    const continuation = JSON.parse(more![1]!);
    expect(continuation).toEqual({
      request_type: "continuation",
      continuation: {
        api_version: 3,
        scope: continuationScope,
        cursor: "cursor:opaque-next",
      },
    });
    expect(text.match(/cursor:opaque-next/g)).toHaveLength(1);
    expect(text).not.toContain("export function target");
    expect(text).not.toContain("artifact:1");
    expect(text).not.toContain("core:source");
    expect(text.length).toBeLessThan(JSON.stringify({ page }).length);
  });

  it("keeps the same complete page and cursor for JSON rendering without serializing details twice", () => {
    const result = formatUrdiraResult(page, { presentation_profile: "web", render: "json" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.structuredContent).toEqual({ page });
    const firstResultSet = page.result_sets[0]!;
    expect(JSON.parse(text)).toEqual({
      page: {
        ...page,
        result_sets: [{
          ...firstResultSet,
          confirmed: {
            ...firstResultSet.confirmed,
            result_bundles: [{ primary_result: { body: { path: "src/example.ts", name: "target" } } }],
          },
        }],
      },
    });
    expect(text).not.toContain("export function target");
    expect(text).toContain("cursor:opaque-next");
    expect(text.length).toBeLessThan(JSON.stringify({ page }).length);
  });
});
