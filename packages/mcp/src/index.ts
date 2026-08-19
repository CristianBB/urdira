import {
  McpServer,
  fromJsonSchema,
  ProtocolError,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createHash } from "node:crypto";
import type { LocalIpcRequestOptions, UceProgress, UceResponse } from "@urdira/daemon";
import { operationErrorDefinitions, operationRegistry, queryAlgebraOperatorIds, recipeRegistry, toCanonicalName, type JsonSchema } from "@urdira/contracts";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_SERVER_NAME = "urdira" as const;
export const MCP_SERVER_VERSION = "0.1.0" as const;

export const MCP_TOOL_NAMES = [
  "urdira_query",
  "urdira_analyze_change",
  "urdira_build_context",
  "urdira_index_status",
] as const;

export type UrdiraMcpToolName = (typeof MCP_TOOL_NAMES)[number];
export type UrdiraProgress = UceProgress["progress"];

export interface UrdiraMcpClient {
  readonly call: (call: string, payload: unknown, options?: LocalIpcRequestOptions) => Promise<UceResponse>;
}

export interface UrdiraMcpToolContext {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: UrdiraProgress) => void;
}

export interface ServeUrdiraStdioOptions extends ServeStdioOptions {
  /** Optional benchmark/client projection of the public tool set. */
  readonly tool_names?: readonly UrdiraMcpToolName[];
  /** Optional compact instructions for a deliberately narrowed client projection. */
  readonly instructions?: string;
  /** Optional compact schemas for focused clients that already know the public protocol. */
  readonly compact?: boolean;
  /** Optional benchmark-only single-call discovery adapter. */
  readonly benchmark_discover?: boolean;
}

export interface UrdiraMcpToolDefinition {
  readonly name: UrdiraMcpToolName;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly output_schema: JsonSchema;
  readonly invoke: (args: unknown, context?: UrdiraMcpToolContext) => Promise<CallToolResult>;
}

export class McpProtocolError extends Error {
  readonly code = -32602;

  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function canonicalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [toCanonicalName(key), canonicalKeys(entry)]));
}

function canonicalSchema(value: unknown): JsonSchema {
  if (!isRecord(value)) return value as JsonSchema;
  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "properties" && isRecord(entry)) {
      result[key] = Object.fromEntries(Object.entries(entry).map(([property, schema]) => [toCanonicalName(property), canonicalSchema(schema)]));
    } else if (key === "required" && Array.isArray(entry)) {
      result[key] = entry.map((property) => typeof property === "string" ? toCanonicalName(property) : property);
    } else if (Array.isArray(entry)) {
      result[key] = entry.map((item) => isRecord(item) ? canonicalSchema(item) : item);
    } else if (isRecord(entry)) {
      result[key] = canonicalSchema(entry);
    } else {
      result[key] = entry;
    }
  }
  return result as JsonSchema;
}

function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema {
  return { type: "object", additionalProperties: false, properties, ...(required.length === 0 ? {} : { required: [...required] }) };
}

// --- Server-side option defaulting -----------------------------------------
//
// The engine's `exactObject` validation (packages/engine/src/query-plan.ts)
// rejects any `options` object that is missing a field, so a caller-facing
// schema that requires all eight top-level fields (plus every nested
// sub-field) forces an agent to reconstruct the entire object on every call
// just to express one preference. These constants and `deepMergeDefaults`
// let the MCP schema make `options` (and every sub-field) optional while
// this adapter still always emits the complete engine-valid shape.
const DEFAULT_RESPONSE_BUDGET: JsonRecord = { max_items: 50, max_characters: 20_000 };
const DEFAULT_QUERY_OPTIONS: JsonRecord = {
  freshness: "current",
  wait_timeout_ms: 0,
  coverage_requirement: "accept_reported",
  evidence: { evidence: "summary", evidence_chain_depth: 1 },
  diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
  snippets: { mode: "relevant", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 },
  registry: { registry: "none", include_payload_schemas: false },
  response_budget: DEFAULT_RESPONSE_BUDGET,
};

function deepMergeDefaults(defaults: JsonRecord, supplied: unknown): JsonRecord {
  const suppliedRecord = isRecord(supplied) ? supplied : {};
  const merged: JsonRecord = { ...defaults };
  for (const [key, value] of Object.entries(suppliedRecord)) {
    if (value === undefined) continue;
    const defaultValue = defaults[key];
    merged[key] = isRecord(defaultValue) && isRecord(value) ? deepMergeDefaults(defaultValue, value) : value;
  }
  return merged;
}

function mergeQueryOptions(supplied: unknown): JsonRecord {
  return deepMergeDefaults(DEFAULT_QUERY_OPTIONS, supplied);
}

function mergeResponseBudget(supplied: unknown): JsonRecord {
  return deepMergeDefaults(DEFAULT_RESPONSE_BUDGET, supplied);
}

const scopeSchema: JsonSchema = objectSchema({
  scope_type: { type: "string", enum: ["single_workspace", "comparison"] },
  workspace_id: { type: "string" },
  snapshot_id: { type: "string" },
  participants: { type: "array", items: objectSchema({ workspace_id: { type: "string" }, role: { type: "string" }, snapshot_id: { type: "string" } }, ["workspace_id", "role"]) },
}, ["scope_type"]);

// A live benchmark (2026-08-14) showed a Sonnet coding agent passing
// render:"json" on 29 of 33 calls purely because the option was visible in
// the schema, reintroducing the ~10x context cost the text rendering below
// was built to eliminate. `render` is therefore no longer advertised in any
// tool's input_schema, tool description, or MCP_SERVER_INSTRUCTIONS -- see
// `withHiddenRenderProperty`/`hiddenRenderInputSchema` near
// `createUrdiraMcpServer` for how an explicit render:"json" is still
// accepted at runtime as an undocumented debug hatch despite every tool
// schema declaring `additionalProperties: false`. This schema object itself
// is now used ONLY to build that hidden validator-side allowance; its
// `description` is never shown to any client.
const renderFieldSchema: JsonSchema = {
  type: "string",
  enum: ["text", "json"],
  description: "Output projection for this call. Optional; default: text -- a compact, grep-like plain-text rendering (typically well under 2KB) instead of the full JSON envelope. Pass \"json\" to get the complete structured page (result ids, digests, completeness/diagnostic scaffolding, cursors) for debugging or programmatic consumption.",
};

const responseBudgetSchema: JsonSchema = objectSchema({
  max_items: { type: "integer", minimum: 1, description: "Maximum result bundles to hydrate across all streams. Optional; default: 50." },
  max_characters: { type: "integer", minimum: 1, description: "Hard ceiling on the serialized envelope size in characters; an over-budget response is shed deterministically to fit. Optional; default: 20000." },
});
const evidenceOptionsSchema: JsonSchema = objectSchema({
  evidence: { type: "string", enum: ["none", "summary", "full"], description: "Evidence detail attached to each result. Optional; default: summary." },
  evidence_chain_depth: { type: "integer", minimum: 0, description: "Maximum evidence chain depth to include. Optional; default: 1." },
});
const diagnosticsOptionsSchema: JsonSchema = objectSchema({
  diagnostics: { type: "string", enum: ["none", "relevant", "all"], description: "Which diagnostics to include. Optional; default: relevant." },
  diagnostic_detail: { type: "boolean", description: "Include full diagnostic detail bodies rather than summaries only. Optional; default: false." },
});
const snippetsOptionsSchema: JsonSchema = objectSchema({
  mode: { type: "string", enum: ["none", "signature", "relevant", "body"], description: "Source snippet mode. Optional; default: relevant." },
  max_characters_per_snippet: { type: "integer", minimum: 0, description: "Optional; default: 2000." },
  max_total_characters: { type: "integer", minimum: 0, description: "Optional; default: 20000." },
  context_lines: { type: "integer", minimum: 0, description: "Lines of surrounding context per snippet. Optional; default: 2." },
});
const registryOptionsSchema: JsonSchema = objectSchema({
  registry: { type: "string", enum: ["none", "used", "full"], description: "Registry bundle to attach to the response. Optional; default: none." },
  include_payload_schemas: { type: "boolean", description: "Include payload JSON schemas in the registry bundle. Optional; default: false." },
});
const queryOptionsSchema: JsonSchema = objectSchema({
  freshness: { type: "string", enum: ["snapshot", "current", "wait_for_current"], description: "Snapshot pinning policy. Optional; default: current." },
  wait_timeout_ms: { type: "integer", minimum: 0, description: "Optional; default: 0." },
  coverage_requirement: { type: "string", enum: ["accept_reported", "require_complete"], description: "Optional; default: accept_reported." },
  evidence: evidenceOptionsSchema,
  diagnostics: diagnosticsOptionsSchema,
  snippets: snippetsOptionsSchema,
  registry: registryOptionsSchema,
  response_budget: responseBudgetSchema,
});

const operationDefinition = (operationId: string) => operationRegistry.find((operation) => operation.operation_id === operationId);

function operationArgumentSchema(operationId: string): JsonSchema {
  const operation = operationDefinition(operationId);
  if (!operation) throw new Error(`Missing public operation ${operationId}`);
  return canonicalSchema(operation.argument_schema);
}

function intentSchema(operationId: string): JsonSchema {
  const argument = operationArgumentSchema(operationId);
  const argumentProperties = isRecord(argument.properties) ? argument.properties as Record<string, JsonSchema> : {};
  const required = Array.isArray(argument.required) ? argument.required.filter((value): value is string => typeof value === "string") : [];
  return objectSchema({
    api_version: { type: "integer", const: 1 },
    scope: scopeSchema,
    ...argumentProperties,
    options: { ...queryOptionsSchema, description: "Optional; unset fields default to agent-friendly values (see this tool's description)." },
  }, ["api_version", "scope", ...required]);
}

// --- Query expression schema -------------------------------------------
//
// `expression` used to be a bare `{type: "object"}`, which meant 15 of the
// 17 public operations and all 11 intent recipes were reachable only if an
// agent already knew their exact ids and argument shapes from outside
// documentation. Enumerating the real operation/recipe ids here (sourced
// live from the same registries the engine validates against, so they can
// never drift) turns this into something an agent can discover just by
// reading the schema. Per-operation/per-recipe argument shapes are
// intentionally left as a generic object here -- see the server
// `instructions` cheat sheet and each operation's own `description` for the
// exhaustive per-argument documentation; fully inlining all 28 argument
// schemas here would make this one schema enormous.
const operationIds = operationRegistry.map((operation) => operation.operation_id);
const recipeIds = recipeRegistry.map((recipe) => recipe.recipe_id);

