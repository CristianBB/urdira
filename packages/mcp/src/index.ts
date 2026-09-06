import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  ProtocolError,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createHash } from "node:crypto";
import { buildQueryAdmissionPlan } from "@urdira/engine";
import type { LocalIpcRequestOptions, IpcProgress, IpcResponse } from "@urdira/daemon";
import { operationErrorDefinitions, operationRegistry, queryAlgebraOperatorIds, recipeRegistry, toCanonicalName, type JsonSchema, type QueryRequest } from "@urdira/contracts";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_SERVER_NAME = "urdira" as const;
export const MCP_SERVER_VERSION = "0.3.3" as const;

export const MCP_TOOL_NAMES = [
  "urdira_query",
  "urdira_context",
  "urdira_analyze_change",
  "urdira_build_context",
  "urdira_index_status",
] as const;

export type UrdiraMcpToolName = (typeof MCP_TOOL_NAMES)[number];
export type McpPresentationProfile = "agent" | "web";
export type UrdiraProgress = IpcProgress["progress"];

export interface UrdiraMcpClient {
  readonly call: (call: string, payload: unknown, options?: LocalIpcRequestOptions) => Promise<IpcResponse>;
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
  // Schema IR composes named union aliases, so SubjectSelector contains an
  // ArtifactSubjectSelector branch which itself is a oneOf. JSON Schema's
  // additionalProperties:false on that alias wrapper would otherwise reject
  // both valid artifact variants before evaluating the nested union. Flatten
  // alias-only branches while preserving every concrete closed variant.
  if (Array.isArray(result["oneOf"])) {
    result["oneOf"] = (result["oneOf"] as unknown[]).flatMap((option) => isRecord(option)
      && !isRecord(option["properties"])
      && Array.isArray(option["oneOf"])
      ? option["oneOf"] as unknown[]
      : [option]);
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
const MAX_MCP_PAGE_ITEMS = 50;
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
  const merged = deepMergeDefaults(DEFAULT_QUERY_OPTIONS, supplied);
  // v3 exposes freshness as a small readiness barrier object so an agent can
  // request the frontier it needs without a separate status call. The engine
  // retains its closed v1/v2 representation internally; normalize the public
  // object at this adapter boundary and preserve the timeout semantics.
  const freshness = merged["freshness"];
  if (isRecord(freshness)) {
    const mode = freshness["mode"];
    if (mode === "current" || mode === "wait") merged["freshness"] = mode === "wait" ? "wait_for_current" : "current";
    const timeout = freshness["timeout_ms"];
    if (typeof timeout === "number") merged["wait_timeout_ms"] = timeout;
    const frontier = freshness["required_frontier"];
    if (["source", "syntax", "structural", "semantic"].includes(String(frontier))) merged["required_frontier"] = frontier;
  }
  const responseBudget = merged["response_budget"];
  if (isRecord(responseBudget) && typeof responseBudget["max_items"] === "number") {
    // The local IPC frame is bounded. Query manifests and cursors are already
    // immutable, so cap the first MCP page and let the signed cursor expose
    // the remainder instead of allowing a large but valid query to fail while
    // serialising the daemon response.
    responseBudget["max_items"] = Math.min(MAX_MCP_PAGE_ITEMS, responseBudget["max_items"]);
  }
  return merged;
}

function mergeResponseBudget(supplied: unknown): JsonRecord {
  const merged = deepMergeDefaults(DEFAULT_RESPONSE_BUDGET, supplied);
  if (typeof merged["max_items"] === "number") merged["max_items"] = Math.min(MAX_MCP_PAGE_ITEMS, merged["max_items"]);
  return merged;
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
  description: "Output projection for this call. Optional; default: text -- a compact, grep-like plain-text rendering instead of the full JSON envelope. Source bundles retain all snippet text admitted by the query response budget. Pass \"json\" to get the complete structured page (result ids, digests, completeness/diagnostic scaffolding, cursors) for debugging or programmatic consumption.",
};

// Plan 2026-09-06 (Frente N, §5.1.3): a hidden top-level debug knob, added
// and hidden the exact same way as `render` right above -- never advertised
// in any tool's input_schema, description, or MCP_SERVER_INSTRUCTIONS, for
// the identical reason the comment above `renderFieldSchema` gives (a
// visible knob gets used reflexively, re-inflating the response an agent
// pays for). Decided in implementation: the plan's own text describes this
// as living "in response_budget", but `response_budget` (nested under
// `options`, or top-level for a continuation/index-status request) is part
// of the payload forwarded verbatim to the engine, whose own
// `options.response_budget` validation (`query-plan.ts`'s `validateBudget`,
// an `exactObject` over exactly `max_items`/`max_characters`) would reject
// any extra field -- accepting it there would need this MCP adapter to
// thread it through and strip it back out at every one of the four
// `response_budget`-embedding payload-construction sites
// (`queryPayload`'s two branches, `queryRequestFromIntent`,
// `indexStatusPayload`'s two branches) before the engine ever sees it.
// Living beside `render` avoids all of that: it is read directly off the
// raw tool call arguments in `invoke()` below and never enters `options`/
// `response_budget`/the outgoing IPC payload at all, so the engine's schema
// is completely unaware of it.
//
// Adversarial review 2026-09-06 (Frente N, R13/§0 performance criterion):
// because of the above, `snippet_lines: 0` is RENDER-ONLY -- it never
// reaches `CanonicalRecordQueryDataPort`'s SNIPPET_POLICY hydration, which
// always runs (and always pays its `artifact_text` CAS read/decode) for
// every eligible bundle regardless of what the MCP caller passes here. A
// caller setting `snippet_lines: 0` gets a smaller rendered response, not a
// cheaper query. This is an accepted, documented tradeoff (not a bug to
// silently fix by re-threading a fifth field through
// `response_budget`'s exact-object validation, per the reasoning above) --
// see `docs/decisions/01-universal-data-model.md`'s 2026-09-06 amendment
// for the same caveat at the contract-doc layer.
const snippetLinesFieldSchema: JsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: 3,
  description: "Number of source-snippet lines rendered inline per compact-text result for structural/discovery bundles (core:find_references/core:get_outline/core:search_hybrid/core:search_semantic). Optional; default: 1. 0 disables inline snippet lines (rendering only -- the engine still hydrates the snippet server-side).",
};

const DEFAULT_SNIPPET_LINES = 1;

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
  freshness: objectSchema({
    mode: { type: "string", enum: ["current", "wait"], description: "Use the current published snapshot or wait for the requested frontier." },
    required_frontier: { type: "string", enum: ["source", "syntax", "structural", "semantic"], description: "Frontier required before execution." },
    timeout_ms: { type: "integer", minimum: 0, description: "Maximum wait in milliseconds." },
  }, ["mode", "required_frontier", "timeout_ms"]),
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

