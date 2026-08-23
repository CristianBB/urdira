import { describe, expect, it } from "vitest";
import { buildQueryAdmissionPlan, QueryPlanError } from "../packages/engine/src/index.js";
import type { QueryRequest } from "@urdira/contracts";

const options = {
  freshness: "current" as const,
  wait_timeout_ms: 0,
  coverage_requirement: "accept_reported" as const,
  evidence: { evidence: "none" as const, evidence_chain_depth: 0 },
  diagnostics: { diagnostics: "none" as const, diagnostic_detail: false },
  snippets: { mode: "none" as const, max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
  registry: { registry: "none" as const, include_payload_schemas: false },
  response_budget: { max_items: 10, max_characters: 1_000 },
};

const request = (expression: QueryRequest["expression"]): QueryRequest => ({
  api_version: 3,
  scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
  expression,
  options,
});

describe("API v3 query admission", () => {
  it("admits source-safe find_artifacts without structural readiness", () => {
    const plan = buildQueryAdmissionPlan(request({ expression_type: "operation", operation: "core:find_artifacts", arguments: {} }));
    expect(plan.required_frontier).toBe("source");
    expect(plan.required_structural_stage).toBe(0);
    expect(plan.source_safe).toBe(true);
  });

  it("derives the strongest frontier from a v3 pipeline", () => {
    const plan = buildQueryAdmissionPlan(request({
      expression_type: "pipeline",
      stages: [
        { stage_id: "source", stage_type: "operation", operation: "core:find_artifacts", arguments: {} },
        { stage_id: "text", stage_type: "operation", operation: "core:search_text", arguments: { pattern: "needle", syntax: "literal", word_mode: "substring" }, bindings: { subjects: { stage_id: "source", output: "artifacts" } } },
        { stage_id: "source_text", stage_type: "operation", operation: "core:get_source", arguments: { source: { mode: "relevant", max_characters_per_snippet: 1000, max_total_characters: 1000, context_lines: 0 } }, bindings: { subjects: { stage_id: "text", output: "subjects" } } },
      ],
      outputs: [{ name: "sources", stage_id: "source_text", output: "sources" }],
    }));
    expect(plan.required_frontier).toBe("source");
    expect(plan.operation_ids).toEqual(["core:find_artifacts", "core:get_source", "core:search_text"]);
  });

  it("rejects the old wire version and legacy pipeline before execution", () => {
    expect(() => buildQueryAdmissionPlan({ ...request({ expression_type: "operation", operation: "core:find_artifacts", arguments: {} }), api_version: 1 })).toThrowError(QueryPlanError);
    expect(() => buildQueryAdmissionPlan({ ...request({ expression_type: "pipeline", stages: [], outputs: [] } as never) })).toThrowError(QueryPlanError);
  });

  it("reports an unknown field with a pointer, received value, and v3 example", () => {
    try {
      buildQueryAdmissionPlan({ ...request({ expression_type: "operation", operation: "core:find_artifacts", arguments: {} }), options: { ...options, freshness: "current", unknown: true } } as never);
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryPlanError);
      const details = (error as QueryPlanError).details;
      expect((error as QueryPlanError).code).toBe("core:unknown_field");
      expect(details["object_pointer"]).toBe("/options");
      expect(details["received"]).toBe(true);
      expect(details["example"]).toBeTruthy();
    }
  });
});