const operationExpressionSchema: JsonSchema = objectSchema({
  expression_type: { type: "string", const: "operation" },
  operation: { type: "string", enum: operationIds, description: "One stable core operation id. See the server instructions for the full per-operation argument cheat sheet." },
  arguments: { type: "object", description: "Operation-specific arguments; shape documented in the server instructions and in the selected operation's own description." },
}, ["expression_type", "operation", "arguments"]);

const recipeExpressionSchema: JsonSchema = objectSchema({
  expression_type: { type: "string", const: "recipe" },
  recipe_id: { type: "string", enum: recipeIds, description: "One immutable core intent recipe id, composing several operations into one call. See the server instructions for the full per-recipe argument cheat sheet." },
  recipe_version: { type: "integer", minimum: 1, description: "Optional exact recipe version; omitted resolves to the recipe's current default version." },
  arguments: { type: "object", description: "Recipe-specific arguments; shape documented in the server instructions." },
}, ["expression_type", "recipe_id", "arguments"]);

// --- Pipeline stage_output examples ----------------------------------
//
// Kept as exported constants -- rather than inlined separately into
// buildInstructions()'s prose and into whatever test verifies they work --
// so the documented copy-paste examples and the ones actually exercised
// against a live workspace can never drift apart. Both fuse a lookup and a
// DEPENDENT lookup into ONE urdira_query call by binding a later
// source.operation stage's operation_arguments to an earlier stage's
// output through a `{subject_type: "stage_output", stage_id, output}`
// selector -- legal anywhere a SubjectSelector is legal inside
// operation_arguments (as one element of a Sequence<SubjectSelector> array
// field, standing for the whole referenced stream, or as the scalar value
// of a singular SubjectSelector-shaped field). A source.operation stage's
// own `inputs` array is always empty -- the stage_output selector, not
// `inputs`, is what wires it to an earlier stage.
export const PIPELINE_EXAMPLE_SEARCH_TO_SOURCE = {
  expression_type: "pipeline",
  stages: [
    { stage_id: "search", operator: "source.operation", inputs: [], arguments: { operation: "core:search_text", operation_arguments: { pattern: "InvalidTaskTransitionError", syntax: "literal", word_mode: "identifier" } } },
    { stage_id: "source", operator: "source.operation", inputs: [], arguments: { operation: "core:get_source", operation_arguments: { subjects: [{ subject_type: "stage_output", stage_id: "search", output: "subjects" }], source: { mode: "relevant", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 } } } },
  ],
  outputs: [{ stage_id: "source", output: "sources" }],
} as const;

export const PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES = {
  expression_type: "pipeline",
  stages: [
    { stage_id: "resolve", operator: "source.operation", inputs: [], arguments: { operation: "core:resolve_symbol", operation_arguments: { reference: "TaskService", resolution_scope: "exports" } } },
    { stage_id: "references", operator: "source.operation", inputs: [], arguments: { operation: "core:find_references", operation_arguments: { target: { subject_type: "stage_output", stage_id: "resolve", output: "declarations" }, include_declarations: false } } },
  ],
  outputs: [{ stage_id: "references", output: "references" }, { stage_id: "references", output: "owners" }],
} as const;

const stageOutputReferenceSchema: JsonSchema = objectSchema({ stage_id: { type: "string" }, output: { type: "string" } }, ["stage_id", "output"]);

const pipelineStageSchema: JsonSchema = objectSchema({
  stage_id: { type: "string", description: "Unique identifier for this stage within the pipeline; referenced by later stages' inputs, by a stage_output selector, and by this expression's own outputs." },
  operator: { type: "string", enum: [...queryAlgebraOperatorIds], description: "One core algebra operator. source.operation and expand.operation call one stable operation directly (arguments: {operation, operation_arguments}, plus input_argument for expand.operation) and bind an EARLIER stage's output into operation_arguments via an embedded stage_output selector rather than via inputs. set.union / set.intersection / set.difference (arguments: {}) combine two or more inputs. filter (arguments: {predicate}) narrows one input by a path/language/subject_type/kind/facet/evidence_class predicate (composable with all/any/not). See the server instructions' pipeline section for two verified copy-paste examples." },
  inputs: { type: "array", items: stageOutputReferenceSchema, description: "Declared {stage_id, output} upstream references, each naming a STRICTLY EARLIER stage. Used by set.union/set.intersection/set.difference, filter, expand.relations, join, deduplicate, select, and expand.operation's single batched upstream. source.operation and source.registry always have an EMPTY inputs array; they instead bind an earlier stage's output through a stage_output selector embedded in arguments.operation_arguments." },
  arguments: { type: "object", description: "Operator-specific arguments; shape depends on operator (see this field's sibling operator description and the server instructions)." },
}, ["stage_id", "operator", "inputs", "arguments"]);

const pipelineExpressionSchema: JsonSchema = objectSchema({
  expression_type: { type: "string", const: "pipeline" },
  stages: { type: "array", items: pipelineStageSchema, minItems: 1, description: "An ordered list of core algebra stages. For coding discovery, prefer a pipeline when one result feeds source, references, tests, or impact analysis; bind one stage's output into a later stage's arguments with a stage_output selector. Use a direct operation or recipe for a standalone lookup, or set operators when combining sources -- see the server instructions' \"Fuse dependent lookups into one call\" section." },
  outputs: { type: "array", items: stageOutputReferenceSchema, minItems: 1, description: "Stage {stage_id, output} references exposed as this pipeline's result streams." },
}, ["expression_type", "stages", "outputs"]);

const expressionSchema: JsonSchema = {
  oneOf: [operationExpressionSchema, recipeExpressionSchema, pipelineExpressionSchema],
  description: "Exactly one operation call, recipe call, or advanced pipeline. Most tasks need only expression_type plus operation (or recipe_id) plus arguments.",
} as JsonSchema;

// --- index_status schema -------------------------------------------------
//
// This used to be a hand-validated 3-variant oneOf requiring 5-9 fields
// depending on the variant. The daemon handler already defaults
// `api_version`, coerces `workspace_ids`, and ignores every `include_*`
// flag, so nothing downstream needed that rigidity. It is now one flat,
// fully optional object; `indexStatusPayload` below derives `request_type`
// and `api_version` and always emits the complete payload the daemon
// expects.
const indexStatusSchema: JsonSchema = objectSchema({
  workspace_root: { type: "string", minLength: 1, description: "Exact repository root to register or resolve. Supplying this alone bootstraps or looks up a workspace and returns its workspace_id." },
  workspace_ids: { type: "array", items: { type: "string" }, description: "Explicit workspace ids to check. Optional; default: [] (lists every registered workspace when workspace_root is also absent)." },
  cursor: { type: "string", minLength: 1, description: "A previously returned status cursor; presence continues that page instead of starting a new status request." },
  include_capabilities: { type: "boolean", description: "Optional; default: false." },
  include_plugins: { type: "boolean", description: "Optional; default: false." },
  include_activation_issues: { type: "boolean", description: "Optional; default: false." },
  include_candidate_issues: { type: "boolean", description: "Optional; default: false." },
  include_configuration_issues: { type: "boolean", description: "Only meaningful together with workspace_root. Optional; default: false." },
  response_budget: responseBudgetSchema,
});

const queryRequestSchema: JsonSchema = objectSchema({ api_version: { type: "integer", enum: [1, 2], description: "Query API version. v1 requires a structural snapshot; v2 may bind source-safe operations to source_snapshot_id while structural analysis is still building." }, scope: scopeSchema, expression: expressionSchema, options: { ...queryOptionsSchema, description: "Optional; unset fields default to agent-friendly values (see this tool's description)." } }, ["api_version", "scope", "expression"]);
const continuationSchema: JsonSchema = objectSchema({ api_version: { type: "integer", const: 1 }, scope: scopeSchema, cursor: { type: "string", minLength: 1 }, response_budget: { ...responseBudgetSchema, description: "Optional; defaults to the same agent-friendly budget as a fresh query." } }, ["api_version", "scope", "cursor"]);
const querySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { request_type: { type: "string", enum: ["query", "continuation"] }, query: queryRequestSchema, continuation: continuationSchema },
  required: ["request_type"],
  oneOf: [
    ({ required: ["request_type", "query"], properties: { request_type: { const: "query" } }, not: { required: ["continuation"] } } as unknown as JsonSchema),
    ({ required: ["request_type", "continuation"], properties: { request_type: { const: "continuation" } }, not: { required: ["query"] } } as unknown as JsonSchema),
  ],
};

const toolSchemas: Readonly<Record<UrdiraMcpToolName, JsonSchema>> = {
  urdira_query: querySchema,
  urdira_analyze_change: intentSchema("core:analyze_impact"),
  urdira_build_context: intentSchema("core:build_context"),
  urdira_index_status: indexStatusSchema,
};

const toolTitles: Readonly<Record<UrdiraMcpToolName, string>> = {
  urdira_query: "Query Urdira",
  urdira_analyze_change: "Analyze Change Impact",
  urdira_build_context: "Build Task Context",
  urdira_index_status: "Workspace Index Status",
};

