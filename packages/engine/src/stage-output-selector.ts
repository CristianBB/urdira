/**
 * Shape helpers for the `stage_output` `SubjectSelector` variant
 * (`{subject_type: "stage_output", stage_id, output}`,
 * `docs/protocol/public-query-contract.md` ~:25: "The complete typed
 * subject set produced by an earlier pipeline stage... legal only in
 * pipeline arguments"). Shared by `query-plan.ts` (which needs to know,
 * ahead of execution, which EARLIER stage a `source.operation`/
 * `expand.operation` stage's `operation_arguments` reference -- so its
 * reachability graph doesn't reject a stage that is wired ONLY through an
 * embedded `stage_output` selector rather than through `stage.inputs`) and
 * `pipeline-executor.ts` (which resolves each reference against the
 * REFERENCED stage's already-computed output stream at execution time).
 * `packages/contracts/src/schema-ir.ts` has its own, independent copy of
 * this same shape check (`validateStageOutputCrossReferences`) -- the
 * contracts package cannot depend on the engine package, so it is
 * duplicated there rather than imported; keep the two in sync if the
 * `stage_output` selector shape ever changes.
 */

export interface StageOutputReference {
  readonly stage_id: string;
  readonly output: string;
}

export function isStageOutputSelector(value: unknown): value is { readonly subject_type: "stage_output" } & StageOutputReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return object["subject_type"] === "stage_output" && typeof object["stage_id"] === "string" && typeof object["output"] === "string";
}

/** Deep-walks `value` (an arbitrary JSON-shaped operation-argument tree) collecting every embedded `stage_output` selector it finds, at any depth and inside arrays. */
export function collectStageOutputSelectors(value: unknown, into: StageOutputReference[] = []): StageOutputReference[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectStageOutputSelectors(entry, into);
    return into;
  }
  if (value === null || typeof value !== "object") return into;
  if (isStageOutputSelector(value)) {
    into.push({ stage_id: value.stage_id, output: value.output });
    return into;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) collectStageOutputSelectors(entry, into);
  return into;
}
