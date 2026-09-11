import { operationRegistry, type OperationDefinition, type QueryScope } from "@urdira/contracts";
import { EngineError } from "./errors.js";
import type { StageSetHandle } from "./stage-set-handle.js";

export interface QueryStreamItem {
  readonly value: unknown;
  readonly stable_sort_key: string;
  readonly result_classification?: "confirmed" | "possible" | "unclassified";
  readonly provenance_path?: readonly unknown[];
  readonly evidence_record_ids?: readonly string[];
}

export interface OperationEvaluation {
  readonly streams: Readonly<Record<string, ReadonlyArray<QueryStreamItem | unknown>>>;
  /** Optional bounded execution metadata supplied by a query data port. It is
   * consumed only by internal telemetry and never crosses the query/MCP page. */
  readonly telemetry?: QueryOperationEvaluationTelemetry;
  /** Internal lazy streams. These never cross the MCP boundary; the pipeline
   * executor seals them into its execution-local spool before another stage
   * can consume them. `streams` remains populated for legacy ports and final
   * response adapters. */
  readonly stream_sources?: Readonly<Record<string, AsyncIterable<QueryStreamItem>>>;
  /** Reverse iterators for final manifests. Internal only; never crosses MCP. */
  readonly reverse_stream_sources?: Readonly<Record<string, AsyncIterable<QueryStreamItem>>>;
  readonly completeness?: unknown;
  readonly diagnostics?: ReadonlyArray<unknown>;
  readonly semantic_state?: "ready" | "updating" | "partial" | "failed" | "unsupported";
  readonly stage_handles?: ReadonlyMap<string, unknown>;
}

export interface QueryOperationEvaluationTelemetry {
  readonly route?: string;
  readonly index_used?: string;
  readonly candidates?: number;
  readonly rows_hydrated?: number;
  readonly decline_reason?: string;
  readonly fallback_reason?: string;
}

export interface OperationInvocation {
  readonly operation_id: string;
  readonly operation_version?: number;
  readonly result_streams: readonly string[];
  readonly arguments: unknown;
  readonly scope: QueryScope;
  readonly snapshot_bindings?: readonly unknown[];
  /** Execution-local relational inputs. Providers may stream these handles
   * directly instead of receiving expanded selector arrays. */
  readonly input_handles?: ReadonlyMap<string, unknown>;
}

export interface QueryDataPort {
  /** When true, the adapter understands stage_output tokens paired with
   * `input_handles` and can resolve them without executor-side arrays. */
  readonly consumes_stage_handles?: boolean;
  readonly execute: (operation: OperationInvocation) => Promise<OperationEvaluation>;
  /** Optional indexed relation predicate used by the v3 join operator. */
  readonly relation_exists?: (scope: QueryScope, left: QueryStreamItem, right: QueryStreamItem, relationSelector: unknown, direction: "inbound" | "outbound" | "both") => Promise<boolean>;
  /** Batch relation join over a complete left/right frontier. */
  readonly relation_pairs?: (scope: QueryScope, left: readonly QueryStreamItem[], right: readonly QueryStreamItem[], relationSelector: unknown, direction: "inbound" | "outbound" | "both") => Promise<ReadonlySet<string>>;
  /** Handle-native batch relation join. Implementations can consume the
   * execution-local spool directly and avoid hydrating either frontier into
   * JavaScript arrays. The array method remains as a compatibility fallback
   * for older adapters. */
  readonly relation_pairs_handles?: (scope: QueryScope, left: StageSetHandle, right: StageSetHandle, relationSelector: unknown, direction: "inbound" | "outbound" | "both") => Promise<ReadonlySet<string>>;
}

export interface EvaluateOperationInput {
  readonly operation_id: string;
  readonly operation_version?: number;
  readonly arguments: unknown;
  readonly scope: QueryScope;
  readonly snapshot_bindings?: readonly unknown[];
  readonly input_handles?: ReadonlyMap<string, unknown>;
  readonly port: QueryDataPort;
}

export async function evaluateOperation(input: EvaluateOperationInput): Promise<OperationEvaluation> {
  const operation = operationRegistry.find((candidate) => candidate.operation_id === input.operation_id && (input.operation_version === undefined || candidate.operation_version === input.operation_version));
  if (!operation) throw new EngineError(input.operation_version === undefined ? "core:operation_unknown" : "core:api_version_unsupported", `Operation ${input.operation_id}@${input.operation_version ?? "?"} is not registered.`);
  const evaluation = await input.port.execute({ operation_id: operation.operation_id, operation_version: operation.operation_version, result_streams: operation.result_streams, arguments: input.arguments, scope: input.scope, ...(input.snapshot_bindings === undefined ? {} : { snapshot_bindings: input.snapshot_bindings }), ...(input.input_handles === undefined ? {} : { input_handles: input.input_handles }) });
  const streams = Object.fromEntries(operation.result_streams.map((stream) => [stream, evaluation.streams[stream] ?? []]));
  return { ...evaluation, streams };
}