const toolDescriptions: Readonly<Record<UrdiraMcpToolName, string>> = {
  urdira_query: "Execute one public Urdira query, or continue a previous query using its signed cursor. Urdira never infers a workspace: first call urdira_index_status with workspace_root to resolve a workspace_id, then pass it as scope.workspace_id here. Use API v2 with scope.snapshot_id=source_snapshot_id for source-safe find_artifacts, search_text, and artifact get_source while structural analysis is building; API v1 retains its structural-snapshot requirement. expression selects exactly one stable core operation, immutable intent recipe, or advanced pipeline. A pipeline inherits the strongest layer required by its stages. A structural operation issued before structural_ready returns retryable core:coverage_incomplete with the required layer and retry guidance. Results render as compact, grep-like plain text by default.",
  urdira_analyze_change: "Analyze the impact of one explicit hypothetical code change -- a rename, signature change, deletion, or move -- in one already-indexed Urdira workspace. This tool is read-only: it never modifies files. Resolve workspace_id first with urdira_index_status(workspace_root=...). target identifies the exact symbol, entity, or artifact the change applies to, typically obtained from a prior resolve_symbol or search_text call; change describes the hypothetical edit itself. The response reports what will break, what must be updated, what may be affected, which tests to run, and any uncertain dynamic usage, each backed by evidence and, on request, source snippets. options is optional and defaults to agent-friendly evidence, diagnostics, snippet, and response-budget settings; override only what you need. Equivalent to calling urdira_query with expression.operation core:analyze_impact. Results render as compact plain text by default.",
  urdira_build_context: "Build a deterministic, evidence-aware bundle of context for one scoped coding task in an already-indexed Urdira workspace. Resolve workspace_id first with urdira_index_status(workspace_root=...). task is a short natural-language statement of the work to do; seeds are optional starting subjects (entities, symbols, or artifacts), typically obtained from a prior resolve_symbol or search_text call; facets narrow which kinds of context to gather, such as callers, tests, or architecture. The response returns ranked, evidenced result subjects with source snippets sized to fit the response budget -- useful for grounding an edit in one call instead of chaining several individual queries by hand. options is optional and defaults to agent-friendly evidence, diagnostics, snippet, and response-budget settings. Equivalent to calling urdira_query with expression.operation core:build_context. Results render as compact plain text by default.",
  urdira_index_status: "Read Urdira Index Status API v3. Every field is optional. Call with workspace_root set to the exact repository root to resolve or register it, then use the returned workspace_id for every query. source_ready means the immutable source catalog is available, complete, and equivalent to the latest source observation; structural_ready means a complete structural snapshot is published against that source snapshot; semantic_ready means semantic materialization is complete against the current structural snapshot. availability says whether a layer can answer now, completeness says whether its answer is complete (partial is queryable partial data, unknown is not queryable), freshness says equivalent, changes_pending, or degraded, and build_state says not_started, building, idle, failed, or disabled. Use operation_availability to choose safe operations now or retryable blocked operations. API v1/v2 remain accepted for compatibility. Renders as compact actionable lines per workspace; no MCP outputSchema is advertised for client compatibility.",
};

const operationErrorSchema: JsonSchema = objectSchema({ code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" }, recovery_action: { type: "string" }, workspace_id: { type: "string" }, query_execution_id: { type: "string" }, details: { type: "object" } }, ["code", "message", "retryable"]);
const pageSchema: JsonSchema = { type: "object" };
export const MCP_OUTPUT_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, properties: { page: pageSchema, error: operationErrorSchema }, oneOf: [({ required: ["page"], not: { required: ["error"] } } as unknown as JsonSchema), ({ required: ["error"], not: { required: ["page"] } } as unknown as JsonSchema)] };

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new McpProtocolError(`${label} must be an object.`);
  return value;
}

function requireScope(value: unknown): JsonRecord {
  const scope = requireRecord(value, "scope");
  if (scope["scope_type"] === "single_workspace") {
    if (typeof scope["workspace_id"] !== "string" || scope["workspace_id"].length === 0) throw new McpProtocolError("scope.workspaceId is required for a single-workspace scope.");
  } else if (scope["scope_type"] === "comparison") {
    if (!Array.isArray(scope["participants"]) || scope["participants"].length < 2) throw new McpProtocolError("scope.participants must contain at least two workspaces for a comparison scope.");
  } else throw new McpProtocolError("scope.scopeType must be single_workspace or comparison.");
  return scope;
}

function requireApiVersion(value: unknown): number {
  if (value !== 1 && value !== 2) throw new McpProtocolError("apiVersion must be the supported public API version 1 or 2.");
  return value;
}

function queryRequestFromIntent(operationId: string, input: JsonRecord): JsonRecord {
  const apiVersion = requireApiVersion(input["api_version"]);
  const scope = requireScope(input["scope"]);
  const options = mergeQueryOptions(input["options"]);
  const operationArguments = isRecord(input["arguments"]) ? input["arguments"] : Object.fromEntries(Object.entries(input).filter(([key]) => !["api_version", "scope", "options", "render"].includes(key)));
  return { api_version: apiVersion, scope, expression: { expression_type: "operation", operation: operationId, arguments: operationArguments }, options };
}

function queryPayload(input: unknown): { readonly call: string; readonly payload: JsonRecord } {
  const raw = requireRecord(input, "tool arguments");
  const outer = requireRecord(canonicalKeys(raw), "tool arguments");
  const candidate = outer["request_type"] === "query" && isRecord(outer["query"])
    ? outer["query"]
    : outer["request_type"] === "continuation" && isRecord(outer["continuation"])
      ? outer["continuation"]
      : isRecord(outer["request"]) ? outer["request"] : outer;
  const canonical = requireRecord(canonicalKeys(candidate), "query request");
  const apiVersion = requireApiVersion(canonical["api_version"]);
  const scope = requireScope(canonical["scope"]);
  if (typeof canonical["cursor"] === "string") {
    const budget = mergeResponseBudget(canonical["response_budget"]);
    return { call: "core:query_continue", payload: { api_version: apiVersion, scope, cursor: canonical["cursor"], response_budget: budget } };
  }
  if (!isRecord(canonical["expression"])) throw new McpProtocolError("urdira_query requires expression, or cursor.");
  const options = mergeQueryOptions(canonical["options"]);
  return { call: "core:query", payload: { api_version: apiVersion, scope, expression: canonical["expression"], options } };
}

function indexStatusPayload(input: unknown): JsonRecord {
  const canonical = requireRecord(canonicalKeys(requireRecord(input, "tool arguments")), "index status request");
  const rawWorkspaceIds = Array.isArray(canonical["workspace_ids"]) ? canonical["workspace_ids"] : [];
  if (!rawWorkspaceIds.every((value) => typeof value === "string")) throw new McpProtocolError("workspaceIds must be an array of workspace identifiers.");
  const responseBudget = mergeResponseBudget(canonical["response_budget"]);
  const requestedApiVersion = typeof canonical["api_version"] === "number" && [1, 2, 3].includes(canonical["api_version"] as number) ? canonical["api_version"] as number : undefined;
  if (typeof canonical["cursor"] === "string" && canonical["cursor"].length > 0) {
    return { request_type: "continuation", api_version: requestedApiVersion ?? 3, workspace_ids: rawWorkspaceIds, cursor: canonical["cursor"], response_budget: responseBudget };
  }
  const workspaceRoot = typeof canonical["workspace_root"] === "string" && canonical["workspace_root"].length > 0 ? canonical["workspace_root"] : undefined;
  const apiVersion = requestedApiVersion ?? 3;
  const boolField = (field: string): boolean => canonical[field] === true;
  const base: JsonRecord = {
    request_type: "initial",
    api_version: apiVersion,
    workspace_ids: workspaceRoot === undefined ? rawWorkspaceIds : [],
    include_capabilities: boolField("include_capabilities"),
    include_plugins: boolField("include_plugins"),
    include_activation_issues: boolField("include_activation_issues"),
    include_candidate_issues: boolField("include_candidate_issues"),
    response_budget: responseBudget,
  };
  return workspaceRoot === undefined ? base : { ...base, workspace_root: workspaceRoot, include_configuration_issues: boolField("include_configuration_issues") };
}

async function invokeBenchmarkDiscover(
  input: unknown,
  dependencies: { readonly client: UrdiraMcpClient },
  context: UrdiraMcpToolContext = {},
): Promise<CallToolResult> {
  const args = requireRecord(input, "benchmark discovery arguments");
  const workspaceRoot = args["workspace_root"];
  const path = args["path"];
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new McpProtocolError("workspace_root is required.");
  if (typeof path !== "string" || path.length === 0) throw new McpProtocolError("path is required.");
  const requestOptions: LocalIpcRequestOptions = {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.onProgress === undefined ? {} : { on_progress: context.onProgress }),
  };
  const statusResponse = await dependencies.client.call("core:index_status", indexStatusPayload({ workspace_root: workspaceRoot }), requestOptions);
  const statusPayload = statusResponse.outcome === "success" && isRecord(statusResponse.payload) ? statusResponse.payload : undefined;
  const workspace = statusPayload !== undefined && Array.isArray(statusPayload["workspaces"]) && isRecord(statusPayload["workspaces"][0])
    ? statusPayload["workspaces"][0] as JsonRecord
    : undefined;
  const workspaceId = workspace !== undefined && typeof workspace["workspace_id"] === "string" ? workspace["workspace_id"] : undefined;
  const workspaceStatus = workspace !== undefined && typeof workspace["workspace_status"] === "string" ? workspace["workspace_status"] : undefined;
  const freshnessStatus = workspace !== undefined && typeof workspace["freshness_status"] === "string" ? workspace["freshness_status"] : undefined;
  const sourceReady = workspaceId !== undefined && workspace !== undefined && workspace["source_ready"] === true && typeof workspace["source_snapshot_id"] === "string";
  const structuralReady = workspaceId !== undefined && workspace !== undefined && (workspace["structural_ready"] === true || (workspace["structural_ready"] === undefined && (workspaceStatus === "ready" || workspaceStatus === "degraded"))) && (freshnessStatus === undefined || freshnessStatus === "equivalent" || freshnessStatus === "current");
  const ready = structuralReady || sourceReady;
  const result: JsonRecord = {
    internal_calls: ["core:index_status"],
    index_status: statusResponse.outcome === "success"
      ? { workspace_id: workspaceId, workspace_status: workspaceStatus, freshness_status: freshnessStatus, source_ready: workspace?.["source_ready"], structural_ready: workspace?.["structural_ready"], source_snapshot_id: workspace?.["source_snapshot_id"], current_snapshot_id: workspace?.["current_snapshot_id"] }
      : { error: responseError(statusResponse) },
  };
  if (!ready) {
    result["artifact_lookup"] = { skipped: true, reason: "index_not_ready_or_not_current", ...(workspace?.["operation_availability"] === undefined ? {} : { operation_availability: workspace["operation_availability"] }) };
    return { content: [{ type: "text", text: stableJson(result) }] };
  }
  // Artifact discovery is explicitly source-safe. Prefer the source snapshot
  // whenever it is available, even after structural publication, so a narrow
  // path lookup does not pay for the structural record/capability corpus. The
  // structural snapshot remains the fallback for retained pre-source-first
  // workspaces that have no source snapshot.
  const sourceBinding = sourceReady || !structuralReady;
  const queryRequest = {
    request_type: "query",
    query: {
      api_version: sourceBinding ? 2 : 1,
      scope: { scope_type: "single_workspace", workspace_id: workspaceId, ...(sourceBinding ? { snapshot_id: workspace!["source_snapshot_id"] } : {}) },
      expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: { filter: { paths: [path] } } },
    },
  };
  const query = queryPayload(queryRequest);
  const queryResponse = await dependencies.client.call(query.call, query.payload, requestOptions);
  result["internal_calls"] = ["core:index_status", query.call];
  result["artifact_lookup"] = queryResponse.outcome === "success"
    ? { path, result: renderQueryPageText(publicQueryPage(queryResponse.payload, "single_workspace", extractResponseBudget(query.call, query.payload), { render: "text", page_kind: "query" }) as JsonRecord) }
    : { path, error: responseError(queryResponse) };
  return { content: [{ type: "text", text: stableJson(result) }] };
}

