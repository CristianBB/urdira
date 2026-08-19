import { describe, expect, it } from "vitest";
import { evaluateOperation, expandRelations, findShortestPaths, type OperationEvaluation, type QueryDataPort } from "../packages/engine/src/index.js";
import { operationRegistry } from "@urdira/contracts";

describe("Phase 11 query operators", () => {
  it("dispatches every registered operation through the read-only data port", async () => {
    const seen: string[] = [];
    const port: QueryDataPort = {
      async execute(operation) {
        seen.push(operation.operation_id);
        return { streams: Object.fromEntries(operation.result_streams.map((stream) => [stream, []])) };
      },
    };
    for (const operation of operationRegistry) {
      await evaluateOperation({ operation_id: operation.operation_id, arguments: {}, scope: { scope_type: "single_workspace", workspace_id: "w" }, port });
    }
    expect(seen).toEqual(operationRegistry.map((operation) => operation.operation_id));
  });

  it("expands graph relations with bounded depth and direction", () => {
    const edges = [
      { source: "a", target: "b", relation_kind: "calls", classification: "confirmed" as const },
      { source: "b", target: "c", relation_kind: "calls", classification: "confirmed" as const },
      { source: "c", target: "a", relation_kind: "calls", classification: "confirmed" as const },
    ];
    expect(expandRelations(edges, ["a"], { direction: "outbound", min_depth: 1, max_depth: 2 }).map((item) => item.subject)).toEqual(["b", "c"]);
    expect(expandRelations(edges, ["b"], { direction: "inbound", min_depth: 1, max_depth: 1 }).map((item) => item.subject)).toEqual(["a"]);
  });

  it("returns all shortest paths without non-shortest reranking", () => {
    const edges = [
      { source: "a", target: "b", relation_kind: "calls", classification: "confirmed" as const },
      { source: "b", target: "d", relation_kind: "calls", classification: "confirmed" as const },
      { source: "a", target: "c", relation_kind: "calls", classification: "confirmed" as const },
      { source: "c", target: "d", relation_kind: "calls", classification: "confirmed" as const },
    ];
    expect(findShortestPaths(edges, ["a"], ["d"], { direction: "outbound", max_depth: 3, all_shortest: true }).map((path) => path.subjects)).toEqual([["a", "b", "d"], ["a", "c", "d"]]);
  });
});
