import { computeDigest } from "@urdira/canonical";
import { operationRegistry, recipeRegistry, type QueryRequest, type QueryScope } from "@urdira/contracts";
import type { WorkspaceLifecycleRepository } from "@urdira/storage";
import { CursorCache, type CursorDirection, type ManifestStreamReader, type ReadPageResult } from "./cursor-cache.js";
import { EngineError } from "./errors.js";
import { evaluateOperation, type OperationEvaluation, type QueryDataPort, type QueryStreamItem } from "./query-operators.js";
import { executePipeline } from "./pipeline-executor.js";
import { normalizeQueryRequest, type NormalizedQueryPlan } from "./query-plan.js";
import { executeRecipe } from "./recipe-executor.js";

export interface QueryExecutionOptions {
  readonly data_port: QueryDataPort;
  readonly cursor_cache: CursorCache;
  readonly manifest_store?: QueryManifestStore;
  readonly now?: () => string;
  readonly execution_id_factory?: (plan: NormalizedQueryPlan) => string;
}

export interface QueryContinuationRequest {
  readonly cursor: string;
  readonly response_budget: { readonly max_items: number; readonly max_characters: number };
}

export interface QueryManifestStore {
  readonly append: (execution_id: string, result_stream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>) => Promise<void>;
  readonly reader: ManifestStreamReader<QueryStreamItem>;
}

export interface QueryStreamPage {
  readonly items: ReadonlyArray<QueryStreamItem>;
  readonly next_cursor?: string;
  readonly previous_cursor?: string;
  readonly has_next: boolean;
  readonly has_previous: boolean;
}

export interface QueryExecutionPage {
  readonly query_execution_id: string;
  readonly plan_digest: string;
  readonly streams: Readonly<Record<string, QueryStreamPage>>;
  readonly completeness: { readonly overall_status: "complete" | "partial" | "unknown" | "unsupported" | "stale"; readonly dimensions: readonly unknown[] };
  readonly diagnostics: ReadonlyArray<unknown>;
  readonly registry: { readonly mode: "none" | "used" | "full"; readonly operation_ids: readonly string[]; readonly recipe_ids: readonly string[] };
  readonly semantic_state?: "ready" | "updating" | "partial" | "failed" | "unsupported";
  readonly expires_at: string;
}

class MemoryManifestStore implements QueryManifestStore {
  private readonly values = new Map<string, QueryStreamItem[]>();
  async append(executionId: string, resultStream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>): Promise<void> {
    const key = `${executionId}\u0000${resultStream}\u0000${direction}`;
    if (this.values.has(key)) return;
    this.values.set(key, [...items]);
  }
  readonly reader: ManifestStreamReader<QueryStreamItem> = {
    read: async (request) => {
      const values = this.values.get(`${request.execution_id}\u0000${request.result_stream}\u0000${request.direction}`) ?? [];
      const start = request.position === undefined ? 0 : Math.max(0, values.findIndex((item) => item.stable_sort_key === request.position) + 1);
      const items = values.slice(start, start + request.limit);
      return { items, has_more: start + items.length < values.length };
    },
  };
}

/** Durable manifest adapter. Forward and backward streams are separate immutable segments. */
export class DurableManifestStore implements QueryManifestStore {
  constructor(private readonly lifecycle: WorkspaceLifecycleRepository) {}
  async append(executionId: string, resultStream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>): Promise<void> {
    const segmentId = `${resultStream}\u0000${direction}`;
    await this.lifecycle.appendManifestSegment(executionId, segmentId, items.map((value, ordinal) => ({ ...value, stable_sort_key: String(ordinal), ordinal })));
  }
  readonly reader: ManifestStreamReader<QueryStreamItem> = {
    read: async (request) => {
      const start = request.position === undefined ? 0 : Number(request.position);
      const rows = await this.lifecycle.hydrateManifestSegment<QueryStreamItem & { ordinal: number }>(request.execution_id, `${request.result_stream}\u0000${request.direction}`, Number.isSafeInteger(start) && start >= 0 ? start + (request.position === undefined ? 0 : 1) : 0, request.limit + 1);
      return { items: rows.slice(0, request.limit), has_more: rows.length > request.limit };
    },
  };
}

function item(value: unknown, index: number): QueryStreamItem {
  if (value && typeof value === "object" && "stable_sort_key" in value && typeof (value as { stable_sort_key?: unknown }).stable_sort_key === "string") return value as QueryStreamItem;
  return { value, stable_sort_key: `${index.toString().padStart(12, "0")}` };
}

