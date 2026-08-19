import {
  canonicalize,
  computeDigest,
} from "@urdira/canonical";
import {
  coreSchemaDefinitions,
  operationErrorRegistry,
  operationRegistry,
  queryAlgebraOperatorIds,
  recipeRegistry,
  validateSchemaValue,
  validateOperationArgumentsModelValue,
  validateQueryExpressionModelValue,
  type OperationArguments,
  type OperationDefinition,
  type QueryExpression,
  type QueryRequest,
  type QueryScope,
  type QueryStage,
  type RecipeDefinition,
  type RecipeExpression,
  type NormalizedQueryPlan as ContractNormalizedQueryPlan,
} from "@urdira/contracts";
import { EngineError } from "./errors.js";
import { collectStageOutputSelectors } from "./stage-output-selector.js";

export type QueryPlanErrorCode = (typeof operationErrorRegistry)[number]["code"];

export class QueryPlanError extends EngineError {
  constructor(override readonly code: QueryPlanErrorCode, message: string) {
    super(code, message);
    this.name = "QueryPlanError";
  }
}

export type NormalizedQueryPlan = ContractNormalizedQueryPlan & { readonly plan_digest: string };

const operatorSet = new Set<string>(queryAlgebraOperatorIds);
const MAX_RESPONSE_ITEMS = 100_000;
const MAX_RESPONSE_CHARACTERS = 10_000_000;

function invalid(code: QueryPlanErrorCode, message: string): never {
  throw new QueryPlanError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid("core:request_invalid", `${path} must be an object.`);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) invalid("core:unknown_field", `${path}.${unknown} is not a registered field.`);
  const missing = required.find((key) => !(key in value));
  if (missing) invalid("core:request_invalid", `${path}.${missing} is required.`);
}

function schema(schemaId: string): NonNullable<(typeof coreSchemaDefinitions)[number]> {
  const definition = coreSchemaDefinitions.find((candidate) => candidate.schema_id === schemaId);
  if (!definition) invalid("core:request_invalid", `No registered schema exists for ${schemaId}.`);
  return definition;
}