function responseError(response: UceResponse): JsonRecord {
  if (response.outcome === "cancelled") return { code: "core:operation_cancelled", message: "The Urdira operation was cancelled.", details: {} };
  if (response.error) return operationError(response.error.code, response.error.message, response.error.details);
  return operationError("core:execution_failed", "The Urdira daemon returned an error without details.");
}

function operationError(code: string, message: string, details: Readonly<Record<string, unknown>> = {}): JsonRecord {
  const definition = operationErrorDefinitions.find((candidate) => candidate.code === code);
  const normalizedDetails = code === "core:workspace_not_registered" && typeof details["registration_command"] !== "string"
    ? { ...details, registration_command: "urdira workspace add <workspace-root>" }
    : details;
  return {
    code,
    message,
    retryable: definition?.retryable_default === true,
    ...(definition?.recovery_actions[0] === undefined ? {} : { recovery_action: definition.recovery_actions[0] }),
    details: normalizedDetails,
  };
}

// --- Public envelope diet --------------------------------------------------
//
// `SnapshotCapabilityStateEntry` rows (packages/contracts/src/models.ts) are
// the engine's internal completeness bookkeeping and can carry hundreds of
// full `sha256:<64hex>` artifact ids per dimension. `dietDimension` maps
// each one to the public `CompletenessDimension` shape from
// docs/decisions/01-universal-data-model.md: an exact count, a small
// deterministic id prefix, and a set id only when the prefix is not the
// complete set.
const DIMENSION_ID_PREFIX_CAP = 8;

function dietDimension(raw: unknown): JsonRecord {
  const entry = isRecord(raw) ? raw : {};
  const ids = Array.isArray(entry["affected_artifact_ids"]) ? (entry["affected_artifact_ids"] as unknown[]).filter((id): id is string => typeof id === "string").slice().sort() : [];
  const exactCount = typeof entry["affected_artifact_count"] === "number" ? entry["affected_artifact_count"] : ids.length;
  const truncatedSet = ids.length > DIMENSION_ID_PREFIX_CAP;
  const prefix = ids.slice(0, DIMENSION_ID_PREFIX_CAP);
  const existingSetId = typeof entry["affected_artifact_set_id"] === "string" ? entry["affected_artifact_set_id"] : undefined;
  const setId = truncatedSet ? existingSetId ?? `sha256:${createHash("sha256").update(ids.join(",")).digest("hex")}` : undefined;
  return {
    workspace_snapshot_binding_ids: Array.isArray(entry["workspace_snapshot_binding_ids"]) ? entry["workspace_snapshot_binding_ids"] : [],
    capability: typeof entry["capability"] === "string" ? entry["capability"] : "",
    status: typeof entry["status"] === "string" ? entry["status"] : "unknown",
    reason_codes: Array.isArray(entry["reason_codes"]) ? entry["reason_codes"] : [],
    affected_artifact_count: exactCount,
    affected_artifact_ids: prefix,
    ...(setId === undefined ? {} : { affected_artifact_set_id: setId }),
    diagnostic_record_ids: Array.isArray(entry["diagnostic_record_ids"]) ? entry["diagnostic_record_ids"] : [],
  };
}

function dietEnvelopeDimensions(envelope: JsonRecord): JsonRecord {
  const report = isRecord(envelope["completeness_report"]) ? envelope["completeness_report"] as JsonRecord : undefined;
  if (report === undefined || !Array.isArray(report["dimensions"])) return envelope;
  return { ...envelope, completeness_report: { ...report, dimensions: report["dimensions"].map(dietDimension) } };
}

// Agents essentially never paginate backwards, and a `previous_cursor` costs
// roughly 1KB per continuable stream. It is never generated by the builder
// below and is stripped here as a defensive backstop for any envelope that
// already arrives pre-shaped (see the early-return branch in
// `publicQueryPage`). `has_previous` is left untouched -- only the cursor
// token itself is omitted.
function stripPreviousCursor(stream: unknown): unknown {
  if (!isRecord(stream) || !("previous_cursor" in stream)) return stream;
  return Object.fromEntries(Object.entries(stream).filter(([key]) => key !== "previous_cursor"));
}

function stripPreviousCursors(envelope: JsonRecord): JsonRecord {
  if (!Array.isArray(envelope["result_sets"])) return envelope;
  const resultSets = (envelope["result_sets"] as JsonRecord[]).map((entry) => ({
    ...entry,
    confirmed: stripPreviousCursor(entry["confirmed"]),
    possible: stripPreviousCursor(entry["possible"]),
  }));
  return { ...envelope, result_sets: resultSets };
}

function bundlesOf(stream: unknown): unknown[] {
  return isRecord(stream) && Array.isArray(stream["result_bundles"]) ? stream["result_bundles"] as unknown[] : [];
}

function countReturnedItems(resultSets: readonly JsonRecord[]): number {
  return resultSets.reduce((total, entry) => total + bundlesOf(entry["confirmed"]).length + bundlesOf(entry["possible"]).length, 0);
}