function intentSchema(operationId: string, apiVersions: readonly number[] = [3]): JsonSchema {
  const argument = operationArgumentSchema(operationId);
  const argumentProperties = isRecord(argument.properties) ? argument.properties as Record<string, JsonSchema> : {};
  const required = Array.isArray(argument.required) ? argument.required.filter((value): value is string => typeof value === "string") : [];
  return objectSchema({
    api_version: apiVersions.length === 1 ? { type: "integer", const: apiVersions[0]! } : { type: "integer", enum: [...apiVersions] },
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
    { stage_id: "search", stage_type: "operation", operation: "core:search_text", operation_version: 3, arguments: { pattern: "InvalidTaskTransitionError", syntax: "literal", word_mode: "identifier", result_projection: "artifact" } },
    { stage_id: "source", stage_type: "operation", operation: "core:get_source", operation_version: 3, arguments: { source: { mode: "relevant", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 } }, bindings: { subjects: { stage_id: "search", output: "subjects" } } },
  ],
  outputs: [{ name: "sources", stage_id: "source", output: "sources" }],
} as const;

export const PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES = {
  expression_type: "pipeline",
  stages: [
    { stage_id: "resolve", stage_type: "operation", operation: "core:resolve_symbol", operation_version: 3, arguments: { reference: "TaskService", resolution_scope: "exports" } },
    { stage_id: "references", stage_type: "operation", operation: "core:find_references", operation_version: 3, arguments: { include_declarations: false }, bindings: { target: { stage_id: "resolve", output: "declarations" } } },
  ],
  outputs: [{ name: "references", stage_id: "references", output: "references" }, { name: "owners", stage_id: "references", output: "owners" }],
} as const;

/** Canonical three-stage example: resolve once, reuse the exact declaration
 * for reference discovery, then hydrate source for every owning artifact. */
export const PIPELINE_EXAMPLE_RESOLVE_REFERENCES_TO_SOURCE = {
  expression_type: "pipeline",
  stages: [
    { stage_id: "resolve", stage_type: "operation", operation: "core:resolve_symbol", operation_version: 3, arguments: { reference: "TaskService", resolution_scope: "exports" } },
    { stage_id: "references", stage_type: "operation", operation: "core:find_references", operation_version: 3, arguments: { include_declarations: false }, bindings: { target: { stage_id: "resolve", output: "declarations" } } },
    { stage_id: "source", stage_type: "operation", operation: "core:get_source", operation_version: 3, arguments: { source: { mode: "relevant", max_characters_per_snippet: 2000, max_total_characters: 20_000, context_lines: 2 } }, bindings: { subjects: { stage_id: "references", output: "owners" } } },
  ],
  outputs: [{ name: "references", stage_id: "references", output: "references" }, { name: "sources", stage_id: "source", output: "sources" }],
} as const;

// v3 uses explicit bindings instead of embedding a stage-output selector in
// an operation's argument tree. The engine lowers this closed shape to the
// internal algebra without materialising upstream arrays.
const pipelineV3BindingSchema: JsonSchema = {
  ...objectSchema({
    stage_id: { type: "string", minLength: 1, description: "Earlier stage_id that produced the data. The referenced stage must precede this dependent stage." },
    output: { type: "string", minLength: 1, description: "Exact registered output stream name from that earlier operation, such as subjects, declarations, references, owners, or sources. Consult the operation catalog in the server instructions; never invent or derive this name from result_projection." },
  }, ["stage_id", "output"]),
  description: "One typed edge in the pipeline DAG. It passes the complete upstream logical set without copying opaque ids or materialising a client-side array.",
};
const pipelineV3StageSchema: JsonSchema = {
  oneOf: [
    objectSchema({
      stage_id: { type: "string", minLength: 1 },
      stage_type: { type: "string", const: "operation" },
      operation: { type: "string", enum: operationIds, description: "Registered operation id. The field name is exactly operation; never use core, operator, or operation_id here." },
      operation_version: { type: "integer", minimum: 1 },
      arguments: { type: "object", description: "Static arguments only for this operation. Omit every argument supplied through bindings; a bound argument must not also appear here." },
      bindings: { type: "object", additionalProperties: pipelineV3BindingSchema, description: "Optional dependency map. Each property name is the exact downstream argument name to fill; its value identifies an earlier {stage_id, output}. Example: subjects: {stage_id: \"search\", output: \"subjects\"}." },
    }, ["stage_id", "stage_type", "operation", "arguments"]),
    objectSchema({
      stage_id: { type: "string", minLength: 1 },
      stage_type: { type: "string", const: "operator" },
      operator: { type: "string", enum: [...queryAlgebraOperatorIds] },
      arguments: { type: "object", description: "Static arguments for this registered algebra operator." },
      inputs: { type: "array", items: pipelineV3BindingSchema, description: "Typed upstream streams consumed by this operator, in the operator's declared input order." },
    }, ["stage_id", "stage_type", "operator", "arguments"]),
  ],
  description: "Exactly one v3 operation or operator stage. An operation stage uses the exact field operation (never core, operator, or operation_id); operation and operator fields may not be mixed.",
};
const pipelineV3OutputSchema: JsonSchema = objectSchema({
  name: { type: "string", minLength: 1, description: "Stable response alias chosen by the caller." },
  stage_id: { type: "string", minLength: 1, description: "Stage whose stream should be returned." },
  output: { type: "string", minLength: 1, description: "Exact registered stream name produced by that stage." },
}, ["name", "stage_id", "output"]);
const pipelineV3ExpressionSchema: JsonSchema = objectSchema({
  expression_type: { type: "string", const: "pipeline" },
  stages: { type: "array", items: pipelineV3StageSchema, minItems: 1, description: "Operations and algebra operators in dependency order. Independent stages may run concurrently; bindings establish the topological order for dependent stages." },
  outputs: { type: "array", items: pipelineV3OutputSchema, minItems: 1, description: "Named final streams returned to the agent. Intermediate streams remain inside the pipeline unless explicitly listed here." },
}, ["expression_type", "stages", "outputs"]);

const expressionSchema: JsonSchema = {
  oneOf: [operationExpressionSchema, recipeExpressionSchema, pipelineV3ExpressionSchema],
  description: "Exactly one v3 operation call, recipe call, or binding-oriented pipeline.",
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

const queryRequestSchema: JsonSchema = objectSchema({ api_version: { type: "integer", const: 3, description: "Query API version v3." }, scope: scopeSchema, expression: expressionSchema, options: { ...queryOptionsSchema, description: "Optional; unset fields default to agent-friendly values (see this tool's description)." } }, ["api_version", "scope", "expression"]);
const continuationSchema: JsonSchema = objectSchema({ api_version: { type: "integer", const: 3 }, scope: scopeSchema, cursor: { type: "string", minLength: 1 }, response_budget: { ...responseBudgetSchema, description: "Optional; defaults to the same agent-friendly budget as a fresh query." } }, ["api_version", "scope", "cursor"]);
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
  urdira_context: intentSchema("core:build_context", [3]),
  urdira_analyze_change: intentSchema("core:analyze_impact"),
  urdira_build_context: intentSchema("core:build_context"),
  urdira_index_status: indexStatusSchema,
};

const BUILD_CONTEXT_FACETS = [
  "definitions",
  "implementations",
  "callers",
  "callees",
  "dependencies",
  "contracts",
  "effects",
  "tests",
  "configuration",
  "analogues",
  "extension_points",
] as const;

/**
 * The MCP SDK validates tool arguments before invoking our handler. Its AJV
 * error for an invalid enum only says "must be equal to one of the allowed
 * values", which leaves an agent unable to repair a call when the enum is
 * large or was not retained by the client. Keep the closed enum in the
 * advertised schema and enrich the validator-side diagnostic with the exact
 * registered values.
 */
const defaultMcpJsonSchemaValidator = new AjvJsonSchemaValidator();
const diagnosticMcpJsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    const validate = defaultMcpJsonSchemaValidator.getValidator<T>(schema);
    return (input: unknown) => {
      const result = validate(input);
      if (result.valid || !result.errorMessage) return result;
      if (result.errorMessage.includes("data/facets/") && result.errorMessage.includes("allowed values")) {
        return {
          valid: false as const,
          data: undefined,
          errorMessage: `${result.errorMessage}; valid facets: ${BUILD_CONTEXT_FACETS.join(", ")}`,
        };
      }
      return result;
    };
  },
};

const toolTitles: Readonly<Record<UrdiraMcpToolName, string>> = {
  urdira_query: "Query Urdira",
  urdira_context: "Build Urdira Context",
  urdira_analyze_change: "Analyze Change Impact",
  urdira_build_context: "Build Task Context",
  urdira_index_status: "Workspace Index Status",
};

const buildContextFacetContract = operationDefinition("core:build_context")?.argument_fields.find((field) => field.name === "facets")?.logical_type;
if (buildContextFacetContract === undefined) throw new Error("core:build_context must register its facets argument contract");

const toolDescriptions: Readonly<Record<UrdiraMcpToolName, string>> = {
  urdira_query: "Run one custom Urdira query after resolving query_scope with urdira_index_status. Choose exactly one expression: operation for one lookup, recipe for a registered standard workflow, or pipeline when a later lookup depends on an earlier result; use the continuation request variant only with a signed cursor returned by Urdira. For dependent work, use one pipeline instead of copying ids between MCP calls. A pipeline stage keeps static values in arguments; bindings maps a downstream argument name to an earlier {stage_id, output} and passes the complete upstream set. Minimal data flow: search -> source means search outputs subjects, then the source stage declares bindings.subjects={stage_id:\"search\",output:\"subjects\"}. List only the final streams to return in pipeline outputs. Output names are operation-specific and are not result_projection values. Scalar bindings require exactly one upstream item; sequence arguments consume the whole set. Source-safe operations (find_artifacts, search_text, get_source) can run at source_ready; structural and semantic operations wait for their registered frontier. Guardrails: get_outline.container accepts only an artifact or entity selector. get_source source.mode must be signature, relevant, or body; never none. search_text pipeline outputs are only matches and subjects, never artifacts. Results render as compact plain text by default.",
  urdira_context: `Use this as the default first choice for an ordinary coding task when you want definitions, callers, dependencies, tests, contracts, or extension points together and do not need custom stage wiring. It is the readiness-aware agent wrapper around core:build_context: it waits for the structural frontier by default and, if that wait expires, returns a compact notice naming source/syntax operations usable immediately. api_version: 3 is a required top-level field; scope, task, and facets are also required. Optional seeds anchor known subjects. All overrides stay inside options. Facets use exactly: ${buildContextFacetContract}. public_surfaces is an architecture view, not a context facet. Use urdira_query only when a registered recipe or custom pipeline is more precise.`,
  urdira_analyze_change: "Use this for one explicit hypothetical rename, signature change, deletion, move, type, visibility, contract, or behavior change. It is strictly read-only. Supply the exact target returned by prior discovery plus the change descriptor; receive will_break, must_update, may_be_affected, tests_to_run, and uncertain_dynamic_usage with evidence. Prefer this dedicated tool over constructing core:analyze_impact manually. Resolve and copy query_scope from urdira_index_status first.",
  urdira_build_context: "Use this explicit core:build_context wrapper when you already know the desired task, facets, and optional seed subjects and want the ordinary query-operation behavior. Required fields are api_version:3, scope, task, and facets; options is optional. For a general agent task prefer urdira_context because it adds readiness-aware degradation guidance. For custom dependent stages use urdira_query with a pipeline.",
  urdira_index_status: "Always call this first with only workspace_root set to the exact repository root. It resolves or registers the workspace and returns a copy-ready query_scope; reuse that object byte-for-byte in every later tool and never synthesize its opaque workspace_id. It also reports source, syntax, structural, and semantic readiness plus operation_availability, retryability, scan failures, and retry timing. For a v4 workspace it additionally reports per-lane generations (structural queryable/durable, lexical/semantic completed) and the last scan's kind, changed paths, and timings, so search_text/search_semantic can be seen as partial until their lane catches up. Call it again only when readiness or indexing state matters. Every input field is optional; no api_version or scope belongs in this tool.",
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
  if (value !== 3) throw new McpProtocolError("apiVersion must be the supported public API version 3.");
  return value;
}

function queryRequestFromIntent(operationId: string, input: JsonRecord): JsonRecord {
  const apiVersion = requireApiVersion(input["api_version"]);
  const scope = requireScope(input["scope"]);
  const options = mergeQueryOptions(input["options"]);
  // Context is a complete-facets contract, not a best-effort structural
  // projection.  Its intent wrapper therefore waits for the structural
  // frontier by default; callers can still provide an explicit freshness
  // policy when they need a different bounded behaviour.
  if (operationId === "core:build_context" && (!isRecord(input["options"]) || !("freshness" in (input["options"] as JsonRecord)))) {
    options["freshness"] = "wait_for_current";
    options["required_frontier"] = "structural";
    options["wait_timeout_ms"] = 30_000;
  }
  const operationArguments = isRecord(input["arguments"]) ? input["arguments"] : Object.fromEntries(Object.entries(input).filter(([key]) => !["api_version", "scope", "options", "render"].includes(key)));
  return { api_version: apiVersion, scope, expression: { expression_type: "operation", operation: operationId, arguments: operationArguments }, options };
}

