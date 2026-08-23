import type { QueryScope, QueryStage } from "@urdira/contracts";
import { EngineError, EngineErrorWithDetails } from "./errors.js";
import { evaluateOperation, type OperationEvaluation, type QueryDataPort, type QueryStreamItem } from "./query-operators.js";
import { toSubjectSelector } from "./recipe-executor.js";
import { collectStageOutputSelectors, isStageOutputSelector } from "./stage-output-selector.js";
import type { StageSetHandle } from "./stage-set-handle.js";
import { MemoryStageSpool, type StageSpool } from "./pipeline-spool.js";

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
 *  - The v3 envelope is normalized to an explicit dependency DAG. Ready
 *    independent stages execute concurrently; dependent stages wait for the
 *    complete upstream output and scalar bindings enforce one-item cardinality.
 *  - Every registered operator has explicit dispatch and set identity uses
 *    stable canonical subject keys. Relation joins require the batch relation
 *    port so large inputs never fall back to a Cartesian probe.
 *  - Each stream is sealed into an execution-local spool and represented by a
 *    StageSetHandle; only final streams are hydrated into cursor manifests.
 *
 * Compatibility details:
 *  - Stages execute in dependency order (not merely array order), and
 *    `stage_output` references are validated as strictly earlier producers.
 *    `query-plan.ts`'s `validatePipelineExpression` already enforces that
 *    every `stage_output` reference (wherever it appears -- inside
 *    `stage.inputs` for the algebra operators below, OR embedded anywhere
 *    inside a `source.operation`/`expand.operation` stage's
 *    `operation_arguments`, see `stage-output-selector.ts`) names a
 *    STRICTLY EARLIER stage. The executor still schedules by a ready
 *    frontier so independent branches can run concurrently while dependent
 *    stages remain ordered.
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
 *    A `stage_output` found as a SCALAR (non-array) field value requires
 *    exactly one resolved item; zero or multiple items are typed cardinality
 *    errors rather than an implicit first-element choice.
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
 *  - Array-shaped operation ports remain supported for legacy providers; the
 *    spool and batch relation capability bound the expensive relational work.
 */
