import { buildOperationRequest } from "./query.js";

type JsonRecord = Record<string, unknown>;

export interface PipelineExample {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly outcome: string;
  readonly bindings: readonly {
    readonly from_stage: string;
    readonly output: string;
    readonly to_stage: string;
    readonly argument: string;
    readonly explanation: string;
  }[];
  readonly request: JsonRecord;
}

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function pipelineRequest(workspaceId: string, expression: JsonRecord): JsonRecord {
  const base = buildOperationRequest(workspaceId, "core:find_artifacts", {});
  return { ...base, query: { ...object(base["query"]), expression } };
}

export function pipelineMcpExamples(workspaceId: string): readonly PipelineExample[] {
  const scopeId = workspaceId || "<select a workspace>";
  return [{
    id: "search-to-source",
    label: "Search → read source",
    help: "Find every matching artifact and read only the relevant source in one deterministic call.",
    outcome: "Returns source snippets for every artifact found by the first stage.",
    bindings: [{
      from_stage: "search", output: "subjects", to_stage: "source", argument: "subjects",
      explanation: "Every subject found by the search becomes source input without copying identifiers by hand.",
    }],
    request: pipelineRequest(scopeId, {
      expression_type: "pipeline",
      stages: [
        { stage_id: "search", stage_type: "operation", operation: "core:search_text", operation_version: 3, arguments: { pattern: "InvalidTaskTransitionError", syntax: "literal", word_mode: "identifier", result_projection: "artifact" } },
        { stage_id: "source", stage_type: "operation", operation: "core:get_source", operation_version: 3, arguments: { source: { mode: "relevant", max_characters_per_snippet: 2_000, max_total_characters: 20_000, context_lines: 2 } }, bindings: { subjects: { stage_id: "search", output: "subjects" } } },
      ],
      outputs: [{ name: "sources", stage_id: "source", output: "sources" }],
    }),
  }, {
    id: "resolve-to-references",
    label: "Resolve → find references",
    help: "Resolve an ambiguous symbol name first, then use the exact declarations returned by Urdira.",
    outcome: "Returns references and their owning artifacts for the resolved declaration set.",
    bindings: [{
      from_stage: "resolve", output: "declarations", to_stage: "references", argument: "target",
      explanation: "The reference lookup consumes the exact declarations resolved upstream instead of a guessed identifier.",
    }],
    request: pipelineRequest(scopeId, {
      expression_type: "pipeline",
      stages: [
        { stage_id: "resolve", stage_type: "operation", operation: "core:resolve_symbol", operation_version: 3, arguments: { reference: "TaskService", resolution_scope: "exports" } },
        { stage_id: "references", stage_type: "operation", operation: "core:find_references", operation_version: 3, arguments: { include_declarations: false }, bindings: { target: { stage_id: "resolve", output: "declarations" } } },
      ],
      outputs: [{ name: "references", stage_id: "references", output: "references" }, { name: "owners", stage_id: "references", output: "owners" }],
    }),
  }];
}

function operationLabel(operation: string): string {
  const words = operation.replace(/^core:/u, "").replaceAll("_", " ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

export function pipelinePresentation(request: Readonly<Record<string, unknown>>): {
  readonly stages: readonly { readonly stage_id: string; readonly operation: string; readonly label: string }[];
  readonly bindings: readonly { readonly from_stage: string; readonly output: string; readonly to_stage: string; readonly argument: string }[];
  readonly outputs: readonly { readonly name: string; readonly stage_id: string; readonly output: string }[];
} | undefined {
  const expression = object(object(request["query"])["expression"]);
  if (expression["expression_type"] !== "pipeline" || !Array.isArray(expression["stages"])) return undefined;
  const stages = expression["stages"].map(object).map((stage) => ({ stage_id: String(stage["stage_id"] ?? "stage"), operation: String(stage["operation"] ?? stage["operator"] ?? "unknown"), label: operationLabel(String(stage["operation"] ?? stage["operator"] ?? "unknown")) }));
  const bindings = expression["stages"].flatMap((value) => {
    const stage = object(value); const declared = object(stage["bindings"]);
    return Object.entries(declared).map(([argument, binding]) => ({ from_stage: String(object(binding)["stage_id"] ?? ""), output: String(object(binding)["output"] ?? ""), to_stage: String(stage["stage_id"] ?? ""), argument }));
  });
  const outputs = Array.isArray(expression["outputs"]) ? expression["outputs"].map(object).map((output) => ({ name: String(output["name"] ?? ""), stage_id: String(output["stage_id"] ?? ""), output: String(output["output"] ?? "") })) : [];
  return { stages, bindings, outputs };
}