function validateQueryBeforeIpc(payload: JsonRecord): void {
  try {
    buildQueryAdmissionPlan(payload as unknown as QueryRequest);
  } catch (error) {
    if (error instanceof Error) {
      const details = isRecord((error as Error & { readonly details?: unknown }).details) ? (error as Error & { readonly details: Record<string, unknown> }).details : undefined;
      const pointer = details !== undefined && typeof details["schema_pointer"] === "string"
        ? details["schema_pointer"]
        : details !== undefined && typeof details["object_pointer"] === "string" ? details["object_pointer"] : undefined;
      const received = details?.["received"];
      const example = details?.["example"];
      const render = (value: unknown): string => {
        try {
          const encoded = JSON.stringify(value);
          return encoded.length > 480 ? `${encoded.slice(0, 477)}...` : encoded;
        } catch {
          return String(value);
        }
      };
      const suffix = [
        pointer === undefined ? undefined : `pointer ${pointer}`,
        received === undefined ? undefined : `received ${render(received)}`,
        example === undefined ? undefined : `example ${render(example)}`,
      ].filter((value): value is string => value !== undefined).join("; ");
      throw new McpProtocolError(`${error.message}${suffix.length === 0 ? "" : ` (${suffix})`}`);
    }
    throw new McpProtocolError("Query does not match the published API v3 schema. Example: {\"api_version\":3,\"scope\":{\"scope_type\":\"single_workspace\",\"workspace_id\":\"<workspace_id>\"},\"expression\":{\"expression_type\":\"operation\",\"operation\":\"core:find_artifacts\",\"arguments\":{}}}");
  }
}

function assertPublicQueryFields(query: JsonRecord): void {
  const allowed = new Set(["request_type", "api_version", "scope", "expression", "options", "cursor", "response_budget"]);
  for (const key of Object.keys(query)) {
    if (allowed.has(key)) continue;
    const pointer = `/query/${key}`;
    const received = JSON.stringify(query[key]);
    throw new McpProtocolError(`${pointer} is not a registered field; received ${received}; use /query/options/freshness. Example: {"options":{"freshness":{"mode":"wait","required_frontier":"source","timeout_ms":30000}}}`);
  }
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
  assertPublicQueryFields(canonical);
  const apiVersion = requireApiVersion(canonical["api_version"]);
  const scope = requireScope(canonical["scope"]);
  if (typeof canonical["cursor"] === "string") {
    const budget = mergeResponseBudget(canonical["response_budget"]);
    return { call: "core:query_continue", payload: { api_version: apiVersion, scope, cursor: canonical["cursor"], response_budget: budget } };
  }
  if (!isRecord(canonical["expression"])) throw new McpProtocolError("urdira_query requires expression, or cursor.");
  const options = mergeQueryOptions(canonical["options"]);
  const payload = { api_version: apiVersion, scope, expression: canonical["expression"], options };
  validateQueryBeforeIpc(payload);
  return { call: "core:query", payload };
}

function indexStatusPayload(input: unknown): JsonRecord {
  const canonical = requireRecord(canonicalKeys(requireRecord(input, "tool arguments")), "index status request");
  const rawWorkspaceIds = Array.isArray(canonical["workspace_ids"]) ? canonical["workspace_ids"] : [];
  if (!rawWorkspaceIds.every((value) => typeof value === "string")) throw new McpProtocolError("workspaceIds must be an array of workspace identifiers.");
  const responseBudget = mergeResponseBudget(canonical["response_budget"]);
  if (canonical["api_version"] !== undefined && canonical["api_version"] !== 3) throw new McpProtocolError("/api_version received an unsupported value; use 3. Example: {\"api_version\":3,\"workspace_ids\":[]}");
  const requestedApiVersion = canonical["api_version"] === 3 ? 3 : undefined;
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
    deadline_at: new Date(Date.now() + IPC_EXECUTION_MARGIN_MS).toISOString(),
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
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: workspaceId, ...(sourceBinding ? { snapshot_id: workspace!["source_snapshot_id"] } : {}) },
      expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: { filter: { paths: [path] } } },
    },
  };
  const query = queryPayload(queryRequest);
  const queryResponse = await dependencies.client.call(query.call, query.payload, requestOptions);
  result["internal_calls"] = ["core:index_status", query.call];
  result["artifact_lookup"] = queryResponse.outcome === "success"
    ? { path, result: renderQueryPageText(publicQueryPage(queryResponse.payload, "single_workspace", extractResponseBudget(query.call, query.payload), { render: "text", page_kind: "query", snippet_lines: DEFAULT_SNIPPET_LINES }) as JsonRecord) }
    : { path, error: responseError(queryResponse) };
  return { content: [{ type: "text", text: stableJson(result) }] };
}

function responseError(response: IpcResponse): JsonRecord {
  if (response.outcome === "cancelled") return { code: "core:operation_cancelled", message: "The Urdira operation was cancelled.", details: {} };
  if (response.error) return operationError(response.error.code, response.error.message, response.error.details);
  return operationError("core:execution_failed", "The Urdira daemon returned an error without details.");
}