// `response_budget.max_characters` was validated at the engine layer but
// never enforced anywhere -- this is the enforcement. Shedding proceeds in a
// fixed, deterministic priority order so repeated calls with the same input
// always shed the same way: (1) shrink completeness dimension id prefixes,
// (2) drop optional per-bundle snippet/related-entity payload, (3) drop
// whole trailing result bundles, last result-set first. `returned_characters`
// is then recomputed over the *entire* final envelope (not just the result
// sets) per docs/decisions/01-universal-data-model.md's "first limit reached
// ends hydration" / "enforceable count" language.
function shedToBudget(envelope: JsonRecord, maxCharacters: number, measure: (value: JsonRecord) => number): { readonly envelope: JsonRecord; readonly truncated: boolean; readonly droppedItems: number } {
  let current = envelope;
  let truncated = false;
  let droppedItems = 0;
  if (measure(current) <= maxCharacters) return { envelope: current, truncated, droppedItems };

  const report = isRecord(current["completeness_report"]) ? current["completeness_report"] as JsonRecord : undefined;
  if (report !== undefined && Array.isArray(report["dimensions"])) {
    for (const cap of [4, 2, 1, 0]) {
      if (measure(current) <= maxCharacters) break;
      const dimensions = (report["dimensions"] as JsonRecord[]).map((dimension) => {
        const ids = Array.isArray(dimension["affected_artifact_ids"]) ? dimension["affected_artifact_ids"] as unknown[] : [];
        if (ids.length <= cap) return dimension;
        truncated = true;
        return { ...dimension, affected_artifact_ids: ids.slice(0, cap) };
      });
      current = { ...current, completeness_report: { ...report, dimensions } };
    }
  }

  if (measure(current) > maxCharacters && Array.isArray(current["result_sets"])) {
    const trimBundle = (bundle: unknown): unknown => {
      if (!isRecord(bundle)) return bundle;
      const hasSnippets = Array.isArray(bundle["optional_source_snippets"]) && bundle["optional_source_snippets"].length > 0;
      const hasRelated = Array.isArray(bundle["essential_related_entities"]) && bundle["essential_related_entities"].length > 0;
      if (!hasSnippets && !hasRelated) return bundle;
      truncated = true;
      return { ...bundle, optional_source_snippets: [], essential_related_entities: [] };
    };
    const trimStream = (stream: unknown): unknown => isRecord(stream) && Array.isArray(stream["result_bundles"]) ? { ...stream, result_bundles: (stream["result_bundles"] as unknown[]).map(trimBundle) } : stream;
    const resultSets = (current["result_sets"] as JsonRecord[]).map((entry) => ({ ...entry, confirmed: trimStream(entry["confirmed"]), possible: trimStream(entry["possible"]) }));
    current = { ...current, result_sets: resultSets };
  }

  if (measure(current) > maxCharacters && Array.isArray(current["result_sets"])) {
    const resultSets = [...(current["result_sets"] as JsonRecord[])];
    let guard = 0;
    while (measure({ ...current, result_sets: resultSets }) > maxCharacters && guard < 1_000_000) {
      guard += 1;
      let removed = false;
      for (let index = resultSets.length - 1; index >= 0; index -= 1) {
        const entry = resultSets[index] as JsonRecord;
        const confirmed = entry["confirmed"] as JsonRecord;
        const possible = entry["possible"] as JsonRecord;
        const confirmedBundles = bundlesOf(confirmed);
        const possibleBundles = bundlesOf(possible);
        if (confirmedBundles.length > 0) {
          resultSets[index] = { ...entry, confirmed: { ...confirmed, result_bundles: confirmedBundles.slice(0, -1) } };
          droppedItems += 1; truncated = true; removed = true;
          break;
        }
        if (possibleBundles.length > 0) {
          resultSets[index] = { ...entry, possible: { ...possible, result_bundles: possibleBundles.slice(0, -1) } };
          droppedItems += 1; truncated = true; removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    current = { ...current, result_sets: resultSets };
  }

  return { envelope: current, truncated, droppedItems };
}

// A page's `render` mode changes what an agent actually pays for, so the
// response-budget shedding pass (`shedToBudget` above) must measure against
// whatever string will actually reach the model: the rendered compact text
// in the default "text" mode, or the serialized JSON envelope in "json"
// mode -- not always the latter, which is how this used to work before text
// rendering existed.
export interface RenderContext { readonly render: "text" | "json"; readonly page_kind: "query" | "index_status"; }

function measureForRender(renderContext: RenderContext): (value: JsonRecord) => number {
  if (renderContext.render === "json") return (value) => stableJson(value).length;
  return renderContext.page_kind === "index_status" ? (value) => renderIndexStatusText(value).length : (value) => renderQueryPageText(value).length;
}

function finalizeEnvelope(envelope: JsonRecord, responseBudget: { readonly max_characters?: unknown } | undefined, renderContext: RenderContext): JsonRecord {
  const maxCharacters = typeof responseBudget?.max_characters === "number" && Number.isFinite(responseBudget.max_characters) ? responseBudget.max_characters : undefined;
  const measure = measureForRender(renderContext);
  let current = envelope;
  if (maxCharacters !== undefined) {
    const shed = shedToBudget(current, maxCharacters, measure);
    current = shed.envelope;
    if (shed.truncated) {
      current = {
        ...current,
        returned_items: Array.isArray(current["result_sets"]) ? countReturnedItems(current["result_sets"] as JsonRecord[]) : current["returned_items"],
        truncation: { truncated: true, dropped_items: shed.droppedItems, reason: "response_budget" },
      };
    }
  }
  // `returned_characters` reports what the JSON render actually costs; the
  // text render never surfaces this field (the rendered text itself already
  // shows the agent exactly what it paid), so it is left at its placeholder
  // value rather than recomputed.
  if (renderContext.render !== "json") return current;
  const firstPass = JSON.stringify(stableValue({ ...current, returned_characters: 0 })).length;
  current = { ...current, returned_characters: firstPass };
  const secondPass = JSON.stringify(stableValue(current)).length;
  if (secondPass !== firstPass) current = { ...current, returned_characters: secondPass };
  return current;
}

function buildStreamResultSets(streams: JsonRecord): JsonRecord[] {
  return Object.entries(streams).sort(([left], [right]) => left.localeCompare(right)).map(([resultSet, rawPage]) => {
    const page = isRecord(rawPage) ? rawPage : {};
    const items = Array.isArray(page["items"]) ? page["items"] : [];
    const bundles = items.map((item) => {
      const streamItem = isRecord(item) ? item : {};
      const value = "value" in streamItem ? streamItem["value"] : item;
      if (isRecord(value) && "result_set" in value && "primary_result" in value && "assessment" in value) return value;
      const classification = streamItem["result_classification"] === "possible" ? "possible" : "confirmed";
      return {
        result_set: resultSet,
        primary_result: value,
        assessment: { classification, completeness: "complete" },
        provenance_path: Array.isArray(streamItem["provenance_path"]) ? streamItem["provenance_path"] : [],
        essential_related_entities: [],
        optional_source_snippets: [],
      };
    });
    const stream = { classification: "confirmed", page_mode: "summary", result_bundles: bundles, total: bundles.length, ...(typeof page["next_cursor"] === "string" ? { next_cursor: page["next_cursor"] } : {}), has_next: page["has_next"] === true, has_previous: page["has_previous"] === true };
    return { result_set: resultSet, confirmed: stream, possible: { classification: "possible", page_mode: "summary", result_bundles: [], total: 0, has_next: false, has_previous: false } };
  });
}

function publicQueryPage(value: unknown, scopeKind: "single_workspace" | "comparison" = "single_workspace", responseBudget: { readonly max_characters?: unknown } | undefined, renderContext: RenderContext): unknown {
  if (!isRecord(value)) return value;
  let envelope: JsonRecord;
  if ("result_sets" in value && "completeness_report" in value && "diagnostic_report" in value) {
    envelope = value as JsonRecord;
  } else {
    if (!isRecord(value["streams"])) return value;
    const resultSets = buildStreamResultSets(value["streams"] as JsonRecord);
    const completeness = isRecord(value["completeness"]) ? value["completeness"] : { overall_status: "unknown", dimensions: [] };
    const diagnostics = Array.isArray(value["diagnostics"]) ? value["diagnostics"] : [];
    envelope = {
      query_execution_id: typeof value["query_execution_id"] === "string" ? value["query_execution_id"] : "",
      scope_kind: scopeKind,
      workspace_snapshot_bindings: [],
      semantic_coverage_views: [],
      result_sets: resultSets,
      expires_at: typeof value["expires_at"] === "string" ? value["expires_at"] : "",
      returned_items: countReturnedItems(resultSets),
      returned_characters: 0,
      completeness_report: { workspace_snapshot_binding_ids: [], overall_status: completeness["overall_status"] ?? "unknown", dimensions: Array.isArray(completeness["dimensions"]) ? completeness["dimensions"] : [], diagnostic_record_ids: [] },
      diagnostic_report: { total: diagnostics.length, returned: diagnostics.length, by_severity: { info: 0, warning: 0, error: 0 }, by_completeness_effect: { none: 0, local: 0, capability: 0 }, diagnostics, has_more: false },
      // `index_freshness` (`attachIndexFreshness`, packages/daemon/src/runtime.ts)
      // is stamped onto the raw streams-shaped page the daemon returns, above
      // this envelope's own fields -- carried through explicitly here since it
      // used to be silently dropped (never reached either the JSON page or the
      // text render, so an agent had no way to learn a query answered against
      // a stale/indexing snapshot).
      ...(isRecord(value["index_freshness"]) ? { index_freshness: value["index_freshness"] } : {}),
    };
  }
  envelope = dietEnvelopeDimensions(envelope);
  envelope = stripPreviousCursors(envelope);
  return finalizeEnvelope(envelope, responseBudget, renderContext);
}

function publicIndexStatusPage(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value["workspaces"])) return value;
  const workspaces = value["workspaces"].map((entry) => {
    if (!isRecord(entry)) return entry;
    const sanitized = { ...entry };
    delete sanitized["workspace_root"];
    delete sanitized["canonical_root"];
    delete sanitized["absolute_root"];
    return sanitized;
  });
  return { ...value, workspaces };
}

// --- Compact text projection -------------------------------------------
//
// The JSON envelope above (`publicQueryPage`/`publicIndexStatusPage`) is
// sized for programmatic consumers and typed clients -- an agent reading it
// as a tool result pays for every record id, digest, cursor byte, and
// assessment/completeness scaffolding field even though almost none of that
// is actionable mid-task. Measured against an equivalent `grep`, that
// overhead alone was found to be roughly a 10x context tax per query. The
// functions below render the SAME envelope as compact, information-dense
// plain text -- one line per result, grouped by path like `grep -n`/`ctags`
// output -- which is what `urdira_query`/`urdira_analyze_change`/
// `urdira_build_context`/`urdira_index_status` now emit by default; the
// full JSON page is still available verbatim via `render: "json"` (see
// `renderFieldSchema`) for debugging or programmatic use.
//
// Every field read here is optional and defensively typed: the real
// runtime shape flowing through `buildStreamResultSets` above is the flat
// `recordValue()` object (`packages/engine/src/canonical-query-data-port.ts`)
// -- `{ subject_type, record_id, entity_id?, kind, universal_kind,
// classification, body }` -- NOT the fully-typed `PrimaryResultView` union
// in `packages/contracts/src/models.ts` (`{ result_type, subject, record }`),
// which nothing in the engine actually constructs today. Both are accepted
// here so a future engine change that emits the typed shape degrades
// gracefully rather than rendering garbage. This module intentionally stays
// inside the MCP <-> daemon JSON boundary (no reads of source text, no
// engine/storage imports) per @urdira/mcp's own architecture guardrail:
// it imports only from @urdira/contracts/daemon/engine's public IPC
// surface, so byte-offset-to-line-number conversion (which would need file
// content) is out of scope here -- line numbers are rendered only when a
// producer already attached one, including the source-snippet span produced
// by `core:get_source`, and are omitted otherwise, never fabricated.

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function compactPreview(value: unknown): string {
  const json = stableJson(value);
  return json.length > 100 ? `${json.slice(0, 100)}…` : json;
}

interface BundleDescriptor {
  readonly path?: string | undefined;
  readonly line?: string | undefined;
  readonly label: string;
  readonly snippetText?: string | undefined;
  readonly isMatchStyle: boolean;
}

/** Best-effort line number: only ever present when a producer already attached one (see the module doc comment above) -- never derived from a byte/character offset here. */
function describeLine(body: JsonRecord, span: JsonRecord | undefined): string | undefined {
  return firstNonEmptyString(
    typeof body["start_line"] === "number" ? String(body["start_line"]) : body["start_line"],
    typeof body["line"] === "number" ? String(body["line"]) : body["line"],
    span?.["start_line"],
  );
}

function describeBundle(bundle: JsonRecord, resultSetLabel: string): BundleDescriptor {
  const primary = isRecord(bundle["primary_result"]) ? bundle["primary_result"] as JsonRecord : {};
  // Defensive support for the fully-typed `PrimaryResultView` union
  // (`{ result_type: "entity", subject, record: { payload, kind, ... } }`)
  // alongside the flat `recordValue()` shape everything actually emits today.
  const nestedRecord = isRecord(primary["record"]) ? primary["record"] as JsonRecord : undefined;
  const body: JsonRecord = isRecord(primary["body"]) ? primary["body"] as JsonRecord : nestedRecord && isRecord(nestedRecord["payload"]) ? nestedRecord["payload"] as JsonRecord : {};
  const span = isRecord(primary["source_span"]) ? primary["source_span"] as JsonRecord : undefined;
  const snippets = Array.isArray(bundle["optional_source_snippets"]) ? bundle["optional_source_snippets"] as JsonRecord[] : [];
  const snippetSpan = isRecord(snippets[0]?.["span"]) ? snippets[0]!["span"] as JsonRecord : undefined;

  const path = firstNonEmptyString(body["path"], primary["path"]);
  const line = describeLine(body, span) ?? describeLine({}, snippetSpan);
  const subjectType = firstNonEmptyString(primary["subject_type"], primary["result_type"]);
  const name = firstNonEmptyString(body["qualified_name"], body["name"]);
  const rawKind = firstNonEmptyString(body["kind"]);
  const recordKind = firstNonEmptyString(primary["kind"], nestedRecord?.["kind"], primary["universal_kind"]);

  const snippetText = typeof snippets[0]?.["text"] === "string" ? snippets[0]["text"] as string : undefined;
  // A source bundle may carry a source span solely as the locator for its
  // snippet. Treat only occurrence-level `matches` (or an explicit
  // match_count) as grep-style results; otherwise source retrieval would
  // collapse the snippet to its first line and hide the pipeline's evidence.
  const isMatchStyle = resultSetLabel === "matches" || typeof primary["match_count"] === "number";

  let label: string;
  if (subjectType === "diagnostic") {
    const message = firstNonEmptyString(body["message"]);
    const code = firstNonEmptyString(body["code"]);
    label = message !== undefined ? (code !== undefined ? `${code}: ${message}` : message) : code ?? "diagnostic";
  } else if (subjectType === "relation") {
    label = `(${recordKind ?? "reference"})`;
  } else if (name !== undefined) {
    label = rawKind !== undefined ? `${name} ${rawKind}` : recordKind !== undefined ? `${name} ${recordKind}` : name;
  } else if (recordKind !== undefined) {
    label = recordKind;
  } else {
    label = compactPreview(primary);
  }

  return { path, line, label, snippetText, isMatchStyle };
}

const SNIPPET_LINE_CAP = 12;

function formatDescriptorLine(descriptor: BundleDescriptor, possible: boolean, grouped: boolean): string {
  const suffix = possible ? " [possible]" : "";
  const locator = descriptor.line !== undefined ? `:${descriptor.line}` : "";
  const head = grouped ? locator : descriptor.path !== undefined ? `${descriptor.path}${locator}` : locator;

  if (descriptor.isMatchStyle && descriptor.snippetText !== undefined) {
    const firstLine = descriptor.snippetText.split("\n").find((segment) => segment.trim().length > 0) ?? descriptor.snippetText;
    return `${head.length > 0 ? `${head}: ` : ""}${firstLine.trim()}${suffix}`;
  }

  const primaryLine = `${head.length > 0 ? `${head} ` : ""}${descriptor.label}${suffix}`;
  if (descriptor.snippetText === undefined || descriptor.snippetText.length === 0) return primaryLine;
  const snippetLines = descriptor.snippetText.split("\n").slice(0, SNIPPET_LINE_CAP).map((segment) => `    ${segment}`).join("\n");
  return `${primaryLine}\n${snippetLines}`;
}

/** Groups consecutive same-path descriptors under one `== path ==` header (ripgrep-style), matching grep -n output for a lone match and avoiding repeating the path for a run of several. */
function appendGroupedDescriptors(descriptors: readonly BundleDescriptor[], possible: boolean, lines: string[]): void {
  let index = 0;
  while (index < descriptors.length) {
    let end = index + 1;
    while (end < descriptors.length && descriptors[end]!.path !== undefined && descriptors[end]!.path === descriptors[index]!.path) end += 1;
    const runLength = end - index;
    const path = descriptors[index]!.path;
    if (runLength > 1 && path !== undefined) {
      lines.push(`== ${path} ==`);
      for (let cursor = index; cursor < end; cursor += 1) lines.push(formatDescriptorLine(descriptors[cursor]!, possible, true));
    } else {
      lines.push(formatDescriptorLine(descriptors[index]!, possible, false));
    }
    index = end;
  }
}

function appendStreamLines(resultSetLabel: string, streamPage: unknown, possible: boolean, lines: string[], cursors: { readonly label: string; readonly cursor: string }[]): void {
  if (!isRecord(streamPage)) return;
  const bundles = Array.isArray(streamPage["result_bundles"]) ? streamPage["result_bundles"] as JsonRecord[] : [];
  if (bundles.length > 0) appendGroupedDescriptors(bundles.map((bundle) => describeBundle(bundle, resultSetLabel)), possible, lines);
  if (streamPage["has_next"] === true && typeof streamPage["next_cursor"] === "string" && streamPage["next_cursor"].length > 0) {
    cursors.push({ label: `${resultSetLabel}.${possible ? "possible" : "confirmed"}`, cursor: streamPage["next_cursor"] });
  }
}

function appendFreshnessAndCoverage(page: JsonRecord, lines: string[]): void {
  const freshness = page["index_freshness"];
  if (isRecord(freshness) && typeof freshness["status"] === "string" && freshness["status"] !== "current") {
    const scanError = firstNonEmptyString(freshness["last_scan_error"]);
    lines.push(`STALE: index is ${freshness["status"]}${scanError !== undefined ? ` (${scanError})` : ""}`);
  }
  const completeness = page["completeness_report"];
  if (isRecord(completeness) && typeof completeness["overall_status"] === "string" && completeness["overall_status"] !== "complete") {
    const dimensions = Array.isArray(completeness["dimensions"]) ? completeness["dimensions"] as JsonRecord[] : [];
    const affected = dimensions.reduce((sum, dimension) => sum + (typeof dimension["affected_artifact_count"] === "number" ? dimension["affected_artifact_count"] : 0), 0);
    lines.push(`coverage: ${completeness["overall_status"]}${affected > 0 ? ` (${affected} files affected)` : ""}`);
  }
}

const DIAGNOSTIC_LINE_CAP = 20;

function renderDiagnosticsText(report: JsonRecord): string[] {
  const diagnostics = Array.isArray(report["diagnostics"]) ? report["diagnostics"] as JsonRecord[] : [];
  if (diagnostics.length === 0) return [];
  const lines = [`DIAGNOSTICS: ${diagnostics.length}`];
  for (const diagnostic of diagnostics.slice(0, DIAGNOSTIC_LINE_CAP)) {
    const severity = firstNonEmptyString(diagnostic["severity"]) ?? "info";
    const title = firstNonEmptyString(diagnostic["title"], diagnostic["summary"], diagnostic["message"], diagnostic["code"], diagnostic["diagnostic_code"]) ?? "diagnostic";
    const summary = firstNonEmptyString(diagnostic["summary"]);
    const summarySuffix = summary !== undefined && summary !== title ? `: ${summary}` : "";
    const source = isRecord(diagnostic["source"]) ? diagnostic["source"] as JsonRecord : undefined;
    const path = firstNonEmptyString(source?.["path"], diagnostic["path"]);
    lines.push(`  [${severity}] ${title}${summarySuffix}${path !== undefined ? ` (${path})` : ""}`);
  }
  if (diagnostics.length > DIAGNOSTIC_LINE_CAP) lines.push(`  ... and ${diagnostics.length - DIAGNOSTIC_LINE_CAP} more`);
  return lines;
}

function bundleCountOf(resultSet: JsonRecord): number {
  return bundlesOf(resultSet["confirmed"]).length + bundlesOf(resultSet["possible"]).length;
}

/** Renders a `QueryResultPage`-shaped envelope (see `publicQueryPage`) as compact, grep/ctags-density plain text. This is the default `content[0].text` for `urdira_query`/`urdira_analyze_change`/`urdira_build_context`; the full JSON page is still reachable via `render: "json"`. */
function renderQueryPageText(page: JsonRecord): string {
  const resultSets = Array.isArray(page["result_sets"]) ? page["result_sets"] as JsonRecord[] : [];
  const totalItems = typeof page["returned_items"] === "number" ? page["returned_items"] : resultSets.reduce((sum, resultSet) => sum + bundleCountOf(resultSet), 0);

  if (totalItems === 0) {
    const lines = ["no results", "hint: broaden the search_text pattern (literal substring or safe_regex), try search_semantic for a behavioral description, or confirm scope.workspace_id is correct via urdira_index_status."];
    appendFreshnessAndCoverage(page, lines);
    return lines.join("\n");
  }

  const nonEmptySets = resultSets.filter((resultSet) => bundleCountOf(resultSet) > 0);
  const breakdown = nonEmptySets.length > 1 ? ` (${nonEmptySets.map((resultSet) => `${resultSet["result_set"]}: ${bundleCountOf(resultSet)}`).join(", ")})` : "";
  const lines: string[] = [`# ${totalItems} result${totalItems === 1 ? "" : "s"}${breakdown}`];

  const truncation = page["truncation"];
  if (isRecord(truncation) && truncation["truncated"] === true) {
    const droppedItems = typeof truncation["dropped_items"] === "number" ? truncation["dropped_items"] : 0;
    const reason = firstNonEmptyString(truncation["reason"]) ?? "response_budget";
    lines.push(`TRUNCATED: dropped ${droppedItems} item${droppedItems === 1 ? "" : "s"} (${reason})`);
  }
  appendFreshnessAndCoverage(page, lines);
  lines.push("");

  const showStreamHeaders = nonEmptySets.length > 1;
  const cursors: { readonly label: string; readonly cursor: string }[] = [];
  for (const resultSet of nonEmptySets) {
    const label = firstNonEmptyString(resultSet["result_set"]) ?? "results";
    if (showStreamHeaders) lines.push(`## ${label}`);
    appendStreamLines(label, resultSet["confirmed"], false, lines, cursors);
    appendStreamLines(label, resultSet["possible"], true, lines, cursors);
    if (showStreamHeaders) lines.push("");
  }

  const diagnosticReport = page["diagnostic_report"];
  if (isRecord(diagnosticReport)) {
    const diagnosticLines = renderDiagnosticsText(diagnosticReport);
    if (diagnosticLines.length > 0) { lines.push(...diagnosticLines); lines.push(""); }
  }

  if (cursors.length > 0) {
    if (cursors.length === 1) lines.push(`MORE: pass cursor ${cursors[0]!.cursor.slice(0, 16)}... via request_type=continuation`);
    else for (const entry of cursors) lines.push(`MORE (${entry.label}): pass cursor ${entry.cursor.slice(0, 16)}... via request_type=continuation`);
    lines.push("");
    if (cursors.length === 1) lines.push(cursors[0]!.cursor);
    else for (const entry of cursors) lines.push(`${entry.label}: ${entry.cursor}`);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Renders an `index_status` page (see `publicIndexStatusPage`) as compact plain text: a few lines per workspace. */
function renderIndexStatusText(page: JsonRecord): string {
  const workspaces = Array.isArray(page["workspaces"]) ? page["workspaces"] as JsonRecord[] : [];
  if (workspaces.length === 0) return "no workspaces registered\nhint: call urdira_index_status with workspace_root set to the exact repository root to register one.";

  const lines: string[] = [];
  for (const workspace of workspaces) {
    const id = firstNonEmptyString(workspace["workspace_id"]) ?? "?";
    const root = firstNonEmptyString(workspace["display_root"]);
    const status = firstNonEmptyString(workspace["workspace_status"]) ?? "unknown";
    const freshness = firstNonEmptyString(workspace["freshness_status"]) ?? "unknown";
    const generation = firstNonEmptyString(workspace["current_generation"], workspace["current_snapshot_id"]);
    const sourceReady = workspace["source_ready"] === true ? "yes" : "no";
    const structuralReady = workspace["structural_ready"] === true ? "yes" : "no";
    const semanticReady = workspace["semantic_ready"] === true ? "yes" : "no";
    lines.push(`workspace_id=${id}${root !== undefined ? ` (${root})` : ""}: ${status}, freshness=${freshness}${generation !== undefined ? `, generation=${generation}` : ""}`);
    lines.push(`  ready: source=${sourceReady}, structural=${structuralReady}, semantic=${semanticReady}`);
    const availableOperations = Array.isArray(workspace["available_operations"]) ? workspace["available_operations"].filter((value): value is string => typeof value === "string") : [];
    const blockedOperations = Array.isArray(workspace["blocked_operations"]) ? workspace["blocked_operations"].filter((value): value is string => typeof value === "string") : [];
    if (availableOperations.length > 0) lines.push(`  use now: ${availableOperations.map((operation) => operation.replace(/^core:/, "")).join(", ")}`);
    if (blockedOperations.length > 0) lines.push(`  wait for structural: ${blockedOperations.map((operation) => operation.replace(/^core:/, "")).join(", ")}`);
    const capabilityReason = Array.isArray(workspace["readiness"])
      ? undefined
      : isRecord(workspace["readiness"]) && isRecord(workspace["readiness"]["structural"])
        ? Array.isArray(workspace["readiness"]["structural"]["reason_codes"]) ? workspace["readiness"]["structural"]["reason_codes"].find((value): value is string => typeof value === "string") : undefined
        : undefined;
    if (capabilityReason !== undefined) lines.push(`  typescript symbol resolution: unavailable (${capabilityReason.replace(/^core:/, "")})`);
    const retryAfter = workspace["retry_after_ms"];
    if (typeof retryAfter === "number") lines.push(`  retry_after_ms=${retryAfter}`);

    const lastScanError = firstNonEmptyString(workspace["last_scan_error_code"]);
    if (lastScanError !== undefined) {
      const at = firstNonEmptyString(workspace["last_scan_error_at"]);
      lines.push(`  last_scan_error: ${lastScanError}${at !== undefined ? ` at ${at}` : ""}`);
    }

    const capabilities = Array.isArray(workspace["capabilities"]) ? workspace["capabilities"] as JsonRecord[] : [];
    if (capabilities.length > 0) {
      const byStatus = new Map<string, number>();
      for (const capability of capabilities) {
        const capabilityStatus = firstNonEmptyString(capability["status"]) ?? "unknown";
        byStatus.set(capabilityStatus, (byStatus.get(capabilityStatus) ?? 0) + 1);
      }
      lines.push(`  capabilities: ${capabilities.length} (${[...byStatus.entries()].map(([capabilityStatus, count]) => `${capabilityStatus}: ${count}`).join(", ")})`);
    }

    const plugins = Array.isArray(workspace["plugins"]) ? workspace["plugins"] as JsonRecord[] : [];
    if (plugins.length > 0) lines.push(`  plugins: ${plugins.length}`);
  }
  return lines.join("\n");
}

export interface FormatUrdiraResultOptions {
  /** Optional; default: "text" -- see `renderFieldSchema`. */
  readonly render?: "text" | "json";
  /** Optional; default: "query". Selects which compact-text renderer applies in "text" mode. */
  readonly page_kind?: "query" | "index_status";
}

// A live benchmark (2026-08-14) found that Claude Code's MCP client reads
// ONLY `structuredContent` -- never `content[0].text` -- whenever a tool
// declares an `outputSchema` at all, because the SDK requires
// `structuredContent` on every non-error result once an outputSchema
// exists (see `validateToolOutput` in the installed
// `@modelcontextprotocol/server@2.0.0`). Every Urdira tool used to declare
// one, so agents were silently fed a two-field stub
// (`{page:{returned_items,truncated}}`) instead of the rendered text this
// module builds, making the compact-text rendering below entirely
// invisible in practice. The fix is to not declare `outputSchema` at all
// (see `createUrdiraMcpServer`, which no longer passes `definition
// .output_schema` to `registerTool`): with no outputSchema, the SDK never
// requires `structuredContent`, so `content[0].text` is what a client
// actually reads. `formatUrdiraResult` therefore never emits
// `structuredContent` in any mode -- text, debug `render:"json"`, or
// error -- the full page (or error wrapper) always lives in
// `content[0].text` only. `MCP_OUTPUT_SCHEMA` / `UrdiraMcpToolDefinition
// .output_schema` are kept as an internal reference constant (tests still
// assert its shape) but are no longer advertised to any MCP client.
export function formatUrdiraResult(value: unknown, options: FormatUrdiraResultOptions = {}): CallToolResult {
  const stable = stableValue(value);
  const error = isRecord(stable) && isRecord(stable["error"]) && typeof stable["error"]["code"] === "string" ? stable["error"] : undefined;
  if (error) {
    const mapped = operationError(String(error["code"]), String(error["message"] ?? "Urdira operation failed."), isRecord(error["details"]) ? error["details"] : {});
    for (const field of ["workspace_id", "query_execution_id"]) if (typeof error[field] === "string") mapped[field] = error[field];
    return {
      isError: true,
      content: [{ type: "text", text: stableJson({ error: mapped }) }],
    };
  }
  if (options.render === "json") {
    return {
      content: [{ type: "text", text: stableJson({ page: stable }) }],
    };
  }
  const page = isRecord(stable) ? stable : {};
  const pageKind = options.page_kind ?? "query";
  const text = pageKind === "index_status" ? renderIndexStatusText(page) : renderQueryPageText(page);
  return {
    content: [{ type: "text", text }],
  };
}

function extractResponseBudget(call: string, payload: JsonRecord): { readonly max_characters?: unknown } | undefined {
  if (call === "core:query_continue") return isRecord(payload["response_budget"]) ? payload["response_budget"] as JsonRecord : undefined;
  if (call === "core:query" && isRecord(payload["options"]) && isRecord(payload["options"]["response_budget"])) return payload["options"]["response_budget"] as JsonRecord;
  return undefined;
}

async function invoke(name: UrdiraMcpToolName, input: unknown, dependencies: { client: UrdiraMcpClient }, context: UrdiraMcpToolContext = {}): Promise<CallToolResult> {
  const raw = requireRecord(input, "tool arguments");
  const canonical = canonicalKeys(raw);
  const render: "text" | "json" = isRecord(canonical) && canonical["render"] === "json" ? "json" : "text";
  const indexStatus = name === "urdira_index_status";
  const query = name === "urdira_query" ? queryPayload(input) : undefined;
  const payload = query?.payload ?? (indexStatus ? indexStatusPayload(input) : queryRequestFromIntent(name === "urdira_analyze_change" ? "core:analyze_impact" : "core:build_context", requireRecord(canonical, "tool arguments")));
  const call = query?.call ?? (indexStatus ? "core:index_status" : "core:query");
  const progress = context.onProgress;
  const requestOptions: LocalIpcRequestOptions = {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(progress === undefined ? {} : { on_progress: progress }),
  };
  const response = await dependencies.client.call(call, payload, requestOptions);
  const scopeKind = isRecord(payload["scope"]) && payload["scope"]["scope_type"] === "comparison" ? "comparison" : "single_workspace";
  const responseBudget = extractResponseBudget(call, payload);
  const pageKind: "query" | "index_status" = call === "core:index_status" ? "index_status" : "query";
  const renderContext: RenderContext = { render, page_kind: pageKind };
  const page = response.outcome === "success"
    ? (call === "core:index_status" ? publicIndexStatusPage(response.payload) : publicQueryPage(response.payload, scopeKind, responseBudget, renderContext))
    : { error: responseError(response) };
  return formatUrdiraResult(page, renderContext);
}

export function createUrdiraToolDefinitions(dependencies: { readonly client: UrdiraMcpClient }): readonly UrdiraMcpToolDefinition[] {
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    description: toolDescriptions[name],
    input_schema: toolSchemas[name],
    output_schema: MCP_OUTPUT_SCHEMA,
    invoke: (args: unknown, context?: UrdiraMcpToolContext) => invoke(name, args, dependencies, context),
  }));
}