function validateSchema(schemaId: string, value: unknown, path: string, code: QueryPlanErrorCode = "core:request_invalid"): void {
  try {
    validateSchemaValue(schema(schemaId), value);
  } catch (error) {
    invalid(code, `${path} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function operationFor(id: string): OperationDefinition {
  const operation = operationRegistry.find((candidate) => candidate.operation_id === id);
  if (!operation) invalid("core:operation_unknown", `Unknown operation ${id}.`);
  return operation;
}

function recipeFor(id: string): RecipeDefinition {
  const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === id);
  if (!recipe) invalid("core:recipe_unknown", `Unknown recipe ${id}.`);
  return recipe;
}

function validateOperationArguments(operation: OperationDefinition, value: unknown, path: string): void {
  const fields = operation.argument_fields.map((field) => field.name);
  const required = operation.argument_fields.filter((field) => field.presence === "required").map((field) => field.name);
  exactObject(value, fields, required, path);
  try {
    validateOperationArgumentsModelValue(operation.operation_id, value, path);
  } catch (error) {
    invalid("core:request_invalid", `${path} is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePipelineContract(expression: QueryExpression): void {
  try {
    validateQueryExpressionModelValue(expression, "expression", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unknown field")) invalid("core:unknown_field", message);
    if (message.includes("earlier pipeline stage") || message.includes("registered output") || message.includes("duplicate stage") || message.includes("duplicate output")) invalid("core:stage_reference_invalid", message);
    invalid("core:request_invalid", message);
  }
}

function validateBudget(request: QueryRequest): void {
  const options = request.options;
  if (!isRecord(options)) invalid("core:request_invalid", "options must be an object.");
  exactObject(options, ["freshness", "wait_timeout_ms", "coverage_requirement", "evidence", "diagnostics", "snippets", "registry", "response_budget"], ["freshness", "wait_timeout_ms", "coverage_requirement", "evidence", "diagnostics", "snippets", "registry", "response_budget"], "options");
  exactObject(options["evidence"], ["evidence", "evidence_chain_depth"], ["evidence", "evidence_chain_depth"], "options.evidence");
  exactObject(options["diagnostics"], ["diagnostics", "diagnostic_detail"], ["diagnostics", "diagnostic_detail"], "options.diagnostics");
  exactObject(options["snippets"], ["mode", "max_characters_per_snippet", "max_total_characters", "context_lines"], ["mode", "max_characters_per_snippet", "max_total_characters", "context_lines"], "options.snippets");
  exactObject(options["registry"], ["registry", "include_payload_schemas"], ["registry", "include_payload_schemas"], "options.registry");
  exactObject(options["response_budget"], ["max_items", "max_characters"], ["max_items", "max_characters"], "options.response_budget");
  const budget = options["response_budget"];
  if (!isRecord(budget) || !Number.isSafeInteger(budget["max_items"]) || Number(budget["max_items"]) < 1 || Number(budget["max_items"]) > MAX_RESPONSE_ITEMS || !Number.isSafeInteger(budget["max_characters"]) || Number(budget["max_characters"]) < 1 || Number(budget["max_characters"]) > MAX_RESPONSE_CHARACTERS) {
    invalid("core:budget_invalid", "response_budget is outside the advertised bounds.");
  }
  if (!Number.isSafeInteger(options["wait_timeout_ms"]) || Number(options["wait_timeout_ms"]) < 0) invalid("core:budget_invalid", "wait_timeout_ms must be a non-negative safe integer.");
  if (!["snapshot", "current", "wait_for_current"].includes(String(options["freshness"]))) invalid("core:request_invalid", "freshness is not registered.");
  if (!["accept_reported", "require_complete"].includes(String(options["coverage_requirement"]))) invalid("core:request_invalid", "coverage_requirement is not registered.");
  const evidence = options["evidence"] as Record<string, unknown>;
  if (!["none", "summary", "full"].includes(String(evidence["evidence"])) || !Number.isSafeInteger(evidence["evidence_chain_depth"]) || Number(evidence["evidence_chain_depth"]) < 0) invalid("core:request_invalid", "evidence options are invalid.");
  const diagnostics = options["diagnostics"] as Record<string, unknown>;
  if (!["none", "relevant", "all"].includes(String(diagnostics["diagnostics"])) || typeof diagnostics["diagnostic_detail"] !== "boolean") invalid("core:request_invalid", "diagnostic options are invalid.");
  const snippets = options["snippets"] as Record<string, unknown>;
  if (!["none", "signature", "relevant", "body"].includes(String(snippets["mode"])) || ["max_characters_per_snippet", "max_total_characters", "context_lines"].some((name) => !Number.isSafeInteger(snippets[name]) || Number(snippets[name]) < 0)) invalid("core:request_invalid", "snippet options are invalid.");
  const registry = options["registry"] as Record<string, unknown>;
  if (!["none", "used", "full"].includes(String(registry["registry"])) || typeof registry["include_payload_schemas"] !== "boolean") invalid("core:request_invalid", "registry options are invalid.");
}

function validateScope(scope: QueryScope, allowed: readonly ("single_workspace" | "comparison")[]): void {
  if (!isRecord(scope)) invalid("core:invalid_query_scope", "scope must be an object.");
  if (scope.scope_type === "single_workspace") {
    exactObject(scope, ["scope_type", "workspace_id", "snapshot_id"], ["scope_type", "workspace_id"], "scope");
    if (!allowed.includes("single_workspace") || typeof scope.workspace_id !== "string" || scope.workspace_id.length === 0) invalid("core:invalid_query_scope", "The operation does not accept this single-workspace scope.");
    return;
  }
  if (scope.scope_type !== "comparison") invalid("core:invalid_query_scope", "scope_type must be single_workspace or comparison.");
  exactObject(scope, ["scope_type", "participants"], ["scope_type", "participants"], "scope");
  if (!allowed.includes("comparison") || !Array.isArray(scope.participants) || scope.participants.length < 2) invalid("core:invalid_query_scope", "Comparison scope is not accepted by the selected operation.");
  const identities = new Set<string>();
  for (const [index, participant] of scope.participants.entries()) {
    const participantValue = participant;
    exactObject(participant as unknown, ["workspace_id", "role", "snapshot_id"], ["workspace_id", "role"], `scope.participants[${index}]`);
    if (typeof participantValue.workspace_id !== "string" || participantValue.workspace_id.length === 0 || typeof participantValue.role !== "string" || participantValue.role.length === 0) invalid("core:participant_role_invalid", "Comparison participants require non-empty workspace and role identities.");
    const identity = `${participantValue.workspace_id}\u0000${participantValue.role}`;
    if (identities.has(identity)) invalid("core:duplicate_comparison_participant", `Duplicate comparison participant ${identity}.`);
    identities.add(identity);
  }
}

function arity(operator: string, count: number, stageId: string): void {
  const minimum: Readonly<Record<string, number>> = { "set.union": 2, "set.intersection": 2, deduplicate: 1, select: 1 };
  const exact: Readonly<Record<string, number>> = { "set.difference": 2, "expand.relations": 1, "expand.operation": 1, filter: 1, join: 2, "bind.record_selector": 1, "bind.subject_record_selector": 1, "source.operation": 0, "source.registry": 0 };
  if (minimum[operator] !== undefined && count < minimum[operator]) invalid("core:stage_type_mismatch", `Stage ${stageId} requires at least ${minimum[operator]} inputs.`);
  if (exact[operator] !== undefined && count !== exact[operator]) invalid("core:stage_type_mismatch", `Stage ${stageId} requires exactly ${exact[operator]} inputs.`);
}

function outputNames(stage: QueryStage, declared: ReadonlyMap<string, ReadonlySet<string>>): ReadonlySet<string> {
  const args = stage.arguments;
  if (!operatorSet.has(stage.operator)) invalid("core:stage_reference_invalid", `Stage ${stage.stage_id} uses unknown operator ${stage.operator}.`);
  if (stage.operator === "source.operation" || stage.operator === "expand.operation") {
    exactObject(args, ["operation", "operation_arguments", ...(stage.operator === "expand.operation" ? ["input_argument"] : [])], ["operation", "operation_arguments", ...(stage.operator === "expand.operation" ? ["input_argument"] : [])], `stage ${stage.stage_id}.arguments`);
    const operation = operationFor(String(args["operation"]));
    try {
      validateOperationArgumentsModelValue(operation.operation_id, args["operation_arguments"], `stage ${stage.stage_id}.arguments.operation_arguments`, {}, true, stage.operator === "expand.operation" ? String(args["input_argument"]) : undefined);
    } catch (error) {
      invalid("core:stage_reference_invalid", `${stage.stage_id} operation arguments are invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new Set(operation.result_streams);
  }
  if (stage.operator === "source.registry") {
    exactObject(args, ["matcher", "selector", "include_full_definitions"], ["matcher"], `stage ${stage.stage_id}.arguments`);
    return new Set(["definitions", "definition_set"]);
  }
  if (stage.operator === "set.union" || stage.operator === "set.intersection" || stage.operator === "set.difference") {
    exactObject(args, [], [], `stage ${stage.stage_id}.arguments`);
    return new Set(["subjects"]);
  }
  if (stage.operator === "filter") {
    exactObject(args, ["predicate"], ["predicate"], `stage ${stage.stage_id}.arguments`);
    return new Set(["subjects"]);
  }
  if (stage.operator === "deduplicate") {
    exactObject(args, ["identity", "include_possible"], ["identity"], `stage ${stage.stage_id}.arguments`);
    return new Set(["subjects"]);
  }
  if (stage.operator === "expand.relations") {
    exactObject(args, ["direction", "relations", "min_depth", "max_depth", "path_policy", "filter"], ["direction", "relations"], `stage ${stage.stage_id}.arguments`);
    if (!["inbound", "outbound", "both"].includes(String(args["direction"]))) invalid("core:request_invalid", `Stage ${stage.stage_id} has an invalid relation direction.`);
    return new Set(["subjects", "relations", "paths"]);
  }
  if (stage.operator === "join") {
    exactObject(args, ["predicate", "output", "relation_selector", "direction"], ["predicate", "output"], `stage ${stage.stage_id}.arguments`);
    if (typeof args["output"] !== "string" || !["pairs", "left", "right", "grouped"].includes(args["output"])) invalid("core:request_invalid", `Stage ${stage.stage_id} has an invalid join output.`);
    if (args["predicate"] === "relation_exists") {
      if (args["relation_selector"] === undefined || args["direction"] === undefined) invalid("core:request_invalid", `Stage ${stage.stage_id} relation_exists joins require relation_selector and direction.`);
      if (!["inbound", "outbound", "both"].includes(String(args["direction"]))) invalid("core:request_invalid", `Stage ${stage.stage_id} has an invalid join direction.`);
    }
    return new Set([String(args["output"])]) as ReadonlySet<string>;
  }
  if (stage.operator === "select") {
    if (!isRecord(args) || !Array.isArray(args["outputs"]) || args["outputs"].length === 0) invalid("core:request_invalid", `Stage ${stage.stage_id} must declare select outputs.`);
    const names = new Set<string>();
    for (const [outputIndex, selected] of args["outputs"].entries()) {
      exactObject(selected, ["name", "input", "projection", "filter"], ["name", "input", "projection"], `stage ${stage.stage_id}.arguments.outputs[${outputIndex}]`);
      if (typeof selected["name"] !== "string" || selected["name"].length === 0 || names.has(selected["name"])) invalid("core:stage_reference_invalid", `Stage ${stage.stage_id} has duplicate select output names.`);
      const input = selected["input"];
      exactObject(input, ["stage_id", "output"], ["stage_id", "output"], `stage ${stage.stage_id}.arguments.outputs[${outputIndex}].input`);
      if (!stage.inputs.some((candidate) => candidate.stage_id === input["stage_id"] && candidate.output === input["output"])) invalid("core:stage_reference_invalid", `Stage ${stage.stage_id} selects an undeclared input.`);
      if (!declared.get(String(input["stage_id"]))?.has(String(input["output"]))) invalid("core:stage_reference_invalid", `Stage ${stage.stage_id} selects an unknown input output.`);
      names.add(selected["name"]);
    }
    return names;
  }
  if (stage.operator === "bind.record_selector" || stage.operator === "bind.subject_record_selector") invalid("core:stage_reference_invalid", `${stage.operator} is reserved for recipe expansion.`);
  return new Set(["subjects"]);
}

export function validatePipelineExpression(expression: QueryExpression): void {
  if (!isRecord(expression) || expression["expression_type"] !== "pipeline") invalid("core:request_invalid", "Expected a pipeline expression.");
  exactObject(expression, ["expression_type", "stages", "outputs"], ["expression_type", "stages", "outputs"], "expression");
  if (!Array.isArray(expression.stages) || expression.stages.length === 0 || !Array.isArray(expression.outputs) || expression.outputs.length === 0) invalid("core:request_invalid", "A pipeline requires non-empty stages and outputs.");
  const stages = new Map<string, QueryStage>();
  const declared = new Map<string, ReadonlySet<string>>();
  const dependencies = new Map<string, Set<string>>();
  for (const [index, stage] of expression.stages.entries()) {
    const stageValue = stage;
    exactObject(stage as unknown, ["stage_id", "operator", "inputs", "arguments"], ["stage_id", "operator", "inputs", "arguments"], `expression.stages[${index}]`);
    if (typeof stageValue.stage_id !== "string" || stageValue.stage_id.length === 0 || stages.has(stageValue.stage_id)) invalid("core:stage_reference_invalid", `Stage ${stageValue.stage_id} is empty or duplicated.`);
    if (!Array.isArray(stageValue.inputs) || typeof stageValue.operator !== "string") invalid("core:request_invalid", `Stage ${stageValue.stage_id} has invalid inputs or operator.`);
    arity(stageValue.operator, stageValue.inputs.length, stageValue.stage_id);
    const refs = new Set<string>();
    for (const [inputIndex, input] of stageValue.inputs.entries()) {
      const inputValue = input;
      exactObject(input as unknown, ["stage_id", "output"], ["stage_id", "output"], `expression.stages[${index}].inputs[${inputIndex}]`);
      if (!stages.has(inputValue.stage_id)) invalid("core:stage_reference_invalid", `Stage ${stageValue.stage_id} must reference an earlier stage; forward references and cycles are forbidden.`);
      if (!declared.get(inputValue.stage_id)?.has(inputValue.output)) invalid("core:stage_reference_invalid", `Stage ${stageValue.stage_id} references unknown output ${inputValue.stage_id}.${inputValue.output}.`);
      refs.add(inputValue.stage_id);
    }
    // A `source.operation`/`expand.operation` stage's `stage.inputs` array is
    // ALWAYS empty (`arity` requires exactly 0/1 respectively, and the 1 for
    // `expand.operation` is its `input_argument`-bound upstream, already
    // captured above) -- these two stage kinds instead wire an earlier
    // stage's output through an embedded `stage_output` `SubjectSelector`
    // anywhere inside `operation_arguments` (see `stage-output-selector.ts`).
    // Without also tracking THOSE as dependency edges here, a pipeline whose
    // only wiring is via `stage_output` (the common case -- see
    // `docs/protocol/public-query-contract.md`'s pipeline examples) would
    // fail the reachability check below with a false "disconnected stages
    // are forbidden", since the referenced stage would never be visited.
    // Only ALREADY-DECLARED (`stages.has`, i.e. strictly earlier) stage ids
    // are added -- an unknown/forward reference is deliberately left out of
    // the dependency graph here (so it never confuses THIS reachability
    // check) and is instead reported precisely, with its own pointer and
    // message, by `validatePipelineContract`'s
    // `validateStageOutputCrossReferences` a few lines below.
    if (stageValue.operator === "source.operation" || stageValue.operator === "expand.operation") {
      const operationArguments = (stageValue.arguments as Record<string, unknown> | undefined)?.["operation_arguments"];
      for (const selector of collectStageOutputSelectors(operationArguments)) if (stages.has(selector.stage_id)) refs.add(selector.stage_id);
    }
    const names = outputNames(stageValue, declared);
    stages.set(stageValue.stage_id, stageValue);
    declared.set(stageValue.stage_id, names);
    dependencies.set(stageValue.stage_id, refs);
  }
  const roots = new Set<string>();
  const outputs = new Set<string>();
  for (const [index, output] of expression.outputs.entries()) {
    const outputValue = output;
    exactObject(output as unknown, ["stage_id", "output"], ["stage_id", "output"], `expression.outputs[${index}]`);
    const key = `${outputValue.stage_id}\u0000${outputValue.output}`;
    if (outputs.has(key)) invalid("core:stage_reference_invalid", `Duplicate pipeline output ${key}.`);
    if (!declared.get(outputValue.stage_id)?.has(outputValue.output)) invalid("core:stage_reference_invalid", `Pipeline output ${key} is unknown.`);
    outputs.add(key);
    roots.add(outputValue.stage_id);
  }
  const reachable = new Set<string>();
  const visit = (stageId: string): void => {
    if (reachable.has(stageId)) return;
    reachable.add(stageId);
    for (const dependency of dependencies.get(stageId) ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  if (reachable.size !== stages.size) invalid("core:stage_reference_invalid", "Every pipeline stage must contribute to a declared output; disconnected stages are forbidden.");
  validatePipelineContract(expression);
}

// Every field listed here is documented in `docs/protocol/core-intent-recipes.md`
// as a recipe argument with a public default, and is marked `optional` in its
// `core:*Arguments@1` inline schema (`packages/contracts/src/inline-schema-specs.ts`)
// specifically so a caller can omit it. Per that doc's `Registry rules`
// ("Public omission of a documented default is normalized before recipe
// hashing"), the default is injected HERE -- before `validateSchema` and
// before canonicalization -- so it is explicit in `normalized_expression`
// (and therefore in `plan_digest`) rather than an implicit runtime fallback
// a caller replaying the same plan_digest could not observe. This mirrors
// `normalizeQueryRequest`'s `core:resolve_symbol` default below. Only a
// field the caller left `undefined` is defaulted; an explicit value (even
// one equal to the default) always wins.
const recipeArgumentDefaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "core:locate_implementation": { query_class: "mixed" },
  "core:understand_change_impact": { include_transitive: true, include_tests: true },
  "core:prepare_new_feature": { query_class: "mixed" },
  "core:trace_behavior": { direction: "outbound", max_depth: 3, relations: { universal_kinds: ["core:call"] } },
  "core:find_relevant_tests": { relationship_scope: "both", include_fixtures: true },
  "core:explain_architecture_slice": { views: ["entry_points", "boundaries", "public_surfaces", "cycles", "extension_points", "layers"], max_relation_depth: 2 },
  "core:compare_workspaces": { comparison_kinds: ["added", "removed", "changed", "moved", "correlated"], correlation_policy: "strict" },
  "core:semantic_to_callers": { query_class: "mixed", max_call_depth: 2 },
  "core:resolve_and_find_references": { include_declarations: true },
};

function withRecipeArgumentDefaults(recipeId: string, args: unknown): unknown {
  const defaults = recipeArgumentDefaults[recipeId];
  if (!defaults || !isRecord(args)) return args;
  const defaulted: Record<string, unknown> = { ...args };
  for (const [field, value] of Object.entries(defaults)) if (defaulted[field] === undefined) defaulted[field] = value;
  return defaulted;
}

function recipeExpression(expression: RecipeExpression): { readonly recipe: RecipeDefinition; readonly operationVersions: ReadonlyArray<{ readonly operation_id: string; readonly operation_version: number }>; readonly normalizedArguments: unknown } {
  const recipe = recipeFor(expression.recipe_id);
  if (expression.recipe_version !== undefined && expression.recipe_version !== recipe.recipe_version) invalid("core:recipe_version_unsupported", `Recipe ${expression.recipe_id} only supports version ${recipe.recipe_version}.`);
  const normalizedArguments = withRecipeArgumentDefaults(expression.recipe_id, expression.arguments);
  validateSchema(recipe.argument_schema_id, normalizedArguments, "expression.arguments");
  const bindings = recipe.operation_stages.map((stage) => ({ operation_id: stage.operator_id, operation_version: stage.operator_version })).filter((binding) => binding.operation_id.startsWith("core:"));
  for (const binding of bindings) {
    const operation = operationRegistry.find((candidate) => candidate.operation_id === binding.operation_id && candidate.operation_version === binding.operation_version);
    if (!operation) invalid("core:operation_unknown", `Recipe ${recipe.recipe_id} references unknown operation ${binding.operation_id}@${binding.operation_version}.`);
  }
  return { recipe, operationVersions: bindings, normalizedArguments };
}

type OperationBinding = { readonly operation_id: string; readonly operation_version: number };

function uniqueSorted(bindings: readonly OperationBinding[]): OperationBinding[] {
  return [...new Map(bindings.map((binding) => [`${binding.operation_id}@${binding["operation_version"]}`, binding])).values()].sort((left, right) => left.operation_id.localeCompare(right.operation_id));
}

export function normalizeQueryRequest(request: QueryRequest): NormalizedQueryPlan {
  exactObject(request, ["api_version", "scope", "expression", "options"], ["api_version", "scope", "expression", "options"], "request");
  if (request.api_version !== 1 && request.api_version !== 2) invalid("core:api_version_unsupported", `API version ${request.api_version} is unsupported.`);
  validateBudget(request);
  const operationVersions: Array<{ operation_id: string; operation_version: number }> = [];
  let recipeVersions: Array<{ recipe_id: string; recipe_version: number }> = [];
  let normalizedExpression: QueryExpression = request.expression;
  if (!isRecord(request.expression)) invalid("core:request_invalid", "expression must be an object.");
  if (request.expression.expression_type === "operation") {
    exactObject(request.expression, ["expression_type", "operation", "arguments"], ["expression_type", "operation", "arguments"], "expression");
    const operation = operationFor(request.expression.operation);
    validateScope(request.scope, operation.allowed_scope_kinds);
    validateOperationArguments(operation, request.expression.arguments, "expression.arguments");
    operationVersions.push({ operation_id: operation.operation_id, operation_version: operation.operation_version });
    // `core:resolve_symbol`'s `resolution_scope` defaults to `visible` per
    // the public contract ONLY when a `context_artifact` is also given
    // (there is a concrete lexical context to be "visible" from); with
    // neither `resolution_scope` nor `context_artifact` present, the prior
    // undocumented behavior silently searched nothing narrower than
    // "visible with no context" -- which the in-memory/pushdown resolvers
    // both treated as an always-empty scope, making bare-name resolution an
    // adoption killer. The effective default is injected here, before
    // canonicalization, so it is explicit in `normalized_expression` (and
    // therefore in `plan_digest`) rather than an implicit runtime fallback
    // a caller replaying the same plan_digest could not observe.
    if (operation.operation_id === "core:resolve_symbol" && isRecord(request.expression.arguments)) {
      const operationArguments = request.expression.arguments as Record<string, unknown>;
      if (operationArguments["resolution_scope"] === undefined) {
        const withDefaultScope = { ...operationArguments, resolution_scope: operationArguments["context_artifact"] === undefined ? "workspace" : "visible" } as unknown as OperationArguments;
        normalizedExpression = { ...request.expression, arguments: withDefaultScope };
      }
    }
  } else if (request.expression.expression_type === "pipeline") {
    validateScope(request.scope, ["single_workspace", "comparison"]);
    validatePipelineExpression(request.expression);
    for (const stage of request.expression.stages) {
      if ((stage.operator === "source.operation" || stage.operator === "expand.operation") && isRecord(stage.arguments) && typeof stage.arguments["operation"] === "string") {
        const operation = operationFor(stage.arguments["operation"]);
        validateScope(request.scope, operation.allowed_scope_kinds);
        operationVersions.push({ operation_id: operation.operation_id, operation_version: operation.operation_version });
      }
    }
  } else if (request.expression.expression_type === "recipe") {
    validateScope(request.scope, ["single_workspace", "comparison"]);
    const resolved = recipeExpression(request.expression);
    recipeVersions = [{ recipe_id: resolved.recipe.recipe_id, recipe_version: resolved.recipe.recipe_version }];
    operationVersions.push(...resolved.operationVersions);
    normalizedExpression = { ...request.expression, recipe_version: resolved.recipe.recipe_version, arguments: resolved.normalizedArguments as RecipeExpression["arguments"] };
    for (const binding of resolved.operationVersions) validateScope(request.scope, operationFor(binding.operation_id).allowed_scope_kinds);
  } else {
    invalid("core:request_invalid", "expression_type must be operation, pipeline, or recipe.");
  }
  const normalizedCore: ContractNormalizedQueryPlan = {
    api_version: String(request.api_version),
    scope: freeze(canonicalize(clone(request.scope))),
    normalized_expression: freeze(canonicalize(clone(normalizedExpression))),
    freshness: request.options.freshness,
    wait_timeout_ms: request.options.wait_timeout_ms,
    coverage_requirement: request.options.coverage_requirement,
    projection: freeze(canonicalize(clone({ evidence: request.options.evidence, diagnostics: request.options.diagnostics, snippets: request.options.snippets, registry: request.options.registry }))),
    response_budget: freeze(canonicalize(clone(request.options.response_budget))),
    operation_versions: freeze(uniqueSorted(operationVersions)),
    recipe_versions: freeze([...recipeVersions].sort((left, right) => left.recipe_id.localeCompare(right.recipe_id))),
  };
  const plan_digest = computeDigest("core:query_plan", "core:query_plan_digest", 1, "core:NormalizedQueryPlan", 1, normalizedCore);
  return freeze({ ...normalizedCore, plan_digest });
}