function operationError(code: string, message: string, details: Readonly<Record<string, unknown>> = {}): JsonRecord {
  const definition = operationErrorDefinitions.find((candidate) => candidate.code === code);
  const normalizedDetails = code === "core:workspace_not_registered" && typeof details["registration_command"] !== "string"
    ? { ...details, registration_command: "urdira workspace add <workspace-root>" }
    : details;
  const retryable = typeof normalizedDetails["retryable"] === "boolean"
    ? normalizedDetails["retryable"]
    : definition?.retryable_default === true;
  return {
    code,
    message,
    retryable,
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
// `snippet_lines` (plan 2026-09-06, Frente N): how many lines of a compact
// structural/discovery bundle's inline snippet `renderQueryPageText` prints
// -- part of the render context (not just a call-site parameter) because
// `measureForRender` must measure the SAME text `renderQueryPageText` will
// actually emit, or `shedToBudget` sheds against the wrong length.
export interface RenderContext { readonly render: "text" | "json"; readonly page_kind: "query" | "index_status"; readonly snippet_lines: number; }

function measureForRender(renderContext: RenderContext): (value: JsonRecord) => number {
  if (renderContext.render === "json") return (value) => stableJson(value).length;
  return renderContext.page_kind === "index_status" ? (value) => renderIndexStatusText(value).length : (value) => renderQueryPageText(value, renderContext.snippet_lines).length;
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
      // Plan 2026-09-06 (Frente N, SNIPPET_POLICY): a raw record value that
      // reaches this fallback (get_source/build_context already build the
      // full bundle shape themselves, above) may still carry an
      // engine-attached `optional_source_snippets` field directly on itself
      // (`item()`/`semanticCandidateItem()` in
      // packages/engine/src/canonical-query-data-port.ts). Lift it to this
      // bundle's own top-level field -- where every other bundle shape, and
      // `describeBundle` below, expects to find it -- and strip it back out
      // of `primary_result` so that payload matches exactly what it looked
      // like before this plan.
      const valueRecord = isRecord(value) ? value : undefined;
      const snippetsField = valueRecord?.["optional_source_snippets"];
      let primaryResult: unknown = value;
      if (valueRecord !== undefined && "optional_source_snippets" in valueRecord) {
        const { optional_source_snippets: _droppedSnippets, ...rest } = valueRecord;
        primaryResult = rest;
      }
      return {
        result_set: resultSet,
        primary_result: primaryResult,
        assessment: { classification, completeness: "complete" },
        provenance_path: Array.isArray(streamItem["provenance_path"]) ? streamItem["provenance_path"] : [],
        essential_related_entities: [],
        optional_source_snippets: Array.isArray(snippetsField) ? snippetsField : [],
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
  /**
   * Plan 2026-09-06 (Frente N, §5.1.3): true for a bundle whose snippet was
   * attached by the SNIPPET_POLICY inline hydration
   * (`core:find_references`/`core:get_outline`/`core:search_hybrid`/
   * `core:search_semantic` -- see `canonical-query-data-port.ts`'s
   * SNIPPET_POLICY doc comment), never for `core:get_source`/
   * `core:build_context`'s own much larger, caller-configured snippets
   * (`resultSetLabel` "sources"/"context") or `core:search_text`'s
   * grep-style match (`isMatchStyle`). Rendered as one or more `    | `
   * lines, capped at `snippet_lines` (default 1) -- unlike the full-body
   * style below, which never re-truncates a caller-configured read.
   */
  readonly isCompactSnippetStyle: boolean;
}

/** Best-effort line number: only ever present when a producer already attached one (see the module doc comment above) -- never derived from a byte/character offset here. */
function describeLine(body: JsonRecord, span: JsonRecord | undefined): string | undefined {
  return firstNonEmptyString(
    typeof body["start_line"] === "number" ? String(body["start_line"]) : body["start_line"],
    typeof body["line"] === "number" ? String(body["line"]) : body["line"],
    span?.["start_line"],
  );
}

/** `n.toLocaleString("en-US")` for the comma-grouped counts `semantic_coverage`'s rendered line uses (plan 2026-09-06, §4.3: `"covered 13,980/14,120"`). */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Plan 2026-09-06 (Frente S-A, §4.3): `core:search_semantic`/`core:search_hybrid`'s
 * `semantic_coverage` stream carries one raw `SemanticCoverageView` per item
 * (never a `ResultBundle`-shaped record) -- `buildStreamResultSets` (this
 * file) wraps it as `primary_result` unchanged, so `describeBundle`'s
 * generic path/line/name extraction below would otherwise see an empty body
 * and fall through to an unhelpful `compactPreview` label. Renders exactly
 * the plan's own template: `coverage: covered a/b · pending · failed ·
 * excluded (set …; next: <cursor>)` -- `excluded` folds in
 * `unsupported_artifact_count` (decided in implementation: the plan's own
 * concrete example names only four buckets, and "unsupported" is, from an
 * agent's perspective, one more reason a document will never be covered,
 * the same as "excluded").
 */
function describeSemanticCoverage(view: JsonRecord): BundleDescriptor {
  const covered = typeof view["covered_artifact_count"] === "number" ? view["covered_artifact_count"] : 0;
  const total = typeof view["artifact_count"] === "number" ? view["artifact_count"] : 0;
  const pending = typeof view["pending_artifact_count"] === "number" ? view["pending_artifact_count"] : 0;
  const failed = typeof view["failed_artifact_count"] === "number" ? view["failed_artifact_count"] : 0;
  const excluded = (typeof view["excluded_artifact_count"] === "number" ? view["excluded_artifact_count"] : 0) + (typeof view["unsupported_artifact_count"] === "number" ? view["unsupported_artifact_count"] : 0);
  // Unlike every other id this renderer touches, `affected_artifact_set_id`
  // and `next_cursor` are never merely displayed -- they are the exact
  // arguments a following `core:semantic_affected_page` call must supply
  // verbatim (the cursor is a hex-encoded JSON blob; a truncated
  // prefix cannot be decoded back into a valid `{set, k, dir}` object, and a
  // truncated set id can never equal the server's freshly recomputed
  // current set id). So, deliberately, NEITHER is put through the generic
  // 16-char truncation the rest of this file's ids get: printing a
  // shortened, unusable copy here would silently strand every agent that
  // tries to page past the first `semantic_coverage` line.
  const setId = firstNonEmptyString(view["affected_artifact_set_id"]);
  const page = isRecord(view["affected_artifact_page"]) ? view["affected_artifact_page"] as JsonRecord : undefined;
  const nextCursor = page !== undefined ? firstNonEmptyString(page["next_cursor"]) : undefined;
  const setSuffix = setId !== undefined ? ` (set ${setId}${nextCursor !== undefined ? `; next: ${nextCursor}` : ""})` : "";
  return { label: `coverage: covered ${formatCount(covered)}/${formatCount(total)} · pending ${formatCount(pending)} · failed ${formatCount(failed)} · excluded ${formatCount(excluded)}${setSuffix}`, isMatchStyle: false, isCompactSnippetStyle: false };
}

/** One `path (status: reason)` line for a `SemanticAffectedArtifactView`, shared by `describeSemanticAffectedPage` below. */
function formatAffectedArtifactLine(view: JsonRecord): string {
  const path = firstNonEmptyString(view["display_path"]) ?? "?";
  const status = firstNonEmptyString(view["coverage_status"]) ?? "affected";
  const reasons = Array.isArray(view["reason_codes"]) ? (view["reason_codes"] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  const reasonSuffix = reasons.length > 0 ? `: ${reasons.join(", ")}` : "";
  return `${path} (${status}${reasonSuffix})`;
}

/**
 * Plan 2026-09-06 (Frente S-A, §4.3): `core:semantic_affected_page`'s
 * `semantic_affected_artifacts` stream carries exactly ONE item -- the
 * complete `SemanticAffectedArtifactPage` (`trySemanticAffectedPage`'s own
 * doc comment explains why: its cursor round-trips through this operation's
 * OWN `cursor` argument, never the generic per-stream continuation). One
 * `BundleDescriptor` can only hold one rendered line, so this renders the
 * WHOLE page as one multi-line label (a header, one `path (status: reason)`
 * line per artifact per the plan's own template, and -- when there is
 * more -- a line naming the next-page cursor); a label with embedded
 * newlines already prints correctly (see `formatDescriptorLine`'s own
 * snippet-indentation branch, which does the same thing for a different
 * reason).
 */
function describeSemanticAffectedPage(view: JsonRecord): BundleDescriptor {
  const artifacts = Array.isArray(view["artifacts"]) ? view["artifacts"] as JsonRecord[] : [];
  const total = typeof view["total"] === "number" ? view["total"] : artifacts.length;
  const lines = [`# ${formatCount(total)} affected document${total === 1 ? "" : "s"}`, ...artifacts.map(formatAffectedArtifactLine)];
  if (view["has_next"] === true && typeof view["next_cursor"] === "string") {
    // Full cursor, never truncated -- see `describeSemanticCoverage`'s
    // identical reasoning: this value must round-trip byte-for-byte into
    // the next `core:semantic_affected_page` call's own `cursor` argument.
    lines.push(`MORE: call core:semantic_affected_page again with the same affected_artifact_set_id and cursor=${view["next_cursor"]}`);
  }
  return { label: lines.join("\n"), isMatchStyle: false, isCompactSnippetStyle: false };
}

function describeBundle(bundle: JsonRecord, resultSetLabel: string): BundleDescriptor {
  const primary = isRecord(bundle["primary_result"]) ? bundle["primary_result"] as JsonRecord : {};
  if (resultSetLabel === "semantic_coverage" && typeof primary["materialization_state"] === "string") return describeSemanticCoverage(primary);
  if (resultSetLabel === "semantic_affected_artifacts" && Array.isArray(primary["artifacts"])) return describeSemanticAffectedPage(primary);
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
  // Plan 2026-09-06 (Frente N, §5.1.3): "sources" (`core:get_source`) and
  // "context" (`core:build_context`) are the two labels whose snippet the
  // CALLER explicitly sized (`options.snippets`, up to thousands of
  // characters) -- those keep the pre-existing full, uncapped multi-line
  // render below. Every other labeled stream that carries a snippet at all
  // got it from the new SNIPPET_POLICY inline hydration (`references`,
  // `members`, `candidates`, and any future policy entry), which is always
  // <= `INLINE_SNIPPET_MAX_CHARS_PER_SNIPPET` (200 chars) and effectively
  // one line already (`"line"`/`"signature"` mode, `context_lines: 0`) --
  // render those compactly, capped at `snippet_lines`.
  const isCompactSnippetStyle = !isMatchStyle && resultSetLabel !== "sources" && resultSetLabel !== "context";

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

  return { path, line, label, snippetText, isMatchStyle, isCompactSnippetStyle };
}

const COMPACT_SNIPPET_LINE_MAX_CHARS = 200;

function formatDescriptorLine(descriptor: BundleDescriptor, possible: boolean, grouped: boolean, snippetLines: number): string {
  const suffix = possible ? " [possible]" : "";
  const locator = descriptor.line !== undefined ? `:${descriptor.line}` : "";
  const head = grouped ? locator : descriptor.path !== undefined ? `${descriptor.path}${locator}` : locator;

  if (descriptor.isMatchStyle && descriptor.snippetText !== undefined) {
    const firstLine = descriptor.snippetText.split("\n").find((segment) => segment.trim().length > 0) ?? descriptor.snippetText;
    return `${head.length > 0 ? `${head}: ` : ""}${firstLine.trim()}${suffix}`;
  }

  const primaryLine = `${head.length > 0 ? `${head} ` : ""}${descriptor.label}${suffix}`;
  if (descriptor.snippetText === undefined || descriptor.snippetText.length === 0) return primaryLine;

  // Plan 2026-09-06 (Frente N, §5.1.3): SNIPPET_POLICY-hydrated bundles
  // render as one or more `    | <line>` lines, trimmed and capped at
  // `COMPACT_SNIPPET_LINE_MAX_CHARS`, up to `snippet_lines` non-empty
  // lines -- `snippet_lines: 0` (hidden `response_budget`-adjacent option,
  // see `snippetLinesFieldSchema`) omits the snippet entirely.
  if (descriptor.isCompactSnippetStyle) {
    if (snippetLines <= 0) return primaryLine;
    const nonEmptyLines = descriptor.snippetText.split("\n").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    if (nonEmptyLines.length === 0) return primaryLine;
    const shown = nonEmptyLines.slice(0, snippetLines).map((segment) => segment.length > COMPACT_SNIPPET_LINE_MAX_CHARS ? `${segment.slice(0, COMPACT_SNIPPET_LINE_MAX_CHARS)}…` : segment);
    const compactLines = shown.map((segment) => `    | ${segment}`).join("\n");
    return `${primaryLine}\n${compactLines}`;
  }

  // The query engine has already applied the caller's per-snippet, total
  // snippet, and serialized-response budgets. Do not impose a second hidden
  // line cap here: doing so makes a successful `core:get_source` body read
  // indistinguishable from an arbitrarily truncated result and pushes agents
  // toward repeated searches or native source-reading fallbacks.
  const snippetLinesText = descriptor.snippetText.split("\n").map((segment) => `    ${segment}`).join("\n");
  return `${primaryLine}\n${snippetLinesText}`;
}

/** Groups consecutive same-path descriptors under one `== path ==` header (ripgrep-style), matching grep -n output for a lone match and avoiding repeating the path for a run of several. */
function appendGroupedDescriptors(descriptors: readonly BundleDescriptor[], possible: boolean, lines: string[], snippetLines: number): void {
  let index = 0;
  while (index < descriptors.length) {
    let end = index + 1;
    while (end < descriptors.length && descriptors[end]!.path !== undefined && descriptors[end]!.path === descriptors[index]!.path) end += 1;
    const runLength = end - index;
    const path = descriptors[index]!.path;
    if (runLength > 1 && path !== undefined) {
      lines.push(`== ${path} ==`);
      for (let cursor = index; cursor < end; cursor += 1) lines.push(formatDescriptorLine(descriptors[cursor]!, possible, true, snippetLines));
    } else {
      lines.push(formatDescriptorLine(descriptors[index]!, possible, false, snippetLines));
    }
    index = end;
  }
}

function appendStreamLines(resultSetLabel: string, streamPage: unknown, possible: boolean, lines: string[], cursors: { readonly label: string; readonly cursor: string }[], snippetLines: number): void {
  if (!isRecord(streamPage)) return;
  const bundles = Array.isArray(streamPage["result_bundles"]) ? streamPage["result_bundles"] as JsonRecord[] : [];
  if (bundles.length > 0) appendGroupedDescriptors(bundles.map((bundle) => describeBundle(bundle, resultSetLabel)), possible, lines, snippetLines);
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

/** Renders a `QueryResultPage`-shaped envelope (see `publicQueryPage`) as compact, grep/ctags-density plain text. This is the default `content[0].text` for `urdira_query`/`urdira_analyze_change`/`urdira_build_context`; the full JSON page is still reachable via `render: "json"`. `snippetLines` (plan 2026-09-06, Frente N) caps how many lines of a SNIPPET_POLICY-hydrated bundle's inline snippet get printed; optional, default 1 (see `DEFAULT_SNIPPET_LINES`). */
function renderQueryPageText(page: JsonRecord, snippetLines: number = DEFAULT_SNIPPET_LINES): string {
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
    appendStreamLines(label, resultSet["confirmed"], false, lines, cursors, snippetLines);
    appendStreamLines(label, resultSet["possible"], true, lines, cursors, snippetLines);
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
    lines.push(`  query_scope=${JSON.stringify({ scope_type: "single_workspace", workspace_id: id })}`);
    lines.push(`  ready: source=${sourceReady}, structural=${structuralReady}, semantic=${semanticReady}`);
    // P4-d: v4 lane detail -- absent entirely for a v3 workspace (`storage_format`
    // is only ever "v3"/"v4", set unconditionally by `v4StatusFields`,
    // `packages/daemon/src/runtime.ts`), so a v3 render is byte-for-byte
    // unchanged from before this task. One compact line per lane
    // (generation(s) plus a "current"/"lagging" tag from the daemon's own
    // `current`/`queryable` booleans), the last completed scan's kind/paths/
    // wall time, and a hint only when a lane is actually lagging -- an agent
    // reading `search_text_ready: false` on an otherwise-successful query
    // should see WHY without a second lookup.
    if (workspace["storage_format"] === "v4") {
      const structural = isRecord(workspace["structural"]) ? workspace["structural"] as JsonRecord : {};
      const lexical = isRecord(workspace["lexical"]) ? workspace["lexical"] as JsonRecord : {};
      const semantic = isRecord(workspace["semantic"]) ? workspace["semantic"] as JsonRecord : {};
      const structuralQueryable = structural["queryable"] === true;
      const lexicalCurrent = lexical["current"] === true;
      const semanticCurrent = semantic["current"] === true;
      lines.push(`  structural: queryable_gen=${structural["queryable_generation"] ?? "-"}, durable_gen=${structural["durable_generation"] ?? "-"}${structuralQueryable ? "" : " (lagging)"}`);
      lines.push(`  lexical: completed_gen=${lexical["completed_generation"] ?? "-"} (${lexicalCurrent ? "current" : "lagging"})`);
      const profileId = firstNonEmptyString(semantic["profile_id"]);
      lines.push(`  semantic: completed_gen=${semantic["completed_generation"] ?? "-"} (${semanticCurrent ? "current" : "lagging"})${profileId !== undefined ? `, profile=${profileId}` : ""}`);
      const lastScan = isRecord(workspace["last_scan"]) ? workspace["last_scan"] as JsonRecord : undefined;
      if (lastScan !== undefined) {
        const kind = firstNonEmptyString(lastScan["kind"]) ?? "?";
        const changedPaths = typeof lastScan["changed_paths"] === "number" ? `, changed_paths=${lastScan["changed_paths"]}` : "";
        const timings = isRecord(lastScan["timings"]) ? lastScan["timings"] as JsonRecord : undefined;
        const wallMs = typeof timings?.["total_ms"] === "number" ? `, wall_ms=${timings["total_ms"]}` : "";
        // Frente E: `kind === "reconcile"` carries a `ReconcileSummary` --
        // render it as `reconcile/<mode> (+added ~changed -deleted of
        // frontier_size)` instead of the plain `kind=reconcile` an agent
        // could otherwise mistake for a scan that never actually measured
        // anything.
        const reconcile = isRecord(lastScan["reconcile"]) ? lastScan["reconcile"] as JsonRecord : undefined;
        const label = reconcile !== undefined && typeof reconcile["mode"] === "string"
          ? `kind=${kind}/${reconcile["mode"]}`
          : `kind=${kind}`;
        const reconcileSummary = reconcile !== undefined
          && typeof reconcile["added"] === "number" && typeof reconcile["changed"] === "number"
          && typeof reconcile["deleted"] === "number" && typeof reconcile["frontier_size"] === "number"
          ? ` (+${reconcile["added"]} ~${reconcile["changed"]} -${reconcile["deleted"]} of ${reconcile["frontier_size"]})`
          : "";
        lines.push(`  last_scan: ${label}${reconcileSummary}${changedPaths}${wallMs}`);
      }
      if (!lexicalCurrent) lines.push("  hint: search_text will report partial until lexical catches up");
      if (!semanticCurrent) lines.push("  hint: search_semantic is unavailable until semantic indexing catches up");
    }
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
  // v4 (plan §6, Frente H): a single, installation-wide hint line -- not
  // per-workspace -- whenever the daemon's startup/last-refresh orphan
  // sweep (`core:index_status`'s `orphaned_workspace_data`, daemon
  // `runtime.ts`) found leftover on-disk data no registered workspace owns
  // any more. Silent when `count` is 0 or the field is absent (a daemon
  // with no durable storage configured at all never populates it).
  const orphanedWorkspaceData = isRecord(page["orphaned_workspace_data"]) ? page["orphaned_workspace_data"] as JsonRecord : undefined;
  if (typeof orphanedWorkspaceData?.["count"] === "number" && orphanedWorkspaceData["count"] > 0) {
    const bytes = typeof orphanedWorkspaceData["bytes"] === "number" ? ` (${Math.round(orphanedWorkspaceData["bytes"] / (1024 * 1024))} MB)` : "";
    lines.push(`orphaned workspace data: ${orphanedWorkspaceData["count"]} set(s)${bytes} -- run "urdira workspace orphans" to review`);
  }
  return lines.join("\n");
}

export interface FormatUrdiraResultOptions {
  /** Optional; default: "text" -- see `renderFieldSchema`. */
  readonly render?: "text" | "json";
  /** Optional; default: "query". Selects which compact-text renderer applies in "text" mode. */
  readonly page_kind?: "query" | "index_status";
  /** Optional; default: "agent". The web profile adds schema-validated structuredContent. */
  readonly presentation_profile?: McpPresentationProfile;
  /** Optional; default: 1. See `snippetLinesFieldSchema`. */
  readonly snippet_lines?: number;
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
    const result: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: stableJson({ error: mapped }) }],
    };
    return options.presentation_profile === "web" ? { ...result, structuredContent: { error: mapped } } : result;
  }
  if (options.render === "json") {
    const result: CallToolResult = {
      content: [{ type: "text", text: stableJson({ page: stable }) }],
    };
    return options.presentation_profile === "web" ? { ...result, structuredContent: { page: stable } } : result;
  }
  const page = isRecord(stable) ? stable : {};
  const pageKind = options.page_kind ?? "query";
  const text = pageKind === "index_status" ? renderIndexStatusText(page) : renderQueryPageText(page, options.snippet_lines ?? DEFAULT_SNIPPET_LINES);
  const result: CallToolResult = {
    content: [{ type: "text", text }],
  };
  return options.presentation_profile === "web" ? { ...result, structuredContent: { page: stable } } : result;
}

