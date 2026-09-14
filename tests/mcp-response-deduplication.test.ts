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


describe("agent information preservation", () => {
  it("retains diagnostic recovery and snapshot metadata without results", () => {
    const result = formatUrdiraResult({ ...page, returned_items: 0, result_sets: [], workspace_snapshot_bindings: [{ snapshot_id: "snapshot:retained" }], diagnostic_report: { diagnostics: [{ message: "Unavailable", details: { recovery: "request exact artifact version" } }] } });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("snapshot:retained");
    expect(text).toContain("request exact artifact version");
  });
  it("retains summary-only streams beside hydrated streams", () => {
    const value = { ...page, result_sets: [...page.result_sets, { result_set: "tests", confirmed: { result_bundles: [], total: 19, has_next: true, next_cursor: "cursor:tests" }, possible: { result_bundles: [], has_next: false } }] };
    const result = formatUrdiraResult(value, { continuation_scope: continuationScope });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("tests.confirmed");
    expect(text).toContain("19");
    expect(text.match(/^MORE(?: \(.*\))?:/gm)).toHaveLength(2);
  });

  it("retains diagnostics when no bundle was returned", () => {
    const result = formatUrdiraResult({ ...page, returned_items: 0, result_sets: [], diagnostic_report: { diagnostics: [{ severity: "warning", message: "Missing indexed source" }] } });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Missing indexed source");
  });

  it("preserves every requested snippet and shares identical ranges only within a page", () => {
    const snippet = { artifact_id: "artifact:one", artifact_version_id: "version:one", span: { start_byte: 0, end_byte: 20 }, text: "first distinct body" };
    const bundle = { primary_result: { record_id: "record:one", owner_artifact_version_id: "version:one", body: { path: "src/one.ts", name: "one" } }, optional_source_snippets: [snippet, { ...snippet, span: { start_byte: 20, end_byte: 40 }, text: "second distinct body" }] };
    const value = { ...page, returned_items: 2, result_sets: [{ result_set: "context", confirmed: { result_bundles: [bundle, { ...bundle, primary_result: { ...bundle.primary_result, record_id: "record:two" } }], has_next: false }, possible: { result_bundles: [], has_next: false } }] };
    const rendered = () => { const result = formatUrdiraResult(value); return result.content[0]?.type === "text" ? result.content[0].text : ""; };
    const text = rendered();
    expect(text.match(/first distinct body/g)).toHaveLength(1);
    expect(text.match(/second distinct body/g)).toHaveLength(1);
    expect(text).toContain("record:one");
    expect(text).toContain("record:two");
    expect(rendered()).toBe(text);
  });

  it("renders reusable bundle meaning once instead of repeating the complete primary result", () => {
    const bundle = {
      result_set: "context",
      primary_result: {
        subject_type: "relation",
        record_id: "record:call-site",
        relation_id: "relation:call-site",
        identity_key: "jsts:call:src/caller.ts:40:60:caller:target",
        owner_artifact_id: "artifact:caller",
        owner_artifact_version_id: "version:caller",
        kind: "jsts:relation_call",
        universal_kind: "core:call",
        classification: "confirmed",
        source_span: { artifact_version_id: "version:caller", start_byte: "40", end_byte: "60", start_line: "3", end_line: "3" },
        body: {
          path: "src/caller.ts",
          classification: "confirmed",
          source_id: "entity:caller",
          target_id: "entity:target",
          start: 40,
          end: 60,
        },
      },
      assessment: { classification: "confirmed", completeness: "complete" },
      provenance_path: [{ subject_type: "record", record_id: "record:evidence" }],
      essential_related_entities: [],
      optional_source_snippets: [{
        artifact_id: "artifact:caller",
        text: "target();",
        span: { artifact_version_id: "version:caller", start_byte: "40", end_byte: "60", start_line: "3", end_line: "3" },
        truncated: false,
        redacted: false,
        redactions: [],
      }],
    };
    const value = {
      ...page,
      result_sets: [{
        result_set: "context",
        confirmed: { classification: "confirmed", page_mode: "hydrated", result_bundles: [bundle], total: 1, has_next: false, has_previous: false },
        possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false },
      }],
    };
    const result = formatUrdiraResult(value);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("src/caller.ts:3 (jsts:relation_call)");
    expect(text).toContain("identity: record_id=record:call-site relation_id=relation:call-site identity_key=jsts:call:src/caller.ts:40:60:caller:target");
    expect(text).toContain("relation: entity:caller -> entity:target");
    expect(text).toContain("evidence: record:evidence");
    expect(text).toContain("source:1 artifact=artifact:caller version=version:caller bytes=40..60 lines=3..3");
    expect(text).not.toContain("details:");
    expect(text).not.toContain('"classification":"confirmed"');
    expect(text).not.toContain('"owner_artifact_id":"artifact:caller"');
    expect(text.length).toBeLessThan(JSON.stringify(value).length / 2);
  });

  it("does not repeat owner identity fields inside attributes", () => {
    const bundle = {
      primary_result: {
        subject_type: "artifact",
        artifact_id: "artifact:one",
        artifact_version_id: "version:one",
        body: {
          path: "src/one.ts",
          name: "one",
          artifact_id: "artifact:one",
          artifact_version_id: "version:one",
          matched_text: "Target",
        },
      },
      optional_source_snippets: [],
    };
    const result = formatUrdiraResult({ ...page, returned_items: 1, result_sets: [{ result_set: "matches", confirmed: { result_bundles: [bundle], has_next: false }, possible: { result_bundles: [], has_next: false } }] });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("identity: artifact=artifact:one version=version:one");
    expect(text).toContain('attributes: {"matched_text":"Target"}');
    expect(text.match(/artifact:one/g)).toHaveLength(1);
    expect(text.match(/version:one/g)).toHaveLength(1);
  });

  it("keeps overlapping ranges and equal text from different artifacts distinct", () => {
    const snippet = { artifact_id: "artifact:one", artifact_version_id: "version:one", span: { start_byte: 0, end_byte: 20 }, text: "identical source text" };
    const bundles = [snippet, { ...snippet, span: { start_byte: 10, end_byte: 30 } }, { ...snippet, artifact_id: "artifact:two", artifact_version_id: "version:two" }].map((source, index) => ({ primary_result: { record_id: `record:${index}`, body: { path: `${index}.ts` } }, optional_source_snippets: [source] }));
    const result = formatUrdiraResult({ ...page, returned_items: 3, result_sets: [{ result_set: "sources", confirmed: { result_bundles: bundles, has_next: false }, possible: { result_bundles: [], has_next: false } }] });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text.match(/identical source text/g)).toHaveLength(3);
    expect(text).toContain("source:3");
  });
});