export interface ExecutePipelineInput {
  readonly execution_id?: string;
  readonly stages: ReadonlyArray<QueryStage>;
  readonly outputs: ReadonlyArray<{ readonly stage_id: string; readonly output: string; readonly name?: string }>;
  readonly scope: QueryScope;
  readonly port: QueryDataPort;
  /** Optional execution-local relational spool. */
  readonly spool?: StageSpool;
  /** Resource guard applied before a dependent stage is started. */
  readonly resource_budget?: { readonly max_intermediate_rows?: number; readonly max_intermediate_bytes?: number };
  readonly abort_signal?: AbortSignal;
  /** QueryEngine enables this to keep final outputs lazy until manifest append;
   * direct callers retain the historical eager `streams` result by default. */
  readonly stream_final?: boolean;
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

function stageOutputHandle(selector: { readonly stage_id: string; readonly output: string }, stageHandles: ReadonlyMap<string, StageSetHandle>, consumingStageId: string): StageSetHandle {
  const handle = stageHandles.get(`${selector.stage_id}\u0000${selector.output}`);
  if (handle === undefined) throw new EngineErrorWithDetails("core:stage_reference_invalid", `Stage ${consumingStageId} references an unsealed output of stage ${selector.stage_id}.`, { stage_id: consumingStageId, referenced_stage_id: selector.stage_id, referenced_output: selector.output });
  return handle;
}

async function collectStageOutput(selector: { readonly stage_id: string; readonly output: string }, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, consumingStageId: string): Promise<readonly QueryStreamItem[]> {
  const handle = stageHandles.get(`${selector.stage_id}\u0000${selector.output}`);
  if (handle?.iterate !== undefined) {
    const values: QueryStreamItem[] = [];
    for await (const value of handle.iterate()) values.push(value);
    return values;
  }
  return stageOutputStream(selector, stageResults, consumingStageId);
}

function stageOutputIterator(selector: { readonly stage_id: string; readonly output: string }, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, consumingStageId: string): AsyncIterable<QueryStreamItem> {
  const handle = stageHandles.get(`${selector.stage_id}\u0000${selector.output}`);
  if (handle?.iterate !== undefined) return handle.iterate();
  const values = stageOutputStream(selector, stageResults, consumingStageId);
  return (async function* (): AsyncIterable<QueryStreamItem> { for (const value of values) yield value; })();
}

/** See this module's top doc comment for the full resolution contract. */
async function resolveStageOutputInValue(value: unknown, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, consumingStageId: string, preserveHandles = false): Promise<unknown> {
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const entry of value) {
      if (isStageOutputSelector(entry)) {
        const handle = stageHandles.get(`${entry.stage_id}\u0000${entry.output}`);
        if (preserveHandles && handle !== undefined) resolved.push(entry);
        else for await (const streamItem of stageOutputIterator(entry, stageResults, stageHandles, consumingStageId)) resolved.push(toSubjectSelector(streamItem));
      } else {
        resolved.push(await resolveStageOutputInValue(entry, stageResults, stageHandles, consumingStageId, preserveHandles));
      }
    }
    return resolved;
  }
  if (isStageOutputSelector(value)) {
    const handle = stageHandles.get(`${value.stage_id}\u0000${value.output}`);
    if (preserveHandles && handle !== undefined) {
      if (handle.row_count !== 1) throw new EngineErrorWithDetails("core:stage_type_mismatch", `Stage ${consumingStageId} requires exactly one upstream subject but ${handle.row_count} were produced.`, { stage_id: consumingStageId, referenced_stage_id: value.stage_id, referenced_output: value.output, cardinality: "one", actual_count: handle.row_count });
      return value;
    }
    const stream = stageOutputIterator(value, stageResults, stageHandles, consumingStageId);
    let first: QueryStreamItem | undefined;
    let count = 0;
    for await (const candidate of stream) { if (count === 0) first = candidate; count += 1; if (count > 1) break; }
    if (count !== 1) throw new EngineErrorWithDetails("core:stage_type_mismatch", `Stage ${consumingStageId} requires exactly one upstream subject but ${count > 1 ? "multiple" : "zero"} were produced.`, { stage_id: consumingStageId, referenced_stage_id: value.stage_id, referenced_output: value.output, cardinality: "one", actual_count: count });
    return first === undefined ? undefined : toSubjectSelector(first);
  }
  if (isRecord(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const resolvedEntry = await resolveStageOutputInValue(entry, stageResults, stageHandles, consumingStageId, preserveHandles);
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

function lazyStageInput(stage: QueryStage, index: number, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>): AsyncIterable<QueryStreamItem> {
  const input = stage.inputs[index];
  if (input === undefined) return (async function* (): AsyncIterable<QueryStreamItem> {})();
  return stageOutputIterator(input, stageResults, stageHandles, stage.stage_id);
}

function runFilterStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>): OperationEvaluation {
  const predicate = (stage.arguments as Record<string, unknown>)["predicate"];
  const source = lazyStageInput(stage, 0, stageResults, stageHandles);
  const filtered = async function* (): AsyncIterable<QueryStreamItem> {
    for await (const entry of source) if (matchesPredicate(predicate, entry, stage.stage_id)) yield entry;
  };
  return { streams: { subjects: [] }, stream_sources: { subjects: filtered() } };
}

function stageOutputInput(input: { readonly stage_id: string; readonly output: string }, stageResults: ReadonlyMap<string, OperationEvaluation>): readonly QueryStreamItem[] {
  return asItems(stageResults.get(input.stage_id)?.streams[input.output]);
}

/**
 * A deterministic identity key for pipeline set operations.  The previous
 * implementation used JSON.stringify on complete stream items and performed
 * a nested scan for every candidate.  Besides making equivalent subjects
 * depend on object insertion order, that was quadratic for large upstream
 * sets.  Pipeline operators only need a logical identity, so keep the key
 * small and derive it from the registered subject identity fields.
 */
function logicalKey(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `s:${value.length}:${value}`;
  if (typeof value === "number") return `n:${String(value)}`;
  if (typeof value === "boolean") return `b:${value ? "1" : "0"}`;
  if (Array.isArray(value)) return `a:[${value.map(logicalKey).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `o:{${entries.map(([key, entry]) => `${logicalKey(key)}=${logicalKey(entry)}`).join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function subjectKey(item: QueryStreamItem, identity: "subject" | "entity" | "artifact" | "portable_key" = "subject"): string {
  const value = isRecord(item.value) ? item.value : {};
  const body = isRecord(value["body"]) ? value["body"] : {};
  const field = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const candidate = value[name] ?? body[name];
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return undefined;
  };
  if (identity === "entity") return `entity:${field(["entity_id", "record_id", "identity_key"]) ?? logicalKey(item.value)}`;
  if (identity === "artifact") return `artifact:${field(["artifact_version_id", "artifact_id"]) ?? logicalKey(item.value)}`;
  if (identity === "portable_key") return `portable:${field(["portable_key", "identity_key", "record_id", "entity_id", "artifact_id"]) ?? logicalKey(item.value)}`;
  return `subject:${field(["record_id", "entity_id", "relation_id", "diagnostic_id", "identity_key", "artifact_version_id", "artifact_id"]) ?? logicalKey(item.value)}`;
}

function uniqueItems(values: readonly QueryStreamItem[], identity: "subject" | "entity" | "artifact" | "portable_key" = "subject"): readonly QueryStreamItem[] {
  const seen = new Set<string>();
  const result: QueryStreamItem[] = [];
  for (const value of values) {
    const key = subjectKey(value, identity);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function runSetStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>): OperationEvaluation {
  const source = async function* (): AsyncIterable<QueryStreamItem> {
    const seen = new Set<string>();
    if (stage.operator === "set.union") {
      for (let index = 0; index < stage.inputs.length; index += 1) for await (const item of lazyStageInput(stage, index, stageResults, stageHandles)) {
        const key = subjectKey(item);
        if (!seen.has(key)) { seen.add(key); yield item; }
      }
      return;
    }
    const membership: Set<string>[] = [];
    for (let index = 1; index < stage.inputs.length; index += 1) {
      const keys = new Set<string>();
      for await (const item of lazyStageInput(stage, index, stageResults, stageHandles)) keys.add(subjectKey(item));
      membership.push(keys);
    }
    for await (const candidate of lazyStageInput(stage, 0, stageResults, stageHandles)) {
      const key = subjectKey(candidate);
      const matches = stage.operator === "set.intersection" ? membership.every((set) => set.has(key)) : membership.every((set) => !set.has(key));
      if (matches && !seen.has(key)) { seen.add(key); yield candidate; }
    }
  };
  return { streams: { subjects: [] }, stream_sources: { subjects: source() } };
}

function runDeduplicateStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>): OperationEvaluation {
  const args = stage.arguments as Record<string, unknown>;
  const identity = args["identity"] === "entity" || args["identity"] === "artifact" || args["identity"] === "portable_key" ? args["identity"] : "subject";
  const source = async function* (): AsyncIterable<QueryStreamItem> {
    const seen = new Set<string>();
    for (let index = 0; index < stage.inputs.length; index += 1) for await (const item of lazyStageInput(stage, index, stageResults, stageHandles)) {
      const key = subjectKey(item, identity);
      if (!seen.has(key)) { seen.add(key); yield item; }
    }
  };
  return { streams: { subjects: [] }, stream_sources: { subjects: source() } };
}

function runSelectStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>): OperationEvaluation {
  const args = stage.arguments as Record<string, unknown>;
  const streams: Record<string, readonly QueryStreamItem[]> = {};
  const stream_sources: Record<string, AsyncIterable<QueryStreamItem>> = {};
  for (const selected of (args["outputs"] as readonly Record<string, unknown>[]) ?? []) {
    const input = selected["input"] as { stage_id: string; output: string };
    const filter = selected["filter"];
    const source = stageOutputIterator(input, stageResults, stageHandles, stage.stage_id);
    stream_sources[String(selected["name"])] = (async function* (): AsyncIterable<QueryStreamItem> {
      for await (const entry of source) if (filter === undefined || matchesPredicate(filter, entry, stage.stage_id)) yield entry;
    })();
    streams[String(selected["name"])] = [];
  }
  return { streams, stream_sources };
}

function joinKey(item: QueryStreamItem, predicate: string): string {
  if (predicate === "same_entity") return subjectKey(item, "entity");
  if (predicate === "same_artifact") return subjectKey(item, "artifact");
  if (predicate === "portable_key_equal") return subjectKey(item, "portable_key");
  return subjectKey(item);
}

async function runJoinStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  const args = stage.arguments as Record<string, unknown>;
  const predicate = String(args["predicate"]);
  if (predicate === "relation_exists") {
    if (port.relation_exists === undefined) throw new EngineError("core:required_capability_unsupported", "relation_exists joins require the relational query port capability.");
    const selector = args["relation_selector"];
    const direction = String(args["direction"]) as "inbound" | "outbound" | "both";
    const pairs: QueryStreamItem[] = [];
    const leftHandle = stage.inputs[0] === undefined ? undefined : stageHandles.get(`${stage.inputs[0].stage_id}\u0000${stage.inputs[0].output}`);
    const rightHandle = stage.inputs[1] === undefined ? undefined : stageHandles.get(`${stage.inputs[1].stage_id}\u0000${stage.inputs[1].output}`);
    if (port.relation_pairs_handles !== undefined && leftHandle !== undefined && rightHandle !== undefined) {
      const matching = await port.relation_pairs_handles(scope, leftHandle, rightHandle, selector, direction);
      const source = async function* (): AsyncIterable<QueryStreamItem> {
        const matchingByLeft = new Map<string, string[]>();
        for (const key of matching) {
          const separator = key.indexOf("\u0000");
          if (separator <= 0 || separator === key.length - 1) continue;
          const leftKey = key.slice(0, separator);
          const bucket = matchingByLeft.get(leftKey);
          if (bucket === undefined) matchingByLeft.set(leftKey, [key.slice(separator + 1)]);
          else bucket.push(key.slice(separator + 1));
        }
        const rightByKey = new Map<string, QueryStreamItem>();
        const rightKeys = new Set([...matchingByLeft.values()].flat());
        for await (const item of rightHandle.iterate!()) if (rightKeys.has(item.stable_sort_key)) rightByKey.set(item.stable_sort_key, item);
        const seen = new Set<string>();
        for await (const leftItem of leftHandle.iterate!()) for (const rightKey of matchingByLeft.get(leftItem.stable_sort_key) ?? []) {
          const key = `${leftItem.stable_sort_key}\u0000${rightKey}`;
          const rightItem = rightByKey.get(rightKey);
          if (rightItem !== undefined && !seen.has(key)) { seen.add(key); yield { value: { left: leftItem.value, right: rightItem.value }, stable_sort_key: key }; }
        }
      };
      return { streams: { pairs: [] }, stream_sources: { pairs: source() } };
    } else if (port.relation_pairs !== undefined) {
      const left = await collectStageOutput(stage.inputs[0]!, stageResults, stageHandles, stage.stage_id);
      const right = await collectStageOutput(stage.inputs[1]!, stageResults, stageHandles, stage.stage_id);
      const pairs: QueryStreamItem[] = [];
      const matching = await port.relation_pairs(scope, left, right, selector, direction);
      const leftByKey = new Map(left.map((item) => [item.stable_sort_key, item]));
      const rightByKey = new Map(right.map((item) => [item.stable_sort_key, item]));
      for (const key of matching) {
        const separator = key.indexOf("\u0000");
        const leftItem = leftByKey.get(key.slice(0, separator));
        const rightItem = rightByKey.get(key.slice(separator + 1));
        if (leftItem !== undefined && rightItem !== undefined) pairs.push({ value: { left: leftItem.value, right: rightItem.value }, stable_sort_key: key });
      }
    } else {
      // A scalar relation predicate cannot be safely applied to a large
      // pipeline by probing every Cartesian pair.  Require the batch port
      // capability instead of reintroducing the quadratic implementation that
      // caused the benchmark's mass-operation regressions.
      throw new EngineError("core:required_capability_unsupported", "relation_exists joins require the batch relation_pairs capability for bounded execution.");
    }
    return { streams: { pairs: uniqueItems(pairs) } };
  }
  const rightByKey = new Map<string, QueryStreamItem[]>();
  const rightHandle = stage.inputs[1] === undefined ? undefined : stageHandles.get(`${stage.inputs[1].stage_id}\u0000${stage.inputs[1].output}`);
  const leftHandle = stage.inputs[0] === undefined ? undefined : stageHandles.get(`${stage.inputs[0].stage_id}\u0000${stage.inputs[0].output}`);
  const rightItems: QueryStreamItem[] = [];
  const rightSource = rightHandle?.iterate?.() ?? (async function* (): AsyncIterable<QueryStreamItem> { for (const item of await collectStageOutput(stage.inputs[1]!, stageResults, stageHandles, stage.stage_id)) yield item; })();
  for await (const item of rightSource) {
    const key = joinKey(item, predicate);
    const bucket = rightByKey.get(key);
    if (bucket) bucket.push(item); else rightByKey.set(key, [item]);
    rightItems.push(item);
  }
  const output = String(args["output"]);
  const source = async function* (): AsyncIterable<QueryStreamItem> {
    const seen = new Set<string>();
    const matchedRight = new Set<string>();
    const leftSource = leftHandle?.iterate?.() ?? (async function* (): AsyncIterable<QueryStreamItem> { for (const item of await collectStageOutput(stage.inputs[0]!, stageResults, stageHandles, stage.stage_id)) yield item; })();
    for await (const leftItem of leftSource) {
      const matches = rightByKey.get(joinKey(leftItem, predicate)) ?? [];
      if (output === "left" && matches.length > 0) {
        const key = subjectKey(leftItem); if (!seen.has(key)) { seen.add(key); yield leftItem; }
      }
      for (const rightItem of matches) {
        matchedRight.add(subjectKey(rightItem));
        if (output === "pairs" || (output !== "left" && output !== "right")) {
          const pair = { value: { left: leftItem.value, right: rightItem.value }, stable_sort_key: `${leftItem.stable_sort_key}\u0000${rightItem.stable_sort_key}` };
          const key = subjectKey(pair);
          if (!seen.has(key)) { seen.add(key); yield pair; }
        }
      }
    }
    if (output === "right") for (const rightItem of rightItems) {
      const key = subjectKey(rightItem);
      if (matchedRight.has(key) && !seen.has(key)) { seen.add(key); yield rightItem; }
    }
  };
  return { streams: { [output === "pairs" ? "pairs" : output === "left" ? "left" : output === "right" ? "right" : "grouped"]: [] }, stream_sources: { [output === "pairs" ? "pairs" : output === "left" ? "left" : output === "right" ? "right" : "grouped"]: source() } };
}

function inputHandlesFor(stage: QueryStage, stageHandles: ReadonlyMap<string, StageSetHandle>): ReadonlyMap<string, unknown> {
  const handles = new Map<string, unknown>();
  for (const input of stage.inputs) {
    const handle = stageHandles.get(`${input.stage_id}\u0000${input.output}`);
    if (handle !== undefined) handles.set(`${input.stage_id}.${input.output}`, handle);
  }
  for (const selector of collectStageOutputSelectors((stage.arguments as Record<string, unknown>)["operation_arguments"])) {
    const handle = stageHandles.get(`${selector.stage_id}\u0000${selector.output}`);
    if (handle !== undefined) handles.set(`${selector.stage_id}.${selector.output}`, handle);
  }
  return handles;
}

async function runSourceOrExpandStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  const rawArguments = stage.arguments as Record<string, unknown>;
  const handleBindings = inputHandlesFor(stage, stageHandles);
  const resolvedArguments = await resolveStageOutputInValue(rawArguments["operation_arguments"], stageResults, stageHandles, stage.stage_id, port.consumes_stage_handles === true && handleBindings.size > 0) as Record<string, unknown>;
  if (stage.operator === "expand.operation") {
    const inputArgumentField = String(rawArguments["input_argument"]);
    const upstreamReference = stage.inputs[0];
    const upstreamHandle = upstreamReference === undefined ? undefined : stageHandles.get(`${upstreamReference.stage_id}\u0000${upstreamReference.output}`);
    if (upstreamReference === undefined) resolvedArguments[inputArgumentField] = [];
    else resolvedArguments[inputArgumentField] = upstreamHandle === undefined || port.consumes_stage_handles !== true
      ? (await collectStageOutput(upstreamReference, stageResults, stageHandles, stage.stage_id)).map(toSubjectSelector)
      : [{ subject_type: "stage_output", stage_id: upstreamReference.stage_id, output: upstreamReference.output }];
  }
  return evaluateOperation({ operation_id: String(rawArguments["operation"]), ...(stage.operation_version === undefined ? {} : { operation_version: stage.operation_version }), arguments: resolvedArguments, scope, port, input_handles: handleBindings });
}