function extractResponseBudget(call: string, payload: JsonRecord): { readonly max_characters?: unknown } | undefined {
  if (call === "core:query_continue") return isRecord(payload["response_budget"]) ? payload["response_budget"] as JsonRecord : undefined;
  if (call === "core:query" && isRecord(payload["options"]) && isRecord(payload["options"]["response_budget"])) return payload["options"]["response_budget"] as JsonRecord;
  return undefined;
}

const IPC_EXECUTION_MARGIN_MS = 60_000;

function deadlineForPayload(call: string, payload: JsonRecord): string {
  const options = call === "core:query" && isRecord(payload["options"]) ? payload["options"] as JsonRecord : {};
  const wait = typeof options["wait_timeout_ms"] === "number" && Number.isSafeInteger(options["wait_timeout_ms"]) && options["wait_timeout_ms"] >= 0 ? options["wait_timeout_ms"] : 0;
  return new Date(Date.now() + wait + IPC_EXECUTION_MARGIN_MS).toISOString();
}

// --- core:build_context graceful degradation --------------------------------
//
// urdira_context/urdira_build_context default to waiting for the structural
// frontier (see `queryRequestFromIntent` above) so a caller gets the complete
// facets contract in one call. On a from-zero index that wait can still hit
// its boundary while the workspace is honestly still indexing --
// `core:freshness_wait_timeout` (the wait ran out) or `core:coverage_incomplete`
// (nothing is scheduled yet for the requested frontier). Returning the bare
// JSON error there left an agent with nothing actionable except retrying
// blind. Render a compact plain-text degradation notice instead -- the same
// style as `renderIndexStatusText`/`renderQueryPageText` below, not a JSON
// dump -- naming the source/syntax-frontier operations
// (`operationFrontiers`, packages/contracts/src/registries.ts) that are
// already usable so the agent can keep working immediately instead of
// stalling on the wait.
const CONTEXT_DEGRADATION_ERROR_CODES: ReadonlySet<string> = new Set(["core:coverage_incomplete", "core:freshness_wait_timeout"]);

const SOURCE_SYNTAX_OPERATION_CATALOG: ReadonlyArray<{ readonly operation: string; readonly frontier: "source" | "syntax"; readonly description: string }> = [
  { operation: "core:find_artifacts", frontier: "source", description: "List artifacts by path, language, or kind filter." },
  { operation: "core:search_text", frontier: "source", description: "Literal or regex text search across the workspace." },
  { operation: "core:get_source", frontier: "source", description: "Fetch source snippets for a known artifact, symbol, or entity." },
  { operation: "core:discover_definitions", frontier: "syntax", description: "List definitions matching a name or kind." },
  { operation: "core:find_records", frontier: "syntax", description: "List structural records by kind or facet." },
  { operation: "core:get_outline", frontier: "syntax", description: "Outline the declarations inside one artifact or entity." },
];

function isBuildContextOperationPayload(payload: JsonRecord): boolean {
  return isRecord(payload["expression"]) && payload["expression"]["operation"] === "core:build_context";
}

