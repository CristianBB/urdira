import { describe, expect, it } from "vitest";
import { formatUrdiraResult } from "../packages/mcp/src/index.js";
import { CursorCache } from "../packages/engine/src/index.js";

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
    expect(text).toContain("coverage: complete");
    expect(text).toContain("page_coverage: incomplete; action=continue");
    expect(text).toContain("page: shown=1; more=yes");
    const more = text.match(/^MORE: (\{.*\})$/m);
    expect(more).not.toBeNull();
    const continuation = JSON.parse(more![1]!);
    expect(continuation).toEqual({
      request_type: "continuation",
      continuation: { api_version: 3, continuation_ref: expect.any(String) },
    });
    expect(continuation.continuation.continuation_ref).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(text).not.toContain("export function target");
    expect(text).not.toContain("artifact:1");
    expect(text).not.toContain("core:source");
    expect(text.length).toBeLessThan(JSON.stringify({ page }).length);
  });

  it("renders freshness and incomplete capability coverage without hiding an empty continuation", () => {
    const partialPage = {
      ...page,
      returned_items: 0,
      result_sets: [{
        result_set: "sources",
        confirmed: { result_bundles: [], has_next: true, next_cursor: "cursor:empty-next" },
        possible: { result_bundles: [], has_next: false },
      }],
      index_freshness: { status: "changes_pending" },
      completeness_report: {
        overall_status: "partial",
        dimensions: [{ capability: "structural", status: "partial", affected_artifact_count: 2 }],
      },
    };
    const result = formatUrdiraResult(partialPage, { presentation_profile: "web", continuation_scope: continuationScope });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("freshness: changes_pending");
    expect(text).toContain("coverage: partial (2 files affected)");
    expect(text).toContain("capability: structural=partial");
    expect(text).toContain("page: shown=0; more=yes");
    expect(text).toContain("page_coverage: incomplete; action=continue");
    const more = text.match(/^MORE: (\{.*\})$/m);
    expect(more).not.toBeNull();
    expect(JSON.parse(more![1]!)).toEqual({
      request_type: "continuation",
      continuation: { api_version: 3, continuation_ref: expect.any(String) },
    });
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

  it("round-trips a compact signed engine cursor through the MCP MORE envelope", async () => {
    const cache = new CursorCache({ signing_secret: "mcp-cursor-test-secret" });
    const cursor = cache.encode({
      cursor_kind: "query", execution_id: "query:mcp-roundtrip", scope_digest: "scope", result_stream: "context",
      stable_position: "position", direction: "forward", projection_digest: "projection", ordering_digest: "ordering",
      response_budget_ceiling_digest: "budget", frozen_snapshot_digest: "snapshot", frozen_status_digest: "ready",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    const result = formatUrdiraResult({ ...page, result_sets: [{ ...page.result_sets[0]!, confirmed: { ...page.result_sets[0]!.confirmed, next_cursor: cursor } }] }, { continuation_scope: continuationScope });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const more = text.match(/^MORE: (\{.*\})$/m);
    expect(more).not.toBeNull();
    const continuation = JSON.parse(more![1]!).continuation;
    expect(continuation.continuation_ref).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  });
});
