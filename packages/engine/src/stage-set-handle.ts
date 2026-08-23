import { LogicalDigestWriter, MerkleRadixSet, digestLogicalValue } from "@urdira/canonical";
import type { QueryStreamItem } from "./query-operators.js";

/**
 * Execution-local identity for an intermediate pipeline set.  The handle is
 * deliberately metadata-first: stages exchange the execution/stage/output
 * coordinates and cardinality/root, while hydration remains at the final
 * response boundary.  The optional iterator is supplied by an in-memory or
 * SQLite spool adapter and is never part of the public wire contract.
 */
export interface StageSetHandle {
  readonly execution_id: string;
  readonly stage_id: string;
  readonly output: string;
  readonly logical_type: "subjects" | "relations" | "paths" | "definitions" | "records" | "sources" | "unknown";
  readonly row_count: number;
  readonly root: string;
  readonly order: "declared" | "stable_sort_key";
  readonly iterate?: () => AsyncIterable<QueryStreamItem>;
  /** Reverse traversal used to seal the immutable backward manifest without
   * first copying the complete final stream into JavaScript. */
  readonly iterate_reverse?: () => AsyncIterable<QueryStreamItem>;
}

/** Construct a handle once a spool has consumed a stream.  The root is
 * supplied by the spool's incremental accumulator, so sealing does not need
 * to retain the complete set merely to calculate a digest. */
export function stageSetHandleMetadata(executionId: string, stageId: string, output: string, rowCount: number, root: string, order: StageSetHandle["order"], iterate: () => AsyncIterable<QueryStreamItem>, iterateReverse?: () => AsyncIterable<QueryStreamItem>): StageSetHandle {
  return {
    execution_id: executionId,
    stage_id: stageId,
    output,
    logical_type: ["subjects", "relations", "paths", "definitions", "records", "sources"].includes(output) ? output as StageSetHandle["logical_type"] : "unknown",
    row_count: rowCount,
    root,
    order,
    iterate,
    ...(iterateReverse === undefined ? {} : { iterate_reverse: iterateReverse }),
  };
}

/** Incremental, order-independent root used while a stream is being sealed.
 * Stable order is still retained by the spool for cursor manifests; the
 * Merkle root is the compact logical identity used between stages. */
export function stageSetRoot(values: Iterable<QueryStreamItem>): { readonly root: string; readonly row_count: number } {
  const tree = new MerkleRadixSet();
  let rowCount = 0;
  for (const value of values) {
    const logical = digestLogicalValue({ stable_sort_key: value.stable_sort_key, value: value.value }, "urdira:pipeline-stage-member:v3");
    tree.set(digestLogicalValue(value.stable_sort_key, "urdira:pipeline-stage-key:v3"), logical);
    rowCount += 1;
  }
  return { root: tree.root(), row_count: rowCount };
}

export function stageSetHandle(executionId: string, stageId: string, output: string, values: readonly QueryStreamItem[], order: StageSetHandle["order"] = "declared"): StageSetHandle {
  const writer = new LogicalDigestWriter("urdira:pipeline-stage-set:v3").sequence(values.length);
  for (const value of values) {
    writer.field("stable_sort_key", true, () => writer.text(0, value.stable_sort_key));
    writer.field("value", true, () => writer.value(value.value));
  }
  return {
    execution_id: executionId,
    stage_id: stageId,
    output,
    logical_type: ["subjects", "relations", "paths", "definitions", "records", "sources"].includes(output) ? output as StageSetHandle["logical_type"] : "unknown",
    row_count: values.length,
    root: writer.digest(),
    order,
    iterate: async function* (): AsyncIterable<QueryStreamItem> { for (const value of values) yield value; },
    iterate_reverse: async function* (): AsyncIterable<QueryStreamItem> { for (let index = values.length - 1; index >= 0; index -= 1) yield values[index]!; },
  };
}
