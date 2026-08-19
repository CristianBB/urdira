import { describe, expect, it } from "vitest";
import { CursorCache, QueryEngine, type QueryDataPort } from "../packages/engine/src/index.js";
import type { QueryRequest } from "@urdira/contracts";

const request = (max_items = 2): QueryRequest => ({
  api_version: 1,
  scope: { scope_type: "single_workspace", workspace_id: "w" },
  expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "x", syntax: "literal", word_mode: "substring" } },
  options: {
    freshness: "snapshot", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
    evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "used", include_payload_schemas: false }, response_budget: { max_items, max_characters: 10_000 },
  },
});

describe("Phase 11 query execution", () => {
  it("freezes stream order and continues from the durable manifest cursor", async () => {
    const port: QueryDataPort = { async execute() { return { streams: { matches: [{ value: { id: "b" }, stable_sort_key: "b" }, { value: { id: "a" }, stable_sort_key: "a" }, { value: { id: "c" }, stable_sort_key: "c" }] } }; } };
    const engine = new QueryEngine({ data_port: port, cursor_cache: new CursorCache({ signing_secret: "secret" }), now: () => "2026-08-10T00:00:00.000Z" });
    const first = await engine.execute(request());
    expect(first.streams["matches"]!.items.map((item) => (item.value as { id: string }).id)).toEqual(["b", "a"]);
    expect(first.streams["matches"]!.next_cursor).toBeDefined();
    const second = await engine.continue({ cursor: first.streams["matches"]!.next_cursor!, response_budget: { max_items: 2, max_characters: 10_000 } });
    expect(second.streams["matches"]!.items.map((item) => (item.value as { id: string }).id)).toEqual(["c"]);
  });

  it("reports completeness, diagnostics, semantic state, and registry projections", async () => {
    const port: QueryDataPort = { async execute() { return { streams: { matches: [] }, semantic_state: "updating", completeness: { overall_status: "partial" }, diagnostics: [{ diagnostic_code: "core:embedding_generation_failed" }] }; } };
    const engine = new QueryEngine({ data_port: port, cursor_cache: new CursorCache({ signing_secret: "secret" }), now: () => "2026-08-10T00:00:00.000Z" });
    const result = await engine.execute(request(10));
    expect(result.completeness.overall_status).toBe("partial");
    expect(result.semantic_state).toBe("updating");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.registry.mode).toBe("used");
  });

  it("fails closed when complete coverage is required", async () => {
    const port: QueryDataPort = { async execute() { return { streams: { matches: [] }, completeness: { overall_status: "partial" } }; } };
    const engine = new QueryEngine({ data_port: port, cursor_cache: new CursorCache({ signing_secret: "secret" }), now: () => "2026-08-10T00:00:00.000Z" });
    await expect(engine.execute({ ...request(), options: { ...request().options, coverage_requirement: "require_complete" } })).rejects.toMatchObject({ code: "core:coverage_incomplete" });
  });
});
