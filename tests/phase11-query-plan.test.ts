import { describe, expect, it } from "vitest";
import { normalizeQueryRequest, QueryPlanError, validatePipelineExpression } from "../packages/engine/src/index.js";
import type { QueryExpression, QueryRequest } from "@urdira/contracts";

const options = {
  freshness: "snapshot" as const,
  wait_timeout_ms: 0,
  coverage_requirement: "accept_reported" as const,
  evidence: { evidence: "none" as const, evidence_chain_depth: 0 },
  diagnostics: { diagnostics: "none" as const, diagnostic_detail: false },
  snippets: { mode: "none" as const, max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
  registry: { registry: "none" as const, include_payload_schemas: false },
  response_budget: { max_items: 10, max_characters: 1_000 },
};

function request(expression: QueryExpression): QueryRequest {
  return { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "workspace-1", snapshot_id: "snapshot-1" }, expression, options };
}

const operation = (operationName = "core:find_records"): QueryExpression => ({
  expression_type: "operation",
  operation: operationName,
  arguments: { selector: { record_categories: ["entity"] } },
});

const sourceStage = (stage_id: string, operationName = "core:find_records") => ({
  stage_id,
  operator: "source.operation" as const,
  inputs: [],
  arguments: { operation: operationName, operation_arguments: { selector: { record_categories: ["entity"] } } },
});

const reference = (stage_id: string, output: string) => ({ stage_id, output });

const pipeline = (stages: readonly object[], outputs: readonly object[]): QueryExpression => ({
  expression_type: "pipeline" as const,
  stages,
  outputs,
} as unknown as QueryExpression);

const recipe = (recipe_id = "core:locate_implementation", recipe_version?: number): QueryExpression => ({
  expression_type: "recipe",
  recipe_id,
  ...(recipe_version === undefined ? {} : { recipe_version }),
  arguments: { query_text: "query plan", query_class: "natural_text" },
});

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryPlanError);
    expect((error as QueryPlanError).code).toBe(code);
  }
}