// --- Server instructions ----------------------------------------------------
//
// Built once from `operationRegistry`/`recipeRegistry` -- the same
// registries the engine validates every request against -- so the cheat
// sheet can never drift out of sync with the real operation and recipe ids.
function buildInstructions(): string {
  const operationLines = operationRegistry.map((operation) => `- ${operation.operation_id}: ${operation.description}`).join("\n");
  const recipeLines = recipeRegistry.map((recipe) => `- ${recipe.recipe_id}: ${recipe.description}`).join("\n");
  return [
    "Urdira is a read-only structural and semantic index of a codebase. It never infers a workspace from the current directory or the MCP connection: every call is explicitly scoped by workspace_id.",
    "",
    "Bootstrap (do this first, once per workspace):",
    "1. Call urdira_index_status with only workspace_root set to the exact repository root. This registers or resolves the workspace and returns its workspace_id.",
    "2. Use that workspace_id as scope.workspace_id in every subsequent urdira_query, urdira_analyze_change, and urdira_build_context call.",
    "3. Resolve a starting point with resolve_symbol or search_text to obtain an entity_id, then use find_references, get_source, or urdira_analyze_change with that entity_id.",
    "Readiness: source_ready means source catalog available, complete, and equivalent to current source; structural_ready means complete structural facts are published against the current source snapshot; semantic_ready means semantic materialization is complete against the current structural snapshot. availability=available/unavailable; completeness=complete/partial/unknown/unsupported/stale; freshness=equivalent/changes_pending/degraded; build_state=not_started/building/idle/failed/disabled. partial is queryable partial data; unknown is not queryable. Use operation_availability and retry_after_ms instead of guessing.",
    "While structural_ready=no, use Query API v2 with scope.snapshot_id set to the returned source_snapshot_id for core:find_artifacts, source-projection core:search_text, and artifact-selector core:get_source. API v1 keeps the existing structural-snapshot requirement. Structural pipelines and recipes remain blocked until structural_ready=yes.",
    "",
    "Minimal urdira_query example (options is fully optional and defaults to agent-friendly values):",
    '{"request_type":"query","query":{"api_version":1,"scope":{"scope_type":"single_workspace","workspace_id":"<workspace_id>"},"expression":{"expression_type":"operation","operation":"core:search_text","arguments":{"pattern":"PaymentService"}}}}',
    "",
    "Which search to use: resolve_symbol for an exact known name; search_text for literal or regex text with path/kind filters; search_semantic or search_hybrid for a natural-language description of behavior when you do not know the exact name or text.",
    "",
    "Edits auto-reindex: Urdira watches the workspace and rescans on file changes. A query issued while a scan is in progress may return a retryable core:index_unavailable error; retry after a short delay or poll urdira_index_status.",
    "",
    "Results render as compact, grep-like plain text by default -- one line per result, grouped by path, with matched/reference lines shown grep -n style -- instead of the full JSON envelope, to keep per-call context cost low. When you have several independent queries to make, issue them as multiple tool calls in the same message rather than one at a time -- it is faster and does not require waiting on each result before issuing the next.",
    "",
    `Operations (${operationRegistry.length} stable core operations; use directly as expression.operation in urdira_query, or via the dedicated urdira_analyze_change / urdira_build_context tools for those two intents):`,
    operationLines,
    "",
    `Recipes (${recipeRegistry.length} immutable multi-step intents composing several operations into one call; use as expression.recipe_id in urdira_query):`,
    recipeLines,
    "",
    "Fuse dependent lookups into one call: expression_type \"pipeline\" runs an ordered list of stages and lets a LATER stage's operation_arguments read an EARLIER stage's output through a stage_output selector -- {\"subject_type\":\"stage_output\",\"stage_id\":\"<earlier stage_id>\",\"output\":\"<its stream name>\"} -- legal anywhere a normal SubjectSelector is legal: as one element of a Sequence<SubjectSelector> array field (standing for the whole referenced stream) or as a singular field's whole value (takes the first item). Each stage is {stage_id, operator, inputs, arguments}. source.operation stages always have inputs:[] and bind through the embedded stage_output selector instead; set.union/set.intersection/set.difference and filter read their input(s) through the inputs array. outputs is a list of {stage_id, output} references to expose as this pipeline's result streams. For coding tasks, make this the default shape: search or resolve first, then feed its subjects into get_source, find_references, find_related_tests, or analyze_impact. Use the upstream \"subjects\" stream when you want one result per artifact/entity; use \"matches\" only when each textual occurrence is relevant.",
    "",
    "Pipeline example (a): search a literal pattern, then fetch source for every match, in one call:",
    JSON.stringify({ request_type: "query", query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "<workspace_id>" }, expression: PIPELINE_EXAMPLE_SEARCH_TO_SOURCE } }),
    "",
    "Pipeline example (b): resolve a symbol, then find references to exactly the declaration that resolved, in one call:",
    JSON.stringify({ request_type: "query", query: { api_version: 1, scope: { scope_type: "single_workspace", workspace_id: "<workspace_id>" }, expression: PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES } }),
  ].join("\n");
}