function scopeDigest(scope: QueryScope): string {
  return computeDigest("core:query_scope", "core:query_scope_digest", 1, "core:QueryScope", 1, scope);
}

function streamItems(evaluation: OperationEvaluation): Readonly<Record<string, readonly QueryStreamItem[]>> {
  return Object.fromEntries(Object.entries(evaluation.streams).map(([stream, values]) => [stream, values.map(item)]));
}

export class QueryEngine {
  private readonly dataPort: QueryDataPort;
  private readonly cursorCache: CursorCache;
  private readonly manifestStore: QueryManifestStore;
  private readonly now: () => string;
  private readonly idFactory: (plan: NormalizedQueryPlan) => string;
  private sequence = 0;

  constructor(options: QueryExecutionOptions) {
    this.dataPort = options.data_port;
    this.cursorCache = options.cursor_cache;
    this.manifestStore = options.manifest_store ?? new MemoryManifestStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.execution_id_factory ?? ((plan) => `query-${plan.plan_digest.slice(-16)}-${this.sequence++}`);
  }

  async execute(request: QueryRequest): Promise<QueryExecutionPage> {
    const plan = normalizeQueryRequest(request);
    const executionId = this.idFactory(plan);
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
    const evaluation = await this.evaluate(plan, request.scope);
    if (request.options.coverage_requirement === "require_complete" && (evaluation.completeness as { overall_status?: string } | undefined)?.overall_status !== "complete") throw new EngineError("core:coverage_incomplete", "Complete coverage was required by the request.");
    const streams = streamItems(evaluation);
    const pages: Record<string, QueryStreamPage> = {};
    for (const [stream, values] of Object.entries(streams)) {
      await this.manifestStore.append(executionId, stream, "forward", values);
      await this.manifestStore.append(executionId, stream, "backward", [...values].reverse());
      const page = await this.cursorCache.readPage({ execution_id: executionId, result_stream: stream, direction: "forward", projection_digest: plan.plan_digest, ordering_digest: plan.plan_digest, scope_digest: scopeDigest(request.scope), response_budget_ceiling_digest: computeDigest("core:query_budget", "core:query_budget_digest", 1, "core:ResponseBudget", 1, request.options.response_budget), frozen_snapshot_digest: scopeDigest(request.scope), frozen_status_digest: evaluation.semantic_state ?? "ready", expires_at: expiresAt, now, limit: request.options.response_budget.max_items, reader: this.manifestStore.reader });
      pages[stream] = page;
    }
    return { query_execution_id: executionId, plan_digest: plan.plan_digest, streams: pages, completeness: (evaluation.completeness as QueryExecutionPage["completeness"]) ?? { overall_status: "complete", dimensions: [] }, diagnostics: request.options.diagnostics.diagnostics === "none" ? [] : evaluation.diagnostics ?? [], registry: { mode: request.options.registry.registry, operation_ids: request.options.registry.registry === "none" ? [] : [...plan.operation_versions].map((binding) => binding.operation_id), recipe_ids: request.options.registry.registry === "none" ? [] : [...plan.recipe_versions].map((binding) => binding.recipe_id) }, ...(evaluation.semantic_state === undefined ? {} : { semantic_state: evaluation.semantic_state }), expires_at: expiresAt };
  }

  async continue(request: QueryContinuationRequest): Promise<QueryExecutionPage> {
    const claims = this.cursorCache.decode(request.cursor);
    const page = await this.cursorCache.readPage({ cursor: request.cursor, limit: request.response_budget.max_items, reader: this.manifestStore.reader, now: this.now() });
    return { query_execution_id: claims.execution_id, plan_digest: claims.projection_digest, streams: { [claims.result_stream]: page }, completeness: { overall_status: "complete", dimensions: [] }, diagnostics: [], registry: { mode: "none", operation_ids: [], recipe_ids: [] }, expires_at: claims.expires_at };
  }

  private async evaluate(plan: NormalizedQueryPlan, scope: QueryScope): Promise<OperationEvaluation> {
    const expression = plan.normalized_expression as unknown as QueryRequest["expression"];
    if (expression.expression_type === "operation") return evaluateOperation({ operation_id: expression.operation, arguments: expression.arguments, scope, port: this.dataPort });
    if (expression.expression_type === "recipe") {
      const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === expression.recipe_id)!;
      return executeRecipe({ recipe, recipeArguments: expression.arguments as unknown as Readonly<Record<string, unknown>>, scope, port: this.dataPort });
    }
    return executePipeline({ stages: expression.stages, outputs: expression.outputs, scope, port: this.dataPort });
  }
}

export { MemoryManifestStore };