export interface RelationEdge {
  readonly source: string;
  readonly target: string;
  readonly relation_kind: string;
  readonly classification: "confirmed" | "possible" | "unclassified";
  readonly stable_sort_key?: string;
}

export interface ExpandedRelation {
  readonly subject: string;
  readonly depth: number;
  readonly relation_kind: string;
  readonly classification: RelationEdge["classification"];
  readonly stable_sort_key: string;
}

export interface RelationExpansionOptions {
  readonly direction: "inbound" | "outbound" | "both";
  readonly min_depth?: number;
  readonly max_depth?: number;
  readonly relation_kinds?: readonly string[];
}

function adjacency(edges: readonly RelationEdge[], direction: RelationExpansionOptions["direction"], relationKinds: ReadonlySet<string>): ReadonlyMap<string, readonly RelationEdge[]> {
  const bySubject = new Map<string, RelationEdge[]>();
  const add = (subject: string, edge: RelationEdge): void => {
    const current = bySubject.get(subject);
    if (current === undefined) bySubject.set(subject, [edge]);
    else current.push(edge);
  };
  for (const edge of edges) {
    if (relationKinds.size > 0 && !relationKinds.has(edge.relation_kind)) continue;
    if (direction === "outbound" || direction === "both") add(edge.source, edge);
    if ((direction === "inbound" || direction === "both") && edge.target !== edge.source) add(edge.target, { ...edge, source: edge.target, target: edge.source });
  }
  return bySubject;
}

export function expandRelations(edges: readonly RelationEdge[], roots: readonly string[], options: RelationExpansionOptions): readonly ExpandedRelation[] {
  const minDepth = options.min_depth ?? 1;
  const maxDepth = options.max_depth ?? minDepth;
  if (!Number.isSafeInteger(minDepth) || minDepth < 0 || !Number.isSafeInteger(maxDepth) || maxDepth < minDepth) throw new EngineError("core:budget_invalid", "Relation depth bounds are invalid.");
  const relationKinds = new Set(options.relation_kinds ?? []);
  const bySubject = adjacency(edges, options.direction, relationKinds);
  const queue = roots.map((subject) => ({ subject, depth: 0 }));
  let queueIndex = 0;
  const seen = new Set(roots);
  const result: ExpandedRelation[] = [];
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!;
    if (current.depth >= maxDepth) continue;
    for (const edge of bySubject.get(current.subject) ?? []) {
      const depth = current.depth + 1;
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push({ subject: edge.target, depth });
      if (depth >= minDepth) result.push({ subject: edge.target, depth, relation_kind: edge.relation_kind, classification: edge.classification, stable_sort_key: edge.stable_sort_key ?? `${depth}\u0000${edge.target}\u0000${edge.relation_kind}` });
    }
  }
  return result;
}

export interface ShortestPath {
  readonly subjects: readonly string[];
  readonly relation_kinds: readonly string[];
  readonly classification: RelationEdge["classification"];
  readonly stable_sort_key: string;
}

export interface ShortestPathOptions { readonly direction: "inbound" | "outbound" | "both"; readonly max_depth: number; readonly all_shortest?: boolean; readonly relation_kinds?: readonly string[]; }

export function findShortestPaths(edges: readonly RelationEdge[], sources: readonly string[], targets: readonly string[], options: ShortestPathOptions): readonly ShortestPath[] {
  if (!Number.isSafeInteger(options.max_depth) || options.max_depth < 0) throw new EngineError("core:budget_invalid", "Maximum path depth must be a non-negative safe integer.");
  const targetSet = new Set(targets);
  const relationKinds = new Set(options.relation_kinds ?? []);
  const bySubject = adjacency(edges, options.direction, relationKinds);
  const queue = sources.map((subject) => ({ subjects: [subject], relations: [] as string[], classifications: [] as RelationEdge["classification"][] }));
  let queueIndex = 0;
  const results: ShortestPath[] = [];
  let shortest: number | undefined;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!;
    const depth = current.subjects.length - 1;
    if (shortest !== undefined && depth > shortest) continue;
    const subject = current.subjects[current.subjects.length - 1]!;
    if (depth > 0 && targetSet.has(subject)) {
      shortest = depth;
      const classification = current.classifications.includes("possible") ? "possible" : current.classifications.includes("unclassified") ? "unclassified" : "confirmed";
      results.push({ subjects: current.subjects, relation_kinds: current.relations, classification, stable_sort_key: current.subjects.join("\u0000") });
      if (!options.all_shortest) break;
      continue;
    }
    if (depth >= options.max_depth) continue;
    for (const edge of bySubject.get(subject) ?? []) {
      if (current.subjects.includes(edge.target)) continue;
      queue.push({ subjects: [...current.subjects, edge.target], relations: [...current.relations, edge.relation_kind], classifications: [...current.classifications, edge.classification] });
    }
  }
  return results.sort((left, right) => left.stable_sort_key.localeCompare(right.stable_sort_key));
}
