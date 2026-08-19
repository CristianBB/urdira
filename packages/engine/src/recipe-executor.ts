import { operationRegistry, type QueryScope, type RecipeDefinition, type RecipeGuardDefinition, type RecipeStageDefinition } from "@urdira/contracts";
import { EngineError, EngineErrorWithDetails } from "./errors.js";
import { evaluateOperation, type OperationEvaluation, type QueryDataPort, type QueryStreamItem } from "./query-operators.js";

/**
 * Real recipe executor for `QueryEngine.evaluate`'s `expression_type ===
 * "recipe"` branch. Replaces the previous placeholder, which called every
 * stage's operator with the SAME top-level recipe arguments and clobbered
 * same-named stream keys together (see `query-execution.ts`'s prior
 * `evaluate` implementation).
 *
 * Design:
 *  - Stages execute strictly in `recipe.stages` declaration order. Every
 *    `recipeSpecs` entry in `packages/contracts/src/registries.ts` already
 *    lists stages in dependency order (a stage's bindings only ever
 *    reference an earlier stage_id) -- this executor trusts that rather
 *    than re-deriving a topological sort, since the stage list is
 *    server-authored, not caller-authored.
 *  - Each `core:`-prefixed stage is a real operation, executed through
 *    `evaluateOperation` against the SAME `QueryDataPort` the top-level
 *    expression uses. Its arguments are assembled from three sources,
 *    lowest to highest precedence: (1) the stage's own `static_arguments`
 *    (author-pinned recipe policy, e.g. `source: {mode: "relevant"}`),
 *    (2) argument bindings sourced from the recipe's own `$/...` arguments,
 *    (3) argument bindings sourced from an earlier stage's output stream.
 *    (2) and (3) never collide in practice (`registries.ts`'s binding specs
 *    never target the same stage_argument_path twice), so simple sequential
 *    application is sufficient.
 *  - Two non-`core:` operator families are recipe-only algebra, per
 *    `docs/protocol/public-query-contract.md`'s `bind.record_selector` /
 *    `bind.subject_record_selector` section and the `filter` predicate
 *    section: `filter`, `bind.record_selector`, `bind.subject_record_selector`.
 *    These are implemented locally (`runFilterStage`/`runBindRecordSelectorStage`/
 *    `runBindSubjectRecordSelectorStage`) rather than through the operation
 *    registry, matching `query-plan.ts`'s own recognition that they are
 *    "reserved for recipe expansion" (see `validatePipelineExpression`).
 *  - A binding with an EMPTY `stage_argument_path` (materialized by
 *    `materializeRecipeBindings` when the binding target has no dotted
 *    field suffix, e.g. `"search.candidates->implementations"`) names the
 *    stage's PRIMARY INPUT STREAM rather than a named argument field --
 *    this is how the three algebra operators above receive their one
 *    upstream stream.
 *  - Guards (`recipe.guards`) run at their declared `evaluation_point`:
 *    `before_stage` guards run immediately before their `stage_id` starts,
 *    `after_stage` guards immediately after it finishes, `before_output`
 *    guards after every stage has run but before output streams are
 *    materialized. A failing guard throws a typed `EngineErrorWithDetails`
 *    using its `failure_error_code`.
 *  - Final output streams are read from `recipe.outputs`
 *    (`{output_name, stage_id, stage_output}`, materialized from
 *    `recipeOutputStages` in `registries.ts`) -- never `Object.assign`ed
 *    across stages, so same-named streams from different stages can never
 *    clobber each other.
 */
export interface ExecuteRecipeInput {
  readonly recipe: RecipeDefinition;
  readonly recipeArguments: Readonly<Record<string, unknown>>;
  readonly scope: QueryScope;
  readonly port: QueryDataPort;
}

type StageResults = ReadonlyMap<string, OperationEvaluation>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  return value;
}

function getDotPath(object: unknown, path: string): unknown {
  let current = object;
  for (const segment of path.split(".").filter((part) => part.length > 0)) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setSlashPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split("/").filter((part) => part.length > 0);
  if (segments.length === 0) return;
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    cursor = isRecord(next) ? next : (cursor[segment] = {});
  }
  cursor[segments[segments.length - 1]!] = value;
}

export function itemId(item: QueryStreamItem): string {
  const value = item.value as Record<string, unknown> | undefined;
  if (value === undefined) return "unknown";
  for (const field of ["entity_id", "relation_id", "diagnostic_id", "record_id", "identity_key"]) {
    const candidate = value[field];
    if (typeof candidate === "string") return candidate;
  }
  return "unknown";
}

