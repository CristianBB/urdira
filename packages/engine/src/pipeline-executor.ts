import type { QueryScope, QueryStage } from "@urdira/contracts";
import { EngineError, EngineErrorWithDetails } from "./errors.js";
import { evaluateOperation, type OperationEvaluation, type QueryDataPort, type QueryStreamItem } from "./query-operators.js";
import { toSubjectSelector } from "./recipe-executor.js";
import { isStageOutputSelector } from "./stage-output-selector.js";

/**
 * Real pipeline executor for `QueryEngine.evaluate`'s
 * `expression_type === "pipeline"` branch. Replaces the previous inline
 * loop in `query-execution.ts`, which forwarded every `source.operation`/
 * `expand.operation` stage's `operation_arguments` to `evaluateOperation`
 * VERBATIM -- the contract's designed cross-stage binding mechanism, the
 * `stage_output` `SubjectSelector` variant
 * (`{subject_type: "stage_output", stage_id, output}`,
 * `docs/protocol/public-query-contract.md` ~:25), was resolved NOWHERE, so
 * a pipeline like `search_text -> get_source(subjects=stage_output(search.matches))`
 * silently gave `get_source` an unresolvable selector and returned nothing.
 *
 * Design:
 *  - Stages execute strictly in `expression.stages` declaration order.
 *    `query-plan.ts`'s `validatePipelineExpression` already enforces that
 *    every `stage_output` reference (wherever it appears -- inside
 *    `stage.inputs` for the algebra operators below, OR embedded anywhere
 *    inside a `source.operation`/`expand.operation` stage's
 *    `operation_arguments`, see `stage-output-selector.ts`) names a
 *    STRICTLY EARLIER stage, so a single forward pass with a
 *    `Map<stage_id, OperationEvaluation>` accumulator is sufficient -- no
 *    topological sort needed.
 *  - `resolveStageOutputInValue` deep-walks a `source.operation`/
 *    `expand.operation` stage's raw `operation_arguments`, replacing every
 *    embedded `stage_output` selector with concrete `record` `SubjectSelector`s
 *    derived from the referenced stage's already-computed output stream --
 *    REUSING `toSubjectSelector`/`itemId`, the exact same stream-item ->
 *    `SubjectSelector` conversion `recipe-executor.ts` already uses for its
 *    own stage-result -> operation-argument bindings (`assembleOperationArguments`'s
 *    `Sequence<SubjectSelector>` and singular-`SubjectSelector` branches).
 *    A `stage_output` found as one element of an ARRAY is expanded in place
 *    into zero or more concrete selectors (how a caller "spreads" an entire
 *    upstream stream into a `Sequence<SubjectSelector>` field, e.g.
 *    `subjects: [{subject_type:"stage_output", stage_id:"search", output:"matches"}]`).
 *    A `stage_output` found as a SCALAR (non-array) field value is replaced
 *    by the first resolved item's selector when at least one exists (mirrors
 *    `recipe-executor.ts`'s own singular-`SubjectSelector` binding branch,
 *    which also just takes `items[0]`) and the field is left UNSET when the
 *    referenced stream is legitimately empty -- an empty upstream stream is
 *    not an error, only an UNKNOWN stage_id/output is.
 *  - `stage-output-selector.ts`'s shape check is shared with `query-plan.ts`
 *    (which needs it ahead of execution, to keep the reachability graph
 *    from rejecting a stage wired only through an embedded `stage_output`);
 *    an unknown stage_id/output is therefore normally already rejected at
 *    `normalizeQueryRequest` time via `core:stage_reference_invalid`. This
 *    module still re-checks at resolution time (`stageOutputStream` below)
 *    as defense in depth, with the same typed error.
 *  - `expand.operation`'s OWN upstream-binding shortcut (`input_argument`
 *    names the field that receives "the complete upstream set" from
 *    `stage.inputs[0]`, per the protocol doc's pipeline-operator section)
 *    is implemented alongside `stage_output` resolution -- both routes end
 *    up producing the same `record` selectors via `toSubjectSelector`.
 *  - `filter` is implemented against the SAME predicate shape
 *    `packages/contracts/src/schema-ir.ts`'s `validatePipelinePredicate`
 *    already validates (`all`/`any`/`not` composition over `path`,
 *    `language`, `subject_type`, `kind`, `facet`, `evidence_class`,
 *    `confidence`, `completeness`, `namespace`, `participant_role` leaves).
 *    Of those ten leaves, `path`/`language`/`subject_type`/`kind`/`facet`/
 *    `evidence_class` are evaluated against real per-item fields
 *    (`body.path`, `body.language`, `subject_type`, `kind`, `facets`,
 *    `classification`); `namespace`/`confidence`/`completeness`/
 *    `participant_role` have no well-defined per-`ResultSubject` field to
 *    evaluate against today and raise `core:request_invalid` naming the
 *    unsupported leaf rather than silently mismatching.
 *  - `set.union`/`set.intersection`/`set.difference` keep their EXACT prior
 *    comparison semantics (whole-`QueryStreamItem` `JSON.stringify`
 *    equality) -- unchanged, just relocated.
 *  - Every other registered pipeline operator (`source.registry`,
 *    `expand.relations`, `join`, `deduplicate`, `select`) is OUT OF SCOPE
 *    for this pass and keeps its pre-existing fallback behavior (forward
 *    the first declared input's stream unchanged) rather than a correct
 *    per-operator implementation -- a documented, pre-existing gap, not a
 *    regression introduced here.
 */