async function runExpandRelationsStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  const args = stage.arguments as Record<string, unknown>;
  const upstream = stage.inputs[0]!;
  const handle = stageHandles.get(`${upstream.stage_id}\u0000${upstream.output}`);
  const subjects = handle === undefined || port.consumes_stage_handles !== true ? (await collectStageOutput(upstream, stageResults, stageHandles, stage.stage_id)).map(toSubjectSelector) : [{ subject_type: "stage_output", stage_id: upstream.stage_id, output: upstream.output }];
  return evaluateOperation({ operation_id: "core:expand_relations", arguments: { ...args, subjects }, scope, port, input_handles: inputHandlesFor(stage, stageHandles) });
}

async function runSourceRegistryStage(stage: QueryStage, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  return evaluateOperation({ operation_id: "core:discover_definitions", arguments: stage.arguments, scope, port });
}

async function runStage(stage: QueryStage, stageResults: ReadonlyMap<string, OperationEvaluation>, stageHandles: ReadonlyMap<string, StageSetHandle>, scope: QueryScope, port: QueryDataPort): Promise<OperationEvaluation> {
  if (stage.operator === "source.operation" || stage.operator === "expand.operation") return runSourceOrExpandStage(stage, stageResults, stageHandles, scope, port);
  if (stage.operator === "source.registry") return runSourceRegistryStage(stage, scope, port);
  if (stage.operator === "expand.relations") return runExpandRelationsStage(stage, stageResults, stageHandles, scope, port);
  if (stage.operator === "set.union" || stage.operator === "set.intersection" || stage.operator === "set.difference") return runSetStage(stage, stageResults, stageHandles);
  if (stage.operator === "filter") return runFilterStage(stage, stageResults, stageHandles);
  if (stage.operator === "join") return runJoinStage(stage, stageResults, stageHandles, scope, port);
  if (stage.operator === "deduplicate") return runDeduplicateStage(stage, stageResults, stageHandles);
  if (stage.operator === "select") return runSelectStage(stage, stageResults, stageHandles);
  throw new EngineError("core:stage_reference_invalid", `Stage ${stage.stage_id} uses unsupported operator ${stage.operator}.`);
}