/** Best-effort: a second short-deadline `core:index_status` lookup for the phase/stage detail a degradation notice benefits from. Never blocks the degradation on its own failure. */
async function fetchWorkspaceStatusForDegradation(client: UrdiraMcpClient, workspaceId: string, requestOptions: LocalIpcRequestOptions): Promise<JsonRecord | undefined> {
  try {
    const response = await client.call("core:index_status", indexStatusPayload({ workspace_ids: [workspaceId] }), { ...requestOptions, deadline_at: new Date(Date.now() + 5_000).toISOString() });
    const payload = response.outcome === "success" && isRecord(response.payload) ? response.payload : undefined;
    const workspaces = payload !== undefined && Array.isArray(payload["workspaces"]) ? payload["workspaces"] : undefined;
    const workspace = workspaces?.find((entry) => isRecord(entry) && entry["workspace_id"] === workspaceId);
    return isRecord(workspace) ? workspace : undefined;
  } catch {
    return undefined;
  }
}

function renderContextDegradationText(errorCode: string, errorMessage: string, errorDetails: Readonly<Record<string, unknown>>, workspace: JsonRecord | undefined): string {
  const startupPhase = firstNonEmptyString(workspace?.["startup_phase"]);
  const structuralStageOrdinal = typeof workspace?.["structural_stage_ordinal"] === "number" ? workspace["structural_stage_ordinal"] : undefined;
  const waitedMs = typeof errorDetails["waited_ms"] === "number" ? errorDetails["waited_ms"] : undefined;
  const retryAfterMs = typeof workspace?.["retry_after_ms"] === "number" ? workspace["retry_after_ms"] : typeof errorDetails["retry_after_ms"] === "number" ? errorDetails["retry_after_ms"] : undefined;
  const detailParts = [
    startupPhase !== undefined ? `phase=${startupPhase}` : undefined,
    structuralStageOrdinal !== undefined ? `structural_stage_ordinal=${structuralStageOrdinal}` : undefined,
    waitedMs !== undefined ? `waited_ms=${waitedMs}` : undefined,
    retryAfterMs !== undefined ? `retry_after_ms=${retryAfterMs}` : undefined,
  ].filter((value): value is string => value !== undefined);

  const syntaxReady = workspace?.["structural_stage_1_ready"] === true || workspace?.["syntax_ready"] === true;
  const lines = [
    `indexing: the workspace is still indexing, so urdira_context (structural frontier) is not ready yet (${errorCode}: ${errorMessage})`,
    ...(detailParts.length > 0 ? [detailParts.join(", ")] : []),
    "",
    "use these now instead of waiting:",
    ...SOURCE_SYNTAX_OPERATION_CATALOG.filter((entry) => entry.frontier === "source").map((entry) => `  ${entry.operation.replace(/^core:/, "")} (source, ready now) - ${entry.description}`),
    ...SOURCE_SYNTAX_OPERATION_CATALOG.filter((entry) => entry.frontier === "syntax").map((entry) => `  ${entry.operation.replace(/^core:/, "")} (syntax, ${syntaxReady ? "ready now" : "ready once syntax indexing completes"}) - ${entry.description}`),
    "",
    "results from these are honestly labeled partial while indexing runs; urdira_context becomes available once structural indexing completes.",
  ];
  return lines.join("\n");
}

async function buildContextDegradationResult(client: UrdiraMcpClient, payload: JsonRecord, error: NonNullable<IpcResponse["error"]>, requestOptions: LocalIpcRequestOptions, presentationProfile: McpPresentationProfile): Promise<CallToolResult | undefined> {
  const scope = isRecord(payload["scope"]) ? payload["scope"] as JsonRecord : undefined;
  const workspaceId = scope !== undefined && scope["scope_type"] === "single_workspace" && typeof scope["workspace_id"] === "string" ? scope["workspace_id"] : undefined;
  if (workspaceId === undefined) return undefined;
  const workspace = await fetchWorkspaceStatusForDegradation(client, workspaceId, requestOptions);
  const result: CallToolResult = { content: [{ type: "text", text: renderContextDegradationText(error.code, error.message, error.details ?? {}, workspace) }] };
  return presentationProfile === "web" ? { ...result, structuredContent: { page: { degradation: { code: error.code, message: error.message, details: error.details ?? {}, workspace } } } } : result;
}

async function invoke(name: UrdiraMcpToolName, input: unknown, dependencies: { client: UrdiraMcpClient }, context: UrdiraMcpToolContext = {}, presentationProfile: McpPresentationProfile = "agent"): Promise<CallToolResult> {
  const raw = requireRecord(input, "tool arguments");
  const canonical = canonicalKeys(raw);
  const render: "text" | "json" = isRecord(canonical) && canonical["render"] === "json" ? "json" : "text";
  // Plan 2026-09-06 (Frente N, §5.1.3): read off the raw args exactly like
  // `render` above -- see `snippetLinesFieldSchema`'s doc comment for why
  // this stays outside `options`/`response_budget` entirely.
  const rawSnippetLines = isRecord(canonical) ? canonical["snippet_lines"] : undefined;
  const snippetLines = typeof rawSnippetLines === "number" && Number.isSafeInteger(rawSnippetLines) ? Math.max(0, Math.min(3, rawSnippetLines)) : DEFAULT_SNIPPET_LINES;
  const indexStatus = name === "urdira_index_status";
  const query = name === "urdira_query" ? queryPayload(input) : undefined;
  const payload = query?.payload ?? (indexStatus ? indexStatusPayload(input) : queryRequestFromIntent(name === "urdira_analyze_change" ? "core:analyze_impact" : "core:build_context", requireRecord(canonical, "tool arguments")));
  const call = query?.call ?? (indexStatus ? "core:index_status" : "core:query");
  if (call === "core:query") validateQueryBeforeIpc(payload);
  const progress = context.onProgress;
  const requestOptions: LocalIpcRequestOptions = {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(progress === undefined ? {} : { on_progress: progress }),
    deadline_at: deadlineForPayload(call, payload),
  };
  const response = await dependencies.client.call(call, payload, requestOptions);
  if (response.outcome === "error" && render !== "json" && response.error !== undefined && CONTEXT_DEGRADATION_ERROR_CODES.has(response.error.code) && isBuildContextOperationPayload(payload)) {
    const degraded = await buildContextDegradationResult(dependencies.client, payload, response.error, requestOptions, presentationProfile);
    if (degraded !== undefined) return degraded;
  }
  const scopeKind = isRecord(payload["scope"]) && payload["scope"]["scope_type"] === "comparison" ? "comparison" : "single_workspace";
  const responseBudget = extractResponseBudget(call, payload);
  const pageKind: "query" | "index_status" = call === "core:index_status" ? "index_status" : "query";
  const renderContext: RenderContext & { readonly presentation_profile: McpPresentationProfile } = { render, page_kind: pageKind, presentation_profile: presentationProfile, snippet_lines: snippetLines };
  const page = response.outcome === "success"
    ? (call === "core:index_status" ? publicIndexStatusPage(response.payload) : publicQueryPage(response.payload, scopeKind, responseBudget, renderContext))
    : { error: responseError(response) };
  return formatUrdiraResult(page, renderContext);
}

/** Builds the five read-only public MCP tools from their shared closed schemas and IPC dispatcher. */
export function createUrdiraToolDefinitions(dependencies: { readonly client: UrdiraMcpClient }, options: { readonly presentation_profile?: McpPresentationProfile } = {}): readonly UrdiraMcpToolDefinition[] {
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    description: options.presentation_profile === "web" && name === "urdira_index_status" ? toolDescriptions[name].replace("no MCP outputSchema is advertised for client compatibility", "the web profile also returns schema-validated structuredContent") : toolDescriptions[name],
    input_schema: toolSchemas[name],
    output_schema: MCP_OUTPUT_SCHEMA,
    invoke: (args: unknown, context?: UrdiraMcpToolContext) => invoke(name, args, dependencies, context, options.presentation_profile ?? "agent"),
  }));
}

// --- Server instructions ----------------------------------------------------
//
// The first sections are deliberately task-oriented and short enough to guide
// a new agent before the exhaustive registry-derived reference. The final
// catalog is still built from the exact registries the engine validates.
const operationAgentUses: Readonly<Record<string, string>> = {
  "core:discover_definitions": "Discover Urdira registry definitions such as unfamiliar record kinds, facets, or languages before constructing a structural selector; this is not source-symbol discovery.",
  "core:find_records": "Enumerate indexed structural records using an exact record/category/kind/facet selector.",
  "core:resolve_symbol": "Resolve a known symbol name, optionally anchored by file and byte offset, into exact declarations or explicit candidates.",
  "core:get_outline": "List declarations inside one known artifact or entity container.",
  "core:find_references": "Find indexed references and their owning artifacts for one exact resolved target.",
  "core:expand_relations": "Traverse callers, callees, imports, dependencies, containment, control flow, data flow, or other registered relations from known subjects.",
  "core:find_paths": "Find bounded structural paths between explicit source and target subject sets.",
  "core:find_artifacts": "List indexed files using path, language, kind, external, or generated-code filters.",
  "core:search_text": "Find an exact literal or safe regex; use result_projection=artifact when the next stage needs one subject per matching artifact.",
  "core:search_semantic": "Find conceptually relevant code from natural language when semantic retrieval alone is desired and available.",
  "core:search_hybrid": "Combine lexical and semantic evidence for natural-language discovery; prefer this when wording and identifiers may both help.",
  "core:get_source": "Hydrate signatures, relevant snippets, or complete bodies for exact artifact/entity/symbol subjects returned by discovery.",
  "core:analyze_impact": "Classify what breaks or must change for one hypothetical edit; prefer the dedicated urdira_analyze_change tool for this intent.",
  "core:find_related_tests": "Find tests, fixtures, mocks, and helpers related to known code subjects.",
  "core:inspect_architecture": "Inspect entry points, boundaries, public surfaces, cycles, extension points, or layers for a workspace or selected scope.",
  "core:compare": "Compare two explicitly role-bound workspace snapshots; it requires comparison scope.",
  "core:build_context": "Build a bounded task context from a task statement, optional seeds, and explicit facets; prefer urdira_context for the readiness-aware wrapper.",
  "core:index_status": "Read status inside an already scoped query; use urdira_index_status for global workspace discovery and the initial query_scope.",
  "core:semantic_affected_page": "Page through artifacts not covered by semantic search (use the cursors from semantic_coverage).",
};

