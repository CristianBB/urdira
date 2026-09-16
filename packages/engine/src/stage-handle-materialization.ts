import { EngineErrorWithDetails } from "./errors.js";
import { toSubjectSelector } from "./recipe-executor.js";
import type { StageSetHandle } from "./stage-set-handle.js";

/**
 * Expands execution-local stage handles only at the legacy operation boundary.
 * SQL-aware adapters may keep handles opaque; this compatibility helper keeps
 * the recursive materialisation rules in one place and preserves cardinality
 * errors for scalar bindings.
 */
export async function materializeHandleBindings(value: unknown, handles: ReadonlyMap<string, unknown> | undefined): Promise<unknown> {
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const entry of value) {
      if (isStageOutputToken(entry)) {
        const handle = handles?.get(`${entry.stage_id}.${entry.output}`) as StageSetHandle | undefined;
        if (handle?.iterate === undefined) { output.push(entry); continue; }
        for await (const item of handle.iterate()) output.push(toSubjectSelector(item));
      } else output.push(await materializeHandleBindings(entry, handles));
    }
    return output;
  }
  if (isStageOutputToken(value)) {
    const handle = handles?.get(`${value.stage_id}.${value.output}`) as StageSetHandle | undefined;
    if (handle?.iterate === undefined) return value;
    if (handle.row_count !== 1) throw new EngineErrorWithDetails("core:stage_type_mismatch", "A scalar stage binding must resolve to exactly one row.", { referenced_stage_id: value.stage_id, referenced_output: value.output, actual_count: handle.row_count, cardinality: "one" });
    for await (const item of handle.iterate()) return toSubjectSelector(item);
    return value;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) output[key] = await materializeHandleBindings(entry, handles);
    return output;
  }
  return value;
}

function isStageOutputToken(value: unknown): value is { readonly subject_type: "stage_output"; readonly stage_id: string; readonly output: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>)["subject_type"] === "stage_output"
    && typeof (value as Record<string, unknown>)["stage_id"] === "string"
    && typeof (value as Record<string, unknown>)["output"] === "string";
}