/**
 * Executes a validated pipeline dependency graph in ready frontiers. Each
 * frontier completes before its outputs become visible, every output is
 * sealed as a bounded {@link StageSetHandle}, and downstream stages consume
 * those handles instead of retaining duplicate arrays. Independent stages may
 * run concurrently; declared output order and completeness remain stable.
 */
export async function executePipeline(input: ExecutePipelineInput): Promise<OperationEvaluation> {
  const stageResults = new Map<string, OperationEvaluation>();
  const stageHandles = new Map<string, StageSetHandle>();
  const spool = input.spool ?? new MemoryStageSpool(input.resource_budget?.max_intermediate_bytes === undefined ? undefined : { hard_bytes: input.resource_budget.max_intermediate_bytes });
  const maxRows = input.resource_budget?.max_intermediate_rows;
  const pending = [...input.stages];
  // Stages in a dependency chain remain strictly ordered, while independent
  // branches are evaluated concurrently.  The results map is only updated
  // after a ready frontier completes, so no stage can observe a partially
  // produced upstream set and the final ordering remains declaration-stable.
  while (pending.length > 0) {
    if (input.abort_signal?.aborted) {
      await spool.cleanup(input.execution_id ?? "execution:ephemeral");
      throw new EngineErrorWithDetails("core:operation_cancelled", "Pipeline execution was cancelled.", { execution_id: input.execution_id ?? "execution:ephemeral", stage_id: pending[0]?.stage_id ?? "", frontier: "query", retryability: "retryable" });
    }
    const ready = pending.filter((stage) => {
      const dependencies = new Set(stage.inputs.map((inputValue) => inputValue.stage_id));
      if (stage.operator === "source.operation" || stage.operator === "expand.operation") {
        for (const selector of collectStageOutputSelectors((stage.arguments as Record<string, unknown>)["operation_arguments"])) dependencies.add(selector.stage_id);
      }
      return [...dependencies].every((dependency) => stageResults.has(dependency));
    });
    if (ready.length === 0) {
      await spool.cleanup(input.execution_id ?? "execution:ephemeral");
      throw new EngineError("core:stage_reference_invalid", "Pipeline dependency graph contains a cycle or unresolved stage binding.");
    }
    const evaluated = await Promise.all(ready.map(async (stage) => {
      try {
        const evaluation = await runStage(stage, stageResults, stageHandles, input.scope, input.port);
        const rows = Object.values(evaluation.streams).reduce((total, values) => total + values.length, 0);
        if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0 || rows > maxRows)) {
          throw new EngineErrorWithDetails("core:execution_resource_limit", `Pipeline stage ${stage.stage_id} exceeded the intermediate row budget.`, { execution_id: input.execution_id ?? "execution:ephemeral", stage_id: stage.stage_id, operation: stage.operator, limit_kind: "intermediate_rows", configured_limit: maxRows, observed_or_required: rows, retryability: "not_retryable_without_budget" });
        }
        return evaluation;
      } catch (error) {
        await spool.cleanup(input.execution_id ?? "execution:ephemeral");
        if (error instanceof EngineErrorWithDetails && error.details["execution_id"] !== undefined) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new EngineErrorWithDetails("core:stage_execution_failed", `Pipeline stage ${stage.stage_id} failed: ${message}`, { execution_id: input.execution_id ?? "execution:ephemeral", stage_id: stage.stage_id, operation: stage.operator, frontier: "query", retryability: "unknown" });
      }
    }));
    for (const [index, stage] of ready.entries()) {
      const evaluation = evaluated[index]!;
      const outputNames = new Set([...Object.keys(evaluation.streams), ...Object.keys(evaluation.stream_sources ?? {})]);
      let sealedRows = 0;
      for (const output of outputNames) {
        const values = evaluation.streams[output] ?? [];
        const source = evaluation.stream_sources?.[output] ?? (async function* (): AsyncIterable<QueryStreamItem> { for (const value of asItems(values)) yield value; })();
        let handle: StageSetHandle;
        try {
          handle = await spool.putIterable(input.execution_id ?? "execution:ephemeral", stage.stage_id, output, source);
        } catch (error) {
          await spool.cleanup(input.execution_id ?? "execution:ephemeral");
          throw new EngineErrorWithDetails("core:execution_resource_limit", `Pipeline stage ${stage.stage_id} could not be sealed in the execution spool.`, { execution_id: input.execution_id ?? "execution:ephemeral", stage_id: stage.stage_id, operation: stage.operator, frontier: "query", retryability: "not_retryable_without_budget", cause: error instanceof Error ? error.message : String(error) });
        }
        sealedRows += handle.row_count;
        stageHandles.set(`${stage.stage_id}\u0000${output}`, handle);
      }
      if (maxRows !== undefined && sealedRows > maxRows) {
        await spool.cleanup(input.execution_id ?? "execution:ephemeral");
        throw new EngineErrorWithDetails("core:execution_resource_limit", `Pipeline stage ${stage.stage_id} exceeded the intermediate row budget.`, { execution_id: input.execution_id ?? "execution:ephemeral", stage_id: stage.stage_id, operation: stage.operator, limit_kind: "intermediate_rows", configured_limit: maxRows, observed_or_required: sealedRows, retryability: "not_retryable_without_budget" });
      }
      // Downstream stages read sealed handles. Drop the just-consumed arrays so
      // a long dependent chain retains only compact metadata and its SQLite
      // spool, while preserving completeness and diagnostics for the final
      // response.
      const { stream_sources: _streamSources, ...sealedEvaluation } = evaluation;
      stageResults.set(stage.stage_id, { ...sealedEvaluation, streams: Object.fromEntries([...outputNames].map((output) => [output, []])) });
    }
    for (const stage of ready) pending.splice(pending.indexOf(stage), 1);
  }
  const outputStreams: Record<string, readonly QueryStreamItem[]> = {};
  const outputSources: Record<string, AsyncIterable<QueryStreamItem>> = {};
  const reverseOutputSources: Record<string, AsyncIterable<QueryStreamItem>> = {};
  for (const output of input.outputs) {
    const handle = stageHandles.get(`${output.stage_id}\u0000${output.output}`) ?? stageHandles.get(`${output.stage_id}\u0000subjects`);
    const name = output.name ?? output.output;
    if (handle?.iterate !== undefined) {
      if (input.stream_final === true) {
        outputSources[name] = handle.iterate();
        reverseOutputSources[name] = handle.iterate_reverse?.() ?? (async function* (): AsyncIterable<QueryStreamItem> {
          const values: QueryStreamItem[] = [];
          for await (const value of handle.iterate!()) values.push(value);
          for (let index = values.length - 1; index >= 0; index -= 1) yield values[index]!;
        })();
      } else {
        const values: QueryStreamItem[] = [];
        for await (const value of handle.iterate()) values.push(value);
        outputStreams[name] = values;
      }
    } else outputStreams[name] = [];
  }
  const evaluations = [...stageResults.values()];
  // A pipeline cannot infer completeness merely because an adapter omitted a
  // report. Missing stage coverage is therefore unknown, never silently
  // complete; registered providers must explicitly claim complete coverage.
  const statuses = evaluations.map((evaluation) => String((evaluation.completeness as { overall_status?: string } | undefined)?.overall_status ?? "unknown"));
  const overall_status = statuses.includes("unknown") ? "unknown" : statuses.includes("stale") ? "stale" : statuses.includes("unsupported") ? "unsupported" : statuses.includes("partial") ? "partial" : "complete";
  const dimensions = evaluations.flatMap((evaluation) => (evaluation.completeness as { dimensions?: readonly unknown[] } | undefined)?.dimensions ?? []);
  return { streams: outputStreams, stream_sources: outputSources, reverse_stream_sources: reverseOutputSources, completeness: { overall_status, dimensions }, stage_handles: stageHandles } as OperationEvaluation & { readonly stage_handles: ReadonlyMap<string, StageSetHandle> };
}