export interface ExecutePipelineInput {
  readonly stages: ReadonlyArray<QueryStage>;
  readonly outputs: ReadonlyArray<{ readonly stage_id: string; readonly output: string }>;
  readonly scope: QueryScope;
  readonly port: QueryDataPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asItems(values: unknown): readonly QueryStreamItem[] {
  return Array.isArray(values) ? (values as readonly QueryStreamItem[]) : [];
}

function stageOutputStream(selector: { readonly stage_id: string; readonly output: string }, stageResults: ReadonlyMap<string, OperationEvaluation>, consumingStageId: string): readonly QueryStreamItem[] {
  const producer = stageResults.get(selector.stage_id);
  if (producer === undefined) throw new EngineErrorWithDetails("core:stage_reference_invalid", `Stage ${consumingStageId} references stage_output of unknown or not-yet-executed stage ${selector.stage_id}.`, { stage_id: consumingStageId, referenced_stage_id: selector.stage_id, referenced_output: selector.output });
  const stream = producer.streams[selector.output];
  if (stream === undefined) throw new EngineErrorWithDetails("core:stage_reference_invalid", `Stage ${consumingStageId} references unknown output "${selector.output}" of stage ${selector.stage_id}.`, { stage_id: consumingStageId, referenced_stage_id: selector.stage_id, referenced_output: selector.output });
  return asItems(stream);
}

/** See this module's top doc comment for the full resolution contract. */
function resolveStageOutputInValue(value: unknown, stageResults: ReadonlyMap<string, OperationEvaluation>, consumingStageId: string): unknown {
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const entry of value) {
      if (isStageOutputSelector(entry)) {
        for (const streamItem of stageOutputStream(entry, stageResults, consumingStageId)) resolved.push(toSubjectSelector(streamItem));
      } else {
        resolved.push(resolveStageOutputInValue(entry, stageResults, consumingStageId));
      }
    }
    return resolved;
  }
  if (isStageOutputSelector(value)) {
    const stream = stageOutputStream(value, stageResults, consumingStageId);
    const first = stream[0];
    return first === undefined ? undefined : toSubjectSelector(first);
  }
  if (isRecord(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const resolvedEntry = resolveStageOutputInValue(entry, stageResults, consumingStageId);
      if (resolvedEntry !== undefined) resolved[key] = resolvedEntry;
    }
    return resolved;
  }
  return value;
}

// --- `filter` predicate evaluation ------------------------------------
//
// Mirrors `packages/contracts/src/schema-ir.ts`'s `validatePipelinePredicate`
// shape exactly: a predicate object has exactly one key, either a
// composition variant (`all`/`any`: non-empty array of child predicates;
// `not`: one child predicate) or a leaf variant (a non-empty array of
// non-empty strings; a subject matches a leaf when its own value is a
// member of that array -- the same "value is in the accepted set" reading
// every other selector/filter field in this codebase uses).