describe("Phase 11 query plan normalization", () => {
  it("normalizes a registered operation into a digest-addressed plan", () => {
    const plan = normalizeQueryRequest(request(operation()));
    expect(plan.api_version).toBe("1");
    expect(plan.operation_versions).toEqual([{ operation_id: "core:find_records", operation_version: 1 }]);
    expect(plan.recipe_versions).toEqual([]);
    expect(plan.plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("canonicalizes equivalent operation arguments to the same plan digest", () => {
    const first = request({ expression_type: "operation", operation: "core:search_text", arguments: { pattern: "x", syntax: "literal", word_mode: "substring" } });
    const second = request({ expression_type: "operation", operation: "core:search_text", arguments: { word_mode: "substring", syntax: "literal", pattern: "x" } });
    expect(normalizeQueryRequest(first).plan_digest).toBe(normalizeQueryRequest(second).plan_digest);
  });

  it("rejects an operation that is not in the registry", () => {
    expectCode(() => normalizeQueryRequest(request(operation("core:not_registered"))), "core:operation_unknown");
  });

  it("rejects an unsupported public API version", () => {
    expectCode(() => normalizeQueryRequest({ ...request(operation()), api_version: 3 }), "core:api_version_unsupported");
  });

  it("rejects an unknown recipe and recipe version", () => {
    expectCode(() => normalizeQueryRequest(request(recipe("core:not_registered"))), "core:recipe_unknown");
    expectCode(() => normalizeQueryRequest(request(recipe("core:locate_implementation", 2))), "core:recipe_version_unsupported");
  });

  it("rejects an operation used with an invalid scope", () => {
    expectCode(() => normalizeQueryRequest({ ...request({ expression_type: "operation", operation: "core:compare", arguments: { comparison_kinds: ["changed"] } }), scope: { scope_type: "single_workspace", workspace_id: "workspace-1" } }), "core:invalid_query_scope");
  });

  it("rejects an invalid response budget", () => {
    expectCode(() => normalizeQueryRequest({ ...request(operation()), options: { ...options, response_budget: { max_items: 0, max_characters: 1_000 } } }), "core:budget_invalid");
  });

  it("rejects invalid nested option values and operation argument types", () => {
    expectCode(() => normalizeQueryRequest({ ...request(operation("core:search_text")), expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: 42, syntax: "literal", word_mode: "substring" } } } as unknown as QueryRequest), "core:request_invalid");
    expectCode(() => normalizeQueryRequest({ ...request(operation()), options: { ...options, evidence: { evidence: "invalid", evidence_chain_depth: 0 } } } as unknown as QueryRequest), "core:request_invalid");
  });

  it("resolves expand-operation streams from the operation registry", () => {
    const expression = pipeline([
      sourceStage("source", "core:find_records"),
      { stage_id: "expanded", operator: "expand.operation" as const, inputs: [reference("source", "records")], arguments: { operation: "core:find_references", operation_arguments: {}, input_argument: "target" } },
    ], [reference("expanded", "references")]);
    expect(() => validatePipelineExpression(expression)).not.toThrow();
    expectCode(() => validatePipelineExpression(pipeline([sourceStage("source"), { stage_id: "expanded", operator: "expand.operation", inputs: [reference("source", "records")], arguments: { operation: "core:missing", operation_arguments: {}, input_argument: "target" } }], [reference("expanded", "subjects")])), "core:operation_unknown");
  });

  it("rejects unknown request fields before normalization", () => {
    expectCode(() => normalizeQueryRequest({ ...request(operation()), extra: true } as QueryRequest & { extra: boolean }), "core:unknown_field");
  });

  it("rejects unknown pipeline operator fields", () => {
    const expression = pipeline([{ stage_id: "source", operator: "source.registry", inputs: [], arguments: { matcher: { text: "x", mode: "exact" }, extra: true } }], [reference("source", "definitions")]);
    expectCode(() => validatePipelineExpression(expression), "core:unknown_field");
  });

  it("rejects duplicate stage identifiers", () => {
    expectCode(() => validatePipelineExpression(pipeline([sourceStage("source"), sourceStage("source")], [reference("source", "records")])), "core:stage_reference_invalid");
  });

  it("rejects a pipeline stage that references a later stage", () => {
    const expression = pipeline([
      { stage_id: "second", operator: "filter", inputs: [reference("first", "records")], arguments: { predicate: { subject_type: ["entity"] } } },
      sourceStage("first"),
    ], [reference("second", "subjects")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_reference_invalid");
  });

  it("rejects cyclic stage references", () => {
    const expression = pipeline([
      { stage_id: "first", operator: "filter", inputs: [reference("second", "subjects")], arguments: { predicate: { subject_type: ["entity"] } } },
      { stage_id: "second", operator: "filter", inputs: [reference("first", "subjects")], arguments: { predicate: { subject_type: ["entity"] } } },
    ], [reference("second", "subjects")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_reference_invalid");
  });

  it("rejects disconnected stages", () => {
    const expression = pipeline([sourceStage("used"), sourceStage("unused")], [reference("used", "records")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_reference_invalid");
  });

  it("rejects unknown stage outputs", () => {
    const expression = pipeline([sourceStage("source")], [reference("source", "unknown")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_reference_invalid");
  });

  it("rejects duplicate output references", () => {
    const expression = pipeline([sourceStage("source")], [reference("source", "records"), reference("source", "records")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_reference_invalid");
  });

  it("rejects illegal stage input counts", () => {
    const expression = pipeline([{ stage_id: "filter", operator: "filter", inputs: [], arguments: { predicate: { subject_type: ["entity"] } } }], [reference("filter", "subjects")]);
    expectCode(() => validatePipelineExpression(expression), "core:stage_type_mismatch");
  });

  it("normalizes a connected pipeline with operation bindings", () => {
    const plan = normalizeQueryRequest(request(pipeline([
      sourceStage("source"),
      { stage_id: "filtered", operator: "filter", inputs: [reference("source", "records")], arguments: { predicate: { subject_type: ["entity"] } } },
    ], [reference("filtered", "subjects")] )));
    expect(plan.operation_versions).toEqual([{ operation_id: "core:find_records", operation_version: 1 }]);
    expect(plan.recipe_versions).toEqual([]);
    expect(plan.plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("normalizes a registered recipe with its operation and recipe bindings", () => {
    const plan = normalizeQueryRequest(request(recipe()));
    expect(plan.recipe_versions).toEqual([{ recipe_id: "core:locate_implementation", recipe_version: 1 }]);
    expect(plan.operation_versions).toEqual([
      { operation_id: "core:get_source", operation_version: 1 },
      { operation_id: "core:search_hybrid", operation_version: 1 },
    ]);
    expect(plan.plan_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("normalizes an omitted defaultable recipe argument to its documented default before hashing, identically to the explicit default", () => {
    // `core:locate_implementation`'s `query_class` is optional and defaults
    // to `mixed` (docs/protocol/public-query-contract.md's "Recipe argument
    // defaults"). A bare `{ query_text }` call must accept and must
    // normalize to the SAME plan_digest as passing the default explicitly
    // -- proving the default is injected before canonicalization, not left
    // as an unobservable runtime fallback.
    const minimal = normalizeQueryRequest(request({ expression_type: "recipe", recipe_id: "core:locate_implementation", arguments: { query_text: "query plan" } } as unknown as QueryExpression));
    const explicit = normalizeQueryRequest(request({ expression_type: "recipe", recipe_id: "core:locate_implementation", arguments: { query_text: "query plan", query_class: "mixed" } } as unknown as QueryExpression));
    expect(minimal.plan_digest).toBe(explicit.plan_digest);
    expect((minimal.normalized_expression as { arguments: { query_class: string } }).arguments.query_class).toBe("mixed");
  });

  it("rejects a minimal recipe call missing a genuinely required argument", () => {
    expectCode(() => normalizeQueryRequest(request({ expression_type: "recipe", recipe_id: "core:locate_implementation", arguments: {} } as unknown as QueryExpression)), "core:request_invalid");
  });
});
