import type { QueryScope } from "@urdira/contracts";
import type { CanonicalQueryRecord, CanonicalQuerySnapshotPort } from "./canonical-query-data-port.js";
import { recordValue } from "./query-record-projections.js";
import type { QueryStreamItem } from "./query-operators.js";
import { sourceSnippet } from "./source-snippet.js";

/**
 * Shapes the `core:get_source` stream after subject resolution. Keeping
 * option parsing and the shared character budget here leaves the query port
 * responsible only for choosing the exact subject set and serving snapshots.
 */
export async function buildGetSourceStreams(snapshots: CanonicalQuerySnapshotPort, scope: QueryScope, subjects: readonly CanonicalQueryRecord[], args: Readonly<Record<string, unknown>>, deferSource = false): Promise<Readonly<Record<string, readonly QueryStreamItem[]>>> {
  const sourceOptions = asObject(args["source"]);
  const mode = sourceMode(sourceOptions["mode"]);
  const maxCharactersPerSnippet = numberOption(sourceOptions["max_characters_per_snippet"], 4000);
  const maxTotalCharacters = numberOption(sourceOptions["max_total_characters"], 16000);
  const contextLines = numberOption(sourceOptions["context_lines"], 0);
  let remainingBudget = maxTotalCharacters;
  const sources: QueryStreamItem[] = [];
  for (const record of subjects) {
    const snippet = mode === "none" || deferSource ? undefined : await sourceSnippet(snapshots, scope, record, mode, maxCharactersPerSnippet, contextLines, remainingBudget);
    if (snippet !== undefined) remainingBudget -= snippet.text.length;
    sources.push({
      value: { result_set: "sources", primary_result: recordValue(record), assessment: { classification: "confirmed", completeness: "complete" }, provenance_path: [], essential_related_entities: [], optional_source_snippets: snippet === undefined ? [] : [snippet] },
      ...(deferSource && mode !== "none" ? { source_hydration: { scope, record, options: { mode, max_characters_per_snippet: maxCharactersPerSnippet, max_total_characters: maxTotalCharacters, context_lines: contextLines } } } : {}),
      stable_sort_key: `confirmed\0${record.identity_key ?? record.record_id}`,
    });
  }
  return { sources };
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function sourceMode(value: unknown): "none" | "signature" | "relevant" | "body" {
  return value === "none" || value === "signature" || value === "relevant" || value === "body" ? value : "body";
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