/** Converts one upstream `ResultSubject`-shaped stream item into a `SubjectSelector` for a downstream operation argument -- every emitted `ResultSubject` carries `record_id` (see `recordValue` in `canonical-query-data-port.ts`), and `record` selectors are accepted by every subject-resolving operation regardless of the underlying record's category. */
export function toSubjectSelector(item: QueryStreamItem): Record<string, unknown> {
  const value = item.value as Record<string, unknown> | undefined;
  const body = value !== undefined && isRecord(value["body"]) ? value["body"] : undefined;
  const sourceSpan = value !== undefined && isRecord(value["source_span"]) ? value["source_span"] : undefined;
  const sourceSpanBinding = sourceSpan === undefined ? {} : { source_span: sourceSpan };
  if (value?.["universal_kind"] === "core:artifact" && body !== undefined && typeof body["artifact_id"] === "string" && typeof body["artifact_version_id"] === "string") {
    return { subject_type: "artifact", artifact_id: body["artifact_id"], artifact_version_id: body["artifact_version_id"], ...sourceSpanBinding };
  }
  return { subject_type: "record", record_id: itemId(item), ...sourceSpanBinding };
}

/**
 * Resolves one binding's source value. `$/`-prefixed bindings read the
 * recipe's own (already-validated, snake_case) arguments by dotted path.
 * Stage-output bindings read one or more `stageId.output` references,
 * joined by `+` for bindings that fan multiple upstream streams into one
 * argument (e.g. `"impact.all_classified_subjects+references.references+tests.tests->source.subjects"`).
 * An `output` name that is not a literal stream the producing stage
 * declared (`all_classified_subjects`, `all_requested_views`) is treated as
 * a synthetic union of every stream that stage actually produced -- the
 * recipe specs use these names precisely to mean "everything this stage
 * classified", and no operation registers a stream with that literal name.
 */
function resolveSource(sourceSpec: string, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): { readonly kind: "raw"; readonly value: unknown } | { readonly kind: "items"; readonly items: readonly QueryStreamItem[] } {
  if (sourceSpec.startsWith("$/")) return { kind: "raw", value: getDotPath(recipeArguments, sourceSpec.slice(2)) };
  const items: QueryStreamItem[] = [];
  for (const part of sourceSpec.split("+")) {
    const separator = part.indexOf(".");
    const stageId = separator < 0 ? part : part.slice(0, separator);
    const output = separator < 0 ? "" : part.slice(separator + 1);
    const stageEvaluation = stageResults.get(stageId);
    if (stageEvaluation === undefined) continue;
    const literalStream = stageEvaluation.streams[output];
    if (literalStream !== undefined) { items.push(...(literalStream as readonly QueryStreamItem[])); continue; }
    for (const values of Object.values(stageEvaluation.streams)) items.push(...(values as readonly QueryStreamItem[]));
  }
  return { kind: "items", items };
}

function operationFieldLogicalType(operatorId: string, fieldName: string): string | undefined {
  if (!operatorId.startsWith("core:")) return undefined;
  return operationRegistry.find((candidate) => candidate.operation_id === operatorId)?.argument_fields.find((field) => field.name === fieldName)?.logical_type;
}

/** Assembles the argument object for one `core:`-prefixed recipe stage. */
function assembleOperationArguments(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): Record<string, unknown> {
  const assembled = clone(stage.static_arguments) as Record<string, unknown>;
  for (const binding of stage.argument_bindings) {
    if (binding.stage_argument_path === "") continue; // Primary-input bindings only apply to recipe-only algebra stages.
    const source = binding.recipe_argument_path ?? binding.source_output_reference ?? "";
    const resolved = resolveSource(source, recipeArguments, stageResults);
    const fieldName = binding.stage_argument_path.split("/").filter((part) => part.length > 0).pop() ?? "";
    if (resolved.kind === "raw") {
      if (resolved.value !== undefined) setSlashPath(assembled, binding.stage_argument_path, clone(resolved.value));
      continue;
    }
    const logicalType = operationFieldLogicalType(stage.operator_id, fieldName);
    if (logicalType !== undefined && logicalType.startsWith("Sequence<") && logicalType.includes("SubjectSelector")) {
      setSlashPath(assembled, binding.stage_argument_path, resolved.items.map(toSubjectSelector));
    } else if (logicalType !== undefined && logicalType.includes("SubjectSelector")) {
      const first = resolved.items[0];
      if (first !== undefined) setSlashPath(assembled, binding.stage_argument_path, toSubjectSelector(first));
    } else if (fieldName === "selector" && resolved.items.length > 0) {
      // The sole producer of a "selector"-named stream in a recipe is one of
      // this module's own bind.* stages, whose single item IS already a
      // fully-formed RecordStructuralSelector -- pass it through untouched.
      setSlashPath(assembled, binding.stage_argument_path, clone(resolved.items[0]!.value));
    } else if (resolved.items.length > 0) {
      const values = resolved.items.map((entry) => entry.value);
      setSlashPath(assembled, binding.stage_argument_path, values.length === 1 ? values[0] : values);
    }
  }
  return assembled;
}