const operationWorkflowGroups: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
  { title: "Find a starting point", ids: ["core:find_artifacts", "core:search_text", "core:search_semantic", "core:search_hybrid", "core:resolve_symbol", "core:discover_definitions", "core:find_records"] },
  { title: "Understand structure and relationships", ids: ["core:get_outline", "core:find_references", "core:expand_relations", "core:find_paths"] },
  { title: "Read, assess, and plan", ids: ["core:get_source", "core:find_related_tests", "core:inspect_architecture", "core:analyze_impact", "core:compare", "core:build_context"] },
  { title: "Inspect scoped status", ids: ["core:index_status", "core:semantic_affected_page"] },
];

function buildInstructions(): string {
  const operationById = new Map(operationRegistry.map((operation) => [operation.operation_id, operation]));
  const coveredIds = operationWorkflowGroups.flatMap((group) => group.ids);
  const missingGuides = operationRegistry.filter((operation) => !coveredIds.includes(operation.operation_id) || operationAgentUses[operation.operation_id] === undefined);
  const unknownGuides = coveredIds.filter((id) => !operationById.has(id));
  if (missingGuides.length > 0 || unknownGuides.length > 0 || new Set(coveredIds).size !== coveredIds.length) throw new Error("Every registered operation must have exactly one MCP agent guide.");
  const operationSections = operationWorkflowGroups.map((group) => [
    `${group.title}:`,
    ...group.ids.map((id) => {
      const operation = operationById.get(id)!;
      const argumentsSummary = operation.argument_fields.map((field) => `${field.name}${field.presence === "required" ? "!" : "?"}:${field.logical_type}`).join(", ") || "none";
      return `- ${id} — ${operationAgentUses[id]}\n  frontier=${operation.required_frontier}; arguments=${argumentsSummary}; outputs=${operation.result_streams.join(" | ")}`;
    }),
  ].join("\n")).join("\n\n");
  const recipeLines = recipeRegistry.map((recipe) => `- ${recipe.recipe_id} — ${recipe.description}`).join("\n");
  const directExample = { request_type: "query", query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "<workspace_id>" }, expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "PaymentService", syntax: "literal", word_mode: "identifier", result_projection: "artifact" } } } };
  const pipelineRequest = (expression: unknown): unknown => ({ request_type: "query", query: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: "<workspace_id>" }, expression } });
  return [
    "URDIRA AGENT QUICK START",
    "Urdira is a read-only, snapshot-aware code-intelligence service. It never edits source, runs commands, or infers workspace scope from the current directory or MCP connection.",
    "1. Call urdira_index_status with exactly {workspace_root:\"/absolute/repository/root\"}.",
    "2. Copy the returned query_scope object byte-for-byte into every later call. workspace_id is opaque: never retype, shorten, normalize, or invent it.",
    "3. Choose the smallest tool below. Use one direct operation for one lookup; use a recipe for a standard workflow; use one pipeline when a later stage depends on an earlier result.",
    "4. Let Urdira pass typed results between dependent stages. Do not copy opaque ids out and send them back in a later MCP call unless no single pipeline or recipe can express the task.",
    "",
    "WHICH MCP TOOL SHOULD I CALL?",
    "- urdira_index_status — always first; resolve query_scope and inspect readiness, scan failures, and operation availability.",
    "- urdira_context — default for an ordinary coding task when definitions, callers, dependencies, tests, contracts, or extension points should arrive together.",
    "- urdira_query — custom direct operation, registered recipe, dependent pipeline, or signed-cursor continuation.",
    "- urdira_analyze_change — one read-only hypothetical change-impact question with an exact target.",
    "- urdira_build_context — explicit core:build_context wrapper when task, facets, and seeds are already known; otherwise prefer urdira_context.",
    "",
    "CHOOSING AN urdira_query EXPRESSION",
    "- operation: exactly one lookup. Put operation-specific fields in expression.arguments. Do not add operation_version to a direct operation expression.",
    "- recipe: a registered, immutable multi-step workflow. Put its fields in expression.arguments and use the exact recipe_id.",
    "- pipeline: a custom typed DAG for dependent or parallel stages. Operation stages do include operation_version:3.",
    "- continuation: a separate request_type=continuation using the exact signed cursor and original scope; never decode or edit the cursor.",
    "Minimal direct query (options is optional and defaults to agent-friendly values):",
    JSON.stringify(directExample),
    "",
    "PIPELINE MENTAL MODEL",
    "A pipeline executes several operations inside one immutable scope and snapshot. Think data flow, not a sequence of client-side requests:",
    "- stages gives every operation or algebra operator a unique stage_id.",
    "- arguments contains static values only. Omit an argument when a binding supplies it.",
    "- bindings maps a downstream argument name to {stage_id, output} from an earlier stage.",
    "- The binding passes the complete typed upstream set; it does not interpolate JSON or expose an array of ids to the client.",
    "- outputs names only the final stage streams the agent needs. Intermediate streams stay internal unless listed.",
    "Example data flow: search.subjects -> source.arguments.subjects is encoded on the source stage as bindings.subjects={stage_id:\"search\",output:\"subjects\"}.",
    "Rules that prevent most pipeline errors:",
    "1. Bind only from an earlier stage and use the exact output name listed for that operation in the catalog below.",
    "2. The binding property name must be the exact downstream argument name, and that argument must be batchable or accept the referenced scalar type.",
    "3. Output streams are independent of result_projection. core:search_text always exposes matches and subjects; it never exposes artifacts.",
    "4. Sequence arguments consume the complete set. Scalar arguments require exactly one upstream item; Urdira fails on zero or many rather than guessing.",
    "5. Independent stages may run concurrently. A binding creates dependency order automatically; do not add a separate ordering field.",
    "6. Use options.freshness={mode:\"wait\",required_frontier:\"source\"|\"syntax\"|\"structural\"|\"semantic\",timeout_ms:N} when the newest required frontier matters; do not poll between stages.",
    "Pipeline troubleshooting:",
    "- Unknown output: replace it with an exact stream from the operation catalog. For example find_artifacts -> artifacts, search_text -> matches|subjects, resolve_symbol -> declarations|candidates.",
    "- If a scalar binding receives zero or multiple items, narrow the upstream stage with exact context or use a sequence-valued downstream argument. Never select the first result by accident.",
    "- Invalid selector: bind a compatible typed subject stream; get_outline.container accepts one artifact or entity, while get_source.subjects accepts a subject sequence.",
    "- Unavailable frontier: use operation_availability or a bounded freshness wait. Never weaken completeness silently.",
    "",
    "TWO-STAGE PIPELINE — search -> source. Search once and fetch relevant source for every matched artifact:",
    JSON.stringify(pipelineRequest(PIPELINE_EXAMPLE_SEARCH_TO_SOURCE)),
    "",
    "TWO-STAGE PIPELINE — resolve -> references. Resolve once and pass exact declarations into reference discovery:",
    JSON.stringify(pipelineRequest(PIPELINE_EXAMPLE_RESOLVE_TO_REFERENCES)),
    "",
    "THREE-STAGE PIPELINE — resolve -> references -> source. Reuse exact declarations, find references, then hydrate source for every owning artifact:",
    JSON.stringify(pipelineRequest(PIPELINE_EXAMPLE_RESOLVE_REFERENCES_TO_SOURCE)),
    "",
    "READINESS, RESULTS, AND PARALLELISM",
    "source_ready permits core:find_artifacts, source-projection core:search_text, and artifact-selector core:get_source. syntax, structural, and semantic operations require their registered frontiers. partial is queryable and labeled; unknown is not queryable. Follow operation_availability and retry_after_ms.",
    "Results are compact grep-like text by default. When several queries are independent, issue them as parallel tool calls in one agent message. Use a pipeline only when data must flow between them.",
    "Edits auto-reindex. A bounded freshness wait belongs in the query that needs the new frontier, not in a client polling loop.",
    "",
    "EXACT OPERATION CATALOG",
    "Legend: ! means required, ? means optional. outputs are the only names legal in bindings and final pipeline outputs.",
    operationSections,
    "",
    "REGISTERED MULTI-STEP RECIPES",
    "Use a recipe instead of rebuilding a standard workflow. Use expression_type=recipe, the exact recipe_id below, and recipe-specific arguments.",
    recipeLines,
  ].join("\n");
}

export const MCP_SERVER_INSTRUCTIONS: string = buildInstructions();

/**
 * Benchmark-facing instructions are deliberately derived from the same
 * operation/recipe registries and copy-paste examples as the public MCP
 * instructions.  Benchmark entrypoints import this value instead of keeping
 * a second hand-written protocol contract.
 */