export const MCP_SERVER_INSTRUCTIONS: string = buildInstructions();

function mcpContext(context: ServerContext, lifecycle: { active: boolean }): UrdiraMcpToolContext {
  const requestMeta = context.mcpReq._meta as Record<string, unknown> | undefined;
  const progressToken = requestMeta?.["progressToken"];
  let lastCompleted = -Infinity;
  return {
    signal: context.mcpReq.signal,
    onProgress: (progress) => {
      if (!lifecycle.active || context.mcpReq.signal.aborted || progress.completed < lastCompleted) return;
      lastCompleted = progress.completed;
      if (progressToken === undefined) return;
      void context.mcpReq.notify({ method: "notifications/progress", params: { progressToken, ...progress } });
    },
  };
}

// --- Hidden render escape hatch (validator layer only) ----------------------
//
// `render` is no longer a property of any tool's advertised input_schema (see
// the comment above `renderFieldSchema`), but the runtime must still accept
// an explicit render:"json" -- `invoke()` above still reads it off the raw
// args. Every tool schema sets `additionalProperties: false`, and the real
// MCP wire path (`createUrdiraMcpServer` -> the SDK's `tools/call` handler)
// validates incoming arguments against the schema with AJV BEFORE `invoke()`
// ever runs, so a caller-supplied `render` would otherwise be rejected as an
// unknown property at the validation layer, never reaching `invoke()`.
//
// The fix keeps the two schema surfaces distinct: the schema AJV validates
// against (`withHiddenRenderProperty`) quietly re-admits `render`, while the
// schema advertised to clients via `tools/list` (`jsonSchema.input()` /
// `jsonSchema.output()`, read by the SDK from the Standard Schema object)
// stays exactly `definition.input_schema` -- the public, render-free schema.
// A client that never learns `render` exists from the schema, description,
// or instructions has no way to discover it; a client (or debugger) that
// already knows to pass render:"json" still gets it honored.
function withHiddenRenderProperty(schema: JsonSchema): JsonSchema {
  if (!isRecord(schema) || !isRecord(schema["properties"])) return schema;
  return { ...schema, properties: { ...(schema["properties"] as Record<string, JsonSchema>), render: renderFieldSchema } } as JsonSchema;
}