function primaryInput(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): readonly QueryStreamItem[] {
  const binding = stage.argument_bindings.find((candidate) => candidate.stage_argument_path === "");
  if (binding === undefined) return [];
  const source = binding.recipe_argument_path ?? binding.source_output_reference ?? "";
  const resolved = resolveSource(source, recipeArguments, stageResults);
  return resolved.kind === "items" ? resolved.items : [];
}

function boundValue(stage: RecipeStageDefinition, fieldName: string, recipeArguments: Readonly<Record<string, unknown>>): unknown {
  const binding = stage.argument_bindings.find((candidate) => candidate.stage_argument_path === `/${fieldName}`);
  if (binding === undefined || binding.recipe_argument_path === undefined) return undefined;
  return getDotPath(recipeArguments, binding.recipe_argument_path.slice(2));
}

/** The recipe-only `filter` algebra stage: filters its primary input stream by `static_arguments.filter.kind_selector` (universal_kinds / kinds / any_facets). */
function runFilterStage(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): OperationEvaluation {
  const input = primaryInput(stage, recipeArguments, stageResults);
  const filterSpec = isRecord(stage.static_arguments["filter"]) ? stage.static_arguments["filter"] as Record<string, unknown> : {};
  const kindSelector = isRecord(filterSpec["kind_selector"]) ? filterSpec["kind_selector"] as Record<string, unknown> : {};
  const kinds = new Set(Array.isArray(kindSelector["kinds"]) ? kindSelector["kinds"] as string[] : []);
  const universalKinds = new Set(Array.isArray(kindSelector["universal_kinds"]) ? kindSelector["universal_kinds"] as string[] : []);
  const anyFacets = new Set(Array.isArray(kindSelector["any_facets"]) ? kindSelector["any_facets"] as string[] : []);
  const filtered = input.filter((entry) => {
    const value = entry.value as Record<string, unknown>;
    if (kinds.size > 0 && !kinds.has(String(value["kind"]))) return false;
    if (universalKinds.size > 0 && !universalKinds.has(String(value["universal_kind"]))) return false;
    if (anyFacets.size > 0) {
      const facets = Array.isArray(value["facets"]) ? value["facets"] as string[] : [];
      if (!facets.some((facet) => anyFacets.has(facet))) return false;
    }
    return true;
  });
  return { streams: { subjects: filtered } };
}

const EMPTY_SELECTOR_SENTINEL_KIND = "core:__recipe_bind_empty_selector__";

function emptySelectorStream(): OperationEvaluation {
  return { streams: { selector: [{ value: { kind_selector: { kinds: [EMPTY_SELECTOR_SENTINEL_KIND] } }, stable_sort_key: "0" }] } };
}

interface DefinitionSetEntry { readonly definition_type?: unknown; readonly definition_id?: unknown; }

function definitionEntries(item: QueryStreamItem): readonly DefinitionSetEntry[] {
  const value = item.value as Record<string, unknown>;
  if (Array.isArray(value["definitions"])) return value["definitions"] as DefinitionSetEntry[];
  return [value as DefinitionSetEntry];
}

/**
 * The recipe-only `bind.record_selector` algebra stage. Per
 * `docs/protocol/public-query-contract.md`'s own section on this operator:
 * maps `record_kind` definitions to `KindSelector.kinds`, `facet`
 * definitions to `KindSelector.any_facets`, and `language` definitions to
 * `StructuralFilter.languages` (OR within a family, AND across families),
 * conjoined with the stage's own bound `record_categories`/`producer_ids`/
 * `filter`. An empty input produces the documented "exact empty-result
 * sentinel" (`EMPTY_SELECTOR_SENTINEL_KIND`, a `kind` no real record can
 * ever carry) rather than an unrestricted (matches-everything) selector.
 *
 * Note on `record_kind` mapping: there is no central registry of concrete
 * per-plugin record kinds (`"function"`, `"class"`, ...) for
 * `core:discover_definitions` to enumerate -- only the universal kind
 * vocabulary (`core:callable`, `core:type`, ...). This executor's
 * `core:discover_definitions` handler (see `canonical-query-data-port.ts`)
 * therefore sources `record_kind` definitions from that universal
 * vocabulary, and this function maps them into `KindSelector.universal_kinds`
 * (not `.kinds`) so they actually narrow `core:find_records`' real
 * `selected()` predicate. Documented simplification, not a literal reading
 * of the protocol text.
 */