export function buildBenchmarkInstructions(discoveryPath?: string): string {
  // The public MCP tool timeout is 300 seconds. Large frozen workspaces in
  // the benchmark need more than 120 seconds to enumerate/catalog after an
  // edit even when only one artifact is re-analyzed, so keep a 60-second IPC
  // margin while giving the freshness gate enough time to observe the next
  // current structural snapshot.
  const benchmarkFreshnessTimeoutMs = 240_000;
  const sourceOperations = operationRegistry
    .filter((operation) => ["core:find_artifacts", "core:search_text", "core:get_source", "core:build_context"].includes(operation.operation_id))
    .map((operation) => operation.operation_id);
  const operationOutputs = operationRegistry.map((operation) => `${operation.operation_id}=>${operation.result_streams.join("|")}`).join(", ");
  const operationArguments = operationRegistry.map((operation) => {
    const fields = operation.argument_fields.map((field) => `${field.name}${field.presence === "required" ? "!" : "?"}:${field.logical_type}`).join("|") || "none";
    return `${operation.operation_id}=>${fields}`;
  }).join(", ");
  const benchmarkScope = { scope_type: "single_workspace", workspace_id: "<workspace_id>" };
  const directQueryExample = {
    request_type: "query",
    query: {
      api_version: 3,
      scope: benchmarkScope,
      expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "TargetSymbol", syntax: "literal", word_mode: "identifier", result_projection: "artifact" } },
      options: { freshness: { mode: "wait", required_frontier: "source", timeout_ms: benchmarkFreshnessTimeoutMs } },
    },
  };
  const pipelineQueryExample = {
    request_type: "query",
    query: {
      api_version: 3,
      scope: benchmarkScope,
      expression: PIPELINE_EXAMPLE_SEARCH_TO_SOURCE,
      options: { freshness: { mode: "wait", required_frontier: "source", timeout_ms: benchmarkFreshnessTimeoutMs } },
    },
  };
  const knownPathSourceExample = {
    request_type: "query",
    query: {
      api_version: 3,
      scope: benchmarkScope,
      expression: {
        expression_type: "operation",
        operation: "core:get_source",
        arguments: {
          subjects: [{ subject_type: "artifact", path: "src/example.ts" }],
          source: { mode: "body", max_characters_per_snippet: 20_000, max_total_characters: 40_000, context_lines: 5 },
        },
      },
      options: { freshness: { mode: "wait", required_frontier: "source", timeout_ms: benchmarkFreshnessTimeoutMs } },
    },
  };
  const lines = [
    "Use Urdira's public API v3 for read-only repository discovery.",
    "Resolve the explicit workspace_root with urdira_index_status before querying; never infer scope from process state. Bootstrap with exactly {workspace_root:<repository root>}: urdira_index_status does not accept api_version or scope (those belong to query tools), and its only other fields are the documented include_* flags and response_budget.",
    "Every urdira_context call requires top-level api_version:3 (beside scope and task); never omit it or place it under options.",
    "urdira_context overrides belong under the single top-level options object: use options.freshness, options.snippets, and options.response_budget; never place freshness, snippets, or response_budget beside task.",
    "Every freshness object requires mode, required_frontier, and timeout_ms together, including mode=current. Prefer mode=wait for benchmark discovery and post-edit validation.",
    "Reuse the exact query_scope object returned by urdira_index_status byte-for-byte in every query; workspace_id is opaque, so never retype, abbreviate, normalize, or synthesize it.",
    `Source-safe operations available at source_ready: ${sourceOperations.join(", ")}.`,
    "Use urdira_context for complete task context (it waits for the structural frontier by default), or one binding-oriented urdira_query pipeline with freshness.mode=wait.",
    "After editing, wait for the structural frontier before final symbol rediscovery: use freshness={mode:\"wait\",required_frontier:\"structural\",timeout_ms:N}. mode=current returns immediately and can explicitly report stale evidence while reindexing; its timeout does not make it wait.",
    "On large workspaces, use timeout_ms:240000 for post-edit freshness waits; this stays below the MCP tool timeout and the wait remains part of the measured result.",
    "urdira_query accepts exactly one top-level request_type plus query object. Inside query, freshness belongs only at options.freshness; do not add expression_type beside expression, and do not add operation_version to a direct operation expression. Every operation pipeline stage must use the exact field operation; never replace it with core, operator, or operation_id.",
    "For core:search_text, syntax is only literal or safe_regex; word_mode is only substring, identifier, or token; result_projection is only match, artifact, record, or entity. matches and subjects are output stream names for bindings, never result_projection values. Omit an optional field instead of inventing another enum value.",
    "For core:get_source, subjects must be closed selector objects, never bare path strings. A known path uses {subject_type:\"artifact\",path:\"src/example.ts\"}. For core:find_artifacts, paths belong at arguments.filter.paths (an array); there is no top-level arguments.path field. In a pipeline, core:find_artifacts exposes output artifacts (not subjects), so bind get_source.subjects from {stage_id:\"files\",output:\"artifacts\"}.",
    "core:get_source source.mode is only signature, relevant, or body; never none. The shared SourceIncludeOptions type contains none for operations where snippets are optional, but get_source exists specifically to request a source projection.",
    "Closed subject selectors: entity={subject_type:\"entity\",entity_id:\"<id returned by Urdira>\"}; record={subject_type:\"record\",record_id:\"<id>\"}; artifact by path={subject_type:\"artifact\",path:\"src/example.ts\"}; artifact by id={subject_type:\"artifact\",artifact_id:\"<id>\"}; symbol by known name={subject_type:\"symbol\",name:\"QualifiedOrShortName\"}. Never put qualified_name on an entity selector.",
    `Registered operation output streams (pipeline bindings must use these exact output names regardless of result_projection): ${operationOutputs}.`,
    `Registered operation arguments (! required, ? optional; use these exact field names and logical types): ${operationArguments}.`,
    "Nested closed contracts used often: discover_definitions.matcher={text:<non-empty string>,mode:exact|prefix|contains|semantic|hybrid}; get_outline.container accepts only an artifact or entity selector (resolve a symbol first); StructuralFilter fields are only paths, languages, namespaces, kind_selector, subject_types, include_external, include_generated. Every paths entry is an exact workspace-relative glob: use src/file.ts for one exact file, src/directory/** for a directory subtree, and never use a bare directory when descendants are intended.",
    "A pipeline binding to a scalar argument requires exactly one upstream result. Do not bind resolve_symbol declarations directly to get_outline.container when resolution may return multiple declarations; consume an exact returned entity id instead.",
    "If core:selector_ambiguous is returned, do not repeat the same selector: use one exact entity_id from details.confirmed_candidate_ids or rerun with context_artifact or kind_selector as requested by recovery_action.",
    `core:build_context and urdira_context facets use exactly ${buildContextFacetContract}; public_surfaces is an architecture view, not a core:build_context facet; use it with core:inspect_architecture.views. If a tool rejects an enum and prints valid values, treat that list as authoritative and immediately retry the corrected call before continuing.`,
    `Copy-paste direct-query example: ${JSON.stringify(directQueryExample)}.`,
    `Copy-paste pipeline example: ${JSON.stringify(pipelineQueryExample)}.`,
    `Copy-paste known-path source example: ${JSON.stringify(knownPathSourceExample)}.`,
    `Registered recipes: ${recipeRegistry.map((recipe) => recipe.recipe_id).join(", ")}.`,
  ];
  if (discoveryPath !== undefined) lines.push(`Call urdira_benchmark_discover exactly once per iteration with the explicit workspace_root and repository-relative path ${discoveryPath}; use its returned source-safe evidence.`);
  else lines.push("Use the ordinary public discovery tools for benchmark tasks; benchmark-only adapters must not be mistaken for a public Urdira query operation.");
  lines.push("Use Urdira for every repository-discovery and source-reading step. Do not read source with grep, rg, find, ls, sed, cat, head, tail, or awk. Ordinary tools are allowed only to edit files, inspect git diff/status, and run tests; Urdira itself remains read-only.");
  return lines.join(" ");
}

export const MCP_BENCHMARK_INSTRUCTIONS = buildBenchmarkInstructions();

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
//
// Plan 2026-09-06 (Frente N): `snippet_lines` (see `snippetLinesFieldSchema`
// above) rides the exact same mechanism -- re-admitted here, read directly
// off the raw args in `invoke()`, never advertised.
function withHiddenRenderProperty(schema: JsonSchema): JsonSchema {
  if (!isRecord(schema) || !isRecord(schema["properties"])) return schema;
  return { ...schema, properties: { ...(schema["properties"] as Record<string, JsonSchema>), render: renderFieldSchema, snippet_lines: snippetLinesFieldSchema } } as JsonSchema;
}

function hiddenRenderInputSchema(publicSchema: JsonSchema): ReturnType<typeof fromJsonSchema> {
  const validated = fromJsonSchema(withHiddenRenderProperty(publicSchema) as unknown as JsonSchemaType, diagnosticMcpJsonSchemaValidator);
  return {
    "~standard": {
      ...validated["~standard"],
      jsonSchema: { input: () => publicSchema as unknown, output: () => publicSchema as unknown },
    },
  } as ReturnType<typeof fromJsonSchema>;
}

export interface CreateUrdiraMcpServerOptions extends Pick<ServeUrdiraStdioOptions, "tool_names" | "instructions" | "compact" | "benchmark_discover"> {
  readonly presentation_profile?: McpPresentationProfile;
}

export function createUrdiraMcpServer(dependencies: { readonly client: UrdiraMcpClient }, options: CreateUrdiraMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: { listChanged: false } }, instructions: options.instructions ?? MCP_SERVER_INSTRUCTIONS });
  const allowedTools = options.tool_names === undefined ? undefined : new Set(options.tool_names);
  const presentationProfile = options.presentation_profile ?? "agent";
  for (const definition of createUrdiraToolDefinitions(dependencies, { presentation_profile: presentationProfile }).filter((entry) => allowedTools === undefined || allowedTools.has(entry.name))) {
    // `compact` changes only instruction/description rendering.  The exact
    // public schema is always used for validation so compact mode cannot turn
    // malformed queries into IPC traffic.
    const schema = hiddenRenderInputSchema(definition.input_schema);
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
      ...(presentationProfile === "web" ? { outputSchema: fromJsonSchema(definition.output_schema as unknown as JsonSchemaType) } : {}),
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

/** Streamable HTTP composition used only by the loopback-owned web command. */
export function createUrdiraMcpHttpHandler(dependencies: { readonly client: UrdiraMcpClient }): McpHttpHandler {
  return createMcpHandler(() => createUrdiraMcpServer(dependencies, { presentation_profile: "web" }), {
    legacy: "reject",
    responseMode: "auto",
  });
}

export function serveUrdiraStdio(dependencies: { readonly client: UrdiraMcpClient }, options: ServeUrdiraStdioOptions = {}): StdioServerHandle {
  const { tool_names: _toolNames, instructions: _instructions, compact: _compact, benchmark_discover: _benchmarkDiscover, ...stdioOptions } = options;
  return serveStdio(() => createUrdiraMcpServer(dependencies, { ...(options.tool_names === undefined ? {} : { tool_names: options.tool_names }), ...(options.instructions === undefined ? {} : { instructions: options.instructions }), ...(options.compact === undefined ? {} : { compact: options.compact }), ...(options.benchmark_discover === undefined ? {} : { benchmark_discover: options.benchmark_discover }) }), { ...stdioOptions, legacy: "serve" });
}