const SUPPORTED_PREDICATE_LEAVES = new Set(["path", "language", "subject_type", "kind", "facet", "evidence_class"]);

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesPredicate(predicate: unknown, item: QueryStreamItem, stageId: string): boolean {
  if (!isRecord(predicate)) throw new EngineError("core:request_invalid", `Stage ${stageId}'s filter predicate must be an object.`);
  const keys = Object.keys(predicate);
  const variant = keys[0];
  if (keys.length !== 1 || variant === undefined) throw new EngineError("core:request_invalid", `Stage ${stageId}'s filter predicate must contain exactly one predicate variant.`);
  if (variant === "all") return (predicate["all"] as readonly unknown[]).every((child) => matchesPredicate(child, item, stageId));
  if (variant === "any") return (predicate["any"] as readonly unknown[]).some((child) => matchesPredicate(child, item, stageId));
  if (variant === "not") return !matchesPredicate(predicate["not"], item, stageId);
  if (!SUPPORTED_PREDICATE_LEAVES.has(variant)) throw new EngineError("core:request_invalid", `Stage ${stageId}'s filter predicate leaf "${variant}" has no per-subject field to evaluate and is not yet supported by pipeline execution (supported: ${[...SUPPORTED_PREDICATE_LEAVES].join(", ")}, plus all/any/not).`);
  const accepted = predicate[variant] as readonly string[];
  const value = item.value as Record<string, unknown>;
  const body = isRecord(value["body"]) ? (value["body"] as Record<string, unknown>) : {};
  if (variant === "subject_type") return accepted.includes(String(value["subject_type"] ?? ""));
  if (variant === "kind") return accepted.includes(String(value["kind"] ?? ""));
  if (variant === "facet") {
    const facets = Array.isArray(value["facets"]) ? (value["facets"] as readonly string[]) : [];
    return accepted.some((facet) => facets.includes(facet));
  }
  if (variant === "language") return accepted.includes(String(body["language"] ?? ""));
  if (variant === "evidence_class") {
    const classification = String(value["classification"] ?? item.result_classification ?? "confirmed");
    return accepted.includes("both") || accepted.includes(classification);
  }
  // variant === "path"
  const path = String(body["path"] ?? "");
  return accepted.some((glob) => globToRegExp(glob).test(path));
}

function runFilterStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>): OperationEvaluation {
  const input = stage.inputs[0] ? stageOutputInput(stage.inputs[0], stageResults) : [];
  const predicate = (stage.arguments as Record<string, unknown>)["predicate"];
  return { streams: { subjects: input.filter((entry) => matchesPredicate(predicate, entry, stage.stage_id)) } };
}

function stageOutputInput(input: { readonly stage_id: string; readonly output: string }, stageResults: ReadonlyMap<string, OperationEvaluation>): readonly QueryStreamItem[] {
  return asItems(stageResults.get(input.stage_id)?.streams[input.output]);
}

function sameSubject(left: QueryStreamItem, right: QueryStreamItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runSetStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>): OperationEvaluation {
  const inputPages = stage.inputs.map((input) => stageOutputInput(input, stageResults));
  const values =
    stage.operator === "set.union"
      ? inputPages.flat()
      : (inputPages[0] ?? []).filter((candidate) =>
          stage.operator === "set.intersection"
            ? inputPages.every((page) => page.some((other) => sameSubject(other, candidate)))
            : !inputPages.slice(1).some((page) => page.some((other) => sameSubject(other, candidate))),
        );
  return { streams: { subjects: values } };
}

async function runSourceOrExpandStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  const rawArguments = stage.arguments as Record<string, unknown>;
  const resolvedArguments = resolveStageOutputInValue(rawArguments["operation_arguments"], stageResults, stage.stage_id) as Record<string, unknown>;
  if (stage.operator === "expand.operation") {
    const inputArgumentField = String(rawArguments["input_argument"]);
    const upstream = stage.inputs[0] ? stageOutputInput(stage.inputs[0], stageResults) : [];
    resolvedArguments[inputArgumentField] = upstream.map(toSubjectSelector);
  }
  return evaluateOperation({ operation_id: String(rawArguments["operation"]), arguments: resolvedArguments, scope, port });
}

async function runStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  if (stage.operator === "source.operation" || stage.operator === "expand.operation") return runSourceOrExpandStage(stage, stageResults, scope, port);
  if (stage.operator === "set.union" || stage.operator === "set.intersection" || stage.operator === "set.difference") return runSetStage(stage, stageResults);
  if (stage.operator === "filter") return runFilterStage(stage, stageResults);
  // Documented pre-existing gap (see this module's top doc comment):
  // `source.registry`, `expand.relations`, `join`, `deduplicate`, `select`
  // are not yet implemented; forward the first declared input unchanged
  // rather than regress their (already incomplete) prior behavior.
  const source = stage.inputs[0] ? stageOutputInput(stage.inputs[0], stageResults) : [];
  return { streams: { subjects: source } };
}

export async function executePipeline(input: ExecutePipelineInput): Promise<OperationEvaluation> {
  const stageResults = new Map<string, OperationEvaluation>();
  for (const stage of input.stages) stageResults.set(stage.stage_id, await runStage(stage, stageResults, input.scope, input.port));
  const outputStreams: Record<string, readonly QueryStreamItem[]> = {};
  for (const output of input.outputs) outputStreams[output.output] = stageResults.get(output.stage_id)?.streams[output.output] as readonly QueryStreamItem[] | undefined ?? stageResults.get(output.stage_id)?.streams["subjects"] as readonly QueryStreamItem[] | undefined ?? [];
  return { streams: outputStreams, completeness: { overall_status: "complete", dimensions: [] } };
}