function runBindRecordSelectorStage(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): OperationEvaluation {
  const input = primaryInput(stage, recipeArguments, stageResults);
  if (input.length === 0) return emptySelectorStream();
  const universalKinds = new Set<string>();
  const facets = new Set<string>();
  const languages = new Set<string>();
  const invalidFamilies = new Set<string>();
  for (const entry of input) {
    for (const definition of definitionEntries(entry)) {
      const type = definition.definition_type;
      const id = typeof definition.definition_id === "string" ? definition.definition_id : undefined;
      if (id === undefined) continue;
      if (type === "record_kind") universalKinds.add(id);
      else if (type === "facet") facets.add(id);
      else if (type === "language") languages.add(id);
      else invalidFamilies.add(String(type));
    }
  }
  if (universalKinds.size === 0 && facets.size === 0 && languages.size === 0 && invalidFamilies.size > 0) return emptySelectorStream();
  const recordCategories = boundValue(stage, "record_categories", recipeArguments);
  const producerIds = boundValue(stage, "producer_ids", recipeArguments);
  const explicitFilter = isRecord(boundValue(stage, "filter", recipeArguments)) ? boundValue(stage, "filter", recipeArguments) as Record<string, unknown> : {};
  const selector: Record<string, unknown> = {
    ...(Array.isArray(recordCategories) ? { record_categories: recordCategories } : {}),
    ...(universalKinds.size > 0 || facets.size > 0 ? { kind_selector: { ...(universalKinds.size > 0 ? { universal_kinds: [...universalKinds] } : {}), ...(facets.size > 0 ? { any_facets: [...facets] } : {}) } } : {}),
    ...(Array.isArray(producerIds) ? { producer_ids: producerIds } : {}),
    ...(languages.size > 0 || Object.keys(explicitFilter).length > 0 ? { filter: { ...(languages.size > 0 ? { languages: [...languages] } : {}), ...explicitFilter } } : {}),
  };
  return { streams: { selector: [{ value: selector, stable_sort_key: "0" }] } };
}

/** The recipe-only `bind.subject_record_selector` algebra stage: constructs `KindSelector.kinds` from the duplicate-free CONCRETE kind set of the primary-input subjects, and `StructuralFilter.languages` from their duplicate-free owning language (per protocol text; unlike `bind.record_selector`, this one does have real per-record `kind`/`language` values to read). */
function runBindSubjectRecordSelectorStage(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults): OperationEvaluation {
  const input = primaryInput(stage, recipeArguments, stageResults);
  if (input.length === 0) return emptySelectorStream();
  const kinds = new Set<string>();
  const languages = new Set<string>();
  for (const entry of input) {
    const value = entry.value as Record<string, unknown>;
    if (typeof value["kind"] === "string") kinds.add(value["kind"] as string);
    const body = isRecord(value["body"]) ? value["body"] as Record<string, unknown> : {};
    if (typeof body["language"] === "string") languages.add(body["language"] as string);
  }
  const explicitFilterValue = boundValue(stage, "filter", recipeArguments);
  const explicitFilter = isRecord(explicitFilterValue) ? explicitFilterValue as Record<string, unknown> : {};
  const selector: Record<string, unknown> = {
    ...(kinds.size > 0 ? { kind_selector: { kinds: [...kinds] } } : {}),
    ...(languages.size > 0 || Object.keys(explicitFilter).length > 0 ? { filter: { ...(languages.size > 0 ? { languages: [...languages] } : {}), ...explicitFilter } } : {}),
  };
  return { streams: { selector: [{ value: selector, stable_sort_key: "0" }] } };
}

async function runStage(stage: RecipeStageDefinition, recipeArguments: Readonly<Record<string, unknown>>, stageResults: StageResults, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  if (stage.operator_id.startsWith("core:")) {
    const args = assembleOperationArguments(stage, recipeArguments, stageResults);
    return evaluateOperation({ operation_id: stage.operator_id, operation_version: stage.operator_version, arguments: args, scope, port });
  }
  if (stage.operator_id === "filter") return runFilterStage(stage, recipeArguments, stageResults);
  if (stage.operator_id === "bind.record_selector") return runBindRecordSelectorStage(stage, recipeArguments, stageResults);
  if (stage.operator_id === "bind.subject_record_selector") return runBindSubjectRecordSelectorStage(stage, recipeArguments, stageResults);
  throw new EngineError("core:stage_reference_invalid", `Recipe stage ${stage.stage_id} names unsupported operator ${stage.operator_id}.`);
}

