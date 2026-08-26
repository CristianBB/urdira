export type SearchMode = "lexical" | "semantic" | "hybrid";

export interface QueryEnvelope extends Record<string, unknown> {
  readonly request_type: "query";
  readonly query: Record<string, unknown>;
}

const frontierFor = (operation: string): "source" | "structural" | "semantic" => operation === "core:search_semantic" || operation === "core:search_hybrid" ? "semantic" : operation === "core:search_text" || operation === "core:find_artifacts" || operation === "core:get_source" ? "source" : "structural";

export function buildOperationRequest(workspaceId: string, operation: string, argumentsValue: Record<string, unknown>, timeoutMs = 30_000, freshnessMode: "wait" | "current" = "wait", maxItems = 50): QueryEnvelope {
  if (workspaceId.trim().length === 0) throw new Error("Select a workspace before running a query.");
  return {
    request_type: "query",
    query: {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: workspaceId },
      expression: { expression_type: "operation", operation, arguments: argumentsValue },
      options: {
        freshness: { mode: freshnessMode, required_frontier: frontierFor(operation), timeout_ms: timeoutMs },
        coverage_requirement: "accept_reported",
        evidence: { evidence: "summary", evidence_chain_depth: 1 },
        diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
        snippets: { mode: "relevant", max_characters_per_snippet: 2_000, max_total_characters: 20_000, context_lines: 2 },
        response_budget: { max_items: maxItems, max_characters: 120_000 },
      },
    },
  };
}

export function buildSearchRequest(workspaceId: string, mode: SearchMode, text: string, freshnessMode: "wait" | "current" = "wait"): QueryEnvelope {
  const normalized = text.trim();
  if (normalized.length === 0) throw new Error("Enter text, a symbol, or a behavioral description.");
  const operation = mode === "lexical" ? "core:search_text" : mode === "semantic" ? "core:search_semantic" : "core:search_hybrid";
  const args = mode === "lexical"
    ? { pattern: normalized, syntax: "literal", case_sensitive: false, word_mode: "substring", result_projection: "match" }
    : { query_text: normalized, query_class: "mixed" };
  return buildOperationRequest(workspaceId, operation, args, 30_000, freshnessMode);
}

export function buildContinuationRequest(workspaceId: string, cursor: string): Record<string, unknown> {
  if (workspaceId.trim().length === 0 || cursor.trim().length === 0) throw new Error("A workspace and cursor are required to load more results.");
  return { request_type: "continuation", continuation: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: workspaceId }, cursor, response_budget: { max_items: 50, max_characters: 120_000 } } };
}