function hiddenRenderInputSchema(publicSchema: JsonSchema): ReturnType<typeof fromJsonSchema> {
  const validated = fromJsonSchema(withHiddenRenderProperty(publicSchema) as unknown as JsonSchemaType);
  return {
    "~standard": {
      ...validated["~standard"],
      jsonSchema: { input: () => publicSchema as unknown, output: () => publicSchema as unknown },
    },
  } as ReturnType<typeof fromJsonSchema>;
}

export function createUrdiraMcpServer(dependencies: { readonly client: UrdiraMcpClient }, options: Pick<ServeUrdiraStdioOptions, "tool_names" | "instructions" | "compact" | "benchmark_discover"> = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} }, instructions: options.instructions ?? MCP_SERVER_INSTRUCTIONS });
  const allowedTools = options.tool_names === undefined ? undefined : new Set(options.tool_names);
  for (const definition of createUrdiraToolDefinitions(dependencies).filter((entry) => allowedTools === undefined || allowedTools.has(entry.name))) {
    const compactSchema: JsonSchema | undefined = options.compact
      ? definition.name === "urdira_index_status"
        ? { type: "object", additionalProperties: false, properties: { workspace_root: { type: "string" } }, required: ["workspace_root"] }
        : definition.name === "urdira_query"
        ? { type: "object", additionalProperties: false, properties: { request_type: { const: "query" }, query: { type: "object", additionalProperties: true } }, required: ["request_type", "query"] }
        : undefined
      : undefined;
    const schema = hiddenRenderInputSchema(compactSchema ?? definition.input_schema);
    // No `outputSchema` is registered here -- see the comment above
    // `formatUrdiraResult` for why: declaring one forces `structuredContent`
    // on every result and Claude Code's MCP client reads only that field
    // when a tool has an outputSchema, making the rendered
    // `content[0].text` invisible to the agent. `definition.output_schema`
    // (`MCP_OUTPUT_SCHEMA`) is kept on `UrdiraMcpToolDefinition` for
    // internal reference and tests only; it is never advertised in
    // `tools/list`.
    server.registerTool(definition.name, {
      title: toolTitles[definition.name],
      description: definition.description,
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args, context) => {
      const lifecycle = { active: true };
      try {
        return await definition.invoke(args, mcpContext(context, lifecycle));
      } catch (error) {
        if (error instanceof McpProtocolError) throw ProtocolError.fromError(-32602, error.message);
        throw error;
      } finally {
        lifecycle.active = false;
      }
    });
  }
  if (options.benchmark_discover === true) {
    const schema: JsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: { workspace_root: { type: "string" }, path: { type: "string" } },
      required: ["workspace_root", "path"],
    };
    server.registerTool("urdira_benchmark_discover", {
      title: "Benchmark Discovery",
      description: "Benchmark-only adapter: resolve one workspace and discover one exact artifact path in a single call.",
      inputSchema: hiddenRenderInputSchema(schema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args, context) => {
      const lifecycle = { active: true };
      try {
        return await invokeBenchmarkDiscover(args, dependencies, mcpContext(context, lifecycle));
      } catch (error) {
        if (error instanceof McpProtocolError) throw ProtocolError.fromError(-32602, error.message);
        throw error;
      } finally {
        lifecycle.active = false;
      }
    });
  }
  return server;
}

export function serveUrdiraStdio(dependencies: { readonly client: UrdiraMcpClient }, options: ServeUrdiraStdioOptions = {}): StdioServerHandle {
  const { tool_names: _toolNames, instructions: _instructions, compact: _compact, benchmark_discover: _benchmarkDiscover, ...stdioOptions } = options;
  return serveStdio(() => createUrdiraMcpServer(dependencies, { ...(options.tool_names === undefined ? {} : { tool_names: options.tool_names }), ...(options.instructions === undefined ? {} : { instructions: options.instructions }), ...(options.compact === undefined ? {} : { compact: options.compact }), ...(options.benchmark_discover === undefined ? {} : { benchmark_discover: options.benchmark_discover }) }), { ...stdioOptions, legacy: "serve" });
}