function asItems(values: ReadonlyArray<QueryStreamItem | unknown> | undefined): readonly QueryStreamItem[] {
  return (values ?? []) as readonly QueryStreamItem[];
}

function runGuard(guard: RecipeGuardDefinition, recipe: RecipeDefinition, scope: QueryScope, stageResults: StageResults): void {
  if (guard.guard_id === "core:one_confirmed_subject") {
    const items = asItems(stageResults.get(guard.stage_id)?.streams["declarations"]);
    const confirmed = items.filter((entry) => (entry.value as Record<string, unknown>)["classification"] === "confirmed");
    if (confirmed.length === 0) throw new EngineErrorWithDetails("core:selector_not_found", `${recipe.recipe_id}'s ${guard.stage_id} stage did not resolve a confirmed declaration.`, { recipe_id: recipe.recipe_id, stage_id: guard.stage_id, selector_pointer: "/reference", possible_candidate_ids: items.map(itemId) });
    if (confirmed.length > 1) throw new EngineErrorWithDetails("core:selector_ambiguous", `${recipe.recipe_id}'s ${guard.stage_id} stage resolved to multiple confirmed declarations.`, { recipe_id: recipe.recipe_id, stage_id: guard.stage_id, selector_pointer: "/reference", confirmed_candidate_ids: confirmed.map(itemId), possible_candidate_ids: items.filter((entry) => !confirmed.includes(entry)).map(itemId) });
    return;
  }
  if (guard.guard_id === "core:comparison_roles_base_target") {
    const roles = scope.scope_type === "comparison" ? scope.participants.map((participant) => participant.role) : [];
    if (scope.scope_type !== "comparison" || !roles.includes("base") || !roles.includes("target")) throw new EngineErrorWithDetails("core:invalid_query_scope", `${recipe.recipe_id} requires a comparison scope with "base" and "target" participant roles.`, { recipe_id: recipe.recipe_id, required_scope_kind: "comparison", required_roles: ["base", "target"], provided_scope_kind: scope.scope_type, provided_roles: roles });
    return;
  }
  if (guard.guard_id === "core:instance_definition_families") {
    const items = asItems(stageResults.get(guard.stage_id)?.streams["definition_set"]);
    const allowed = new Set(["record_kind", "facet", "language"]);
    const badTypes = new Set<string>();
    for (const entry of items) for (const definition of definitionEntries(entry)) if (typeof definition.definition_type === "string" && !allowed.has(definition.definition_type)) badTypes.add(definition.definition_type);
    if (badTypes.size > 0) throw new EngineErrorWithDetails("core:invalid_definition_instance_selector", `${recipe.recipe_id} only accepts record_kind, facet, and language definitions.`, { recipe_id: recipe.recipe_id, definition_ids: [...badTypes], definition_types: [...allowed], reason_code: "unsupported_definition_family" });
    return;
  }
}

export async function executeRecipe(input: ExecuteRecipeInput): Promise<OperationEvaluation> {
  const { recipe, recipeArguments, scope, port } = input;
  const stageResults = new Map<string, OperationEvaluation>();
  for (const stage of recipe.stages) {
    for (const guard of recipe.guards.filter((candidate) => candidate.stage_id === stage.stage_id && candidate.evaluation_point === "before_stage")) runGuard(guard, recipe, scope, stageResults);
    const result = await runStage(stage, recipeArguments, stageResults, scope, port);
    stageResults.set(stage.stage_id, result);
    for (const guard of recipe.guards.filter((candidate) => candidate.stage_id === stage.stage_id && candidate.evaluation_point === "after_stage")) runGuard(guard, recipe, scope, stageResults);
  }
  for (const guard of recipe.guards.filter((candidate) => candidate.evaluation_point === "before_output")) runGuard(guard, recipe, scope, stageResults);
  const streams: Record<string, readonly QueryStreamItem[]> = {};
  for (const output of recipe.outputs) streams[output.output_name] = asItems(stageResults.get(output.stage_id)?.streams[output.stage_output]);
  return { streams, completeness: { overall_status: "complete", dimensions: [] } };
}
