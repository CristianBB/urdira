import { canonicalBytes, computeDigest } from "@urdira/canonical";
import { operationRegistry, recipeRegistry, type QueryRequest, type QueryScope } from "@urdira/contracts";
import type { WorkspaceLifecycleRepository } from "@urdira/storage";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { CursorCache, type CursorDirection, type ManifestStreamReader, type ReadPageResult } from "./cursor-cache.js";
import { EngineError } from "./errors.js";
import { evaluateOperation, type OperationEvaluation, type QueryDataPort, type QueryStreamItem } from "./query-operators.js";
import { executePipeline } from "./pipeline-executor.js";
import { normalizeQueryRequest, type NormalizedQueryPlan } from "./query-plan.js";
import { executeRecipe } from "./recipe-executor.js";
import { SqliteStageSpool, type StageSpool } from "./pipeline-spool.js";

export interface QueryExecutionOptions {
  readonly data_port: QueryDataPort;
  readonly cursor_cache: CursorCache;
  readonly manifest_store?: QueryManifestStore;
  readonly now?: () => string;
  readonly execution_id_factory?: (plan: NormalizedQueryPlan) => string;
  /** Factory for an execution-local relational pipeline spool. */
  readonly stage_spool_factory?: () => Promise<StageSpool>;
  readonly abort_signal?: AbortSignal;
  /** Internal telemetry hook. Metrics never enter query/MCP response models. */
  readonly operation_metrics?: (metric: QueryOperationMetric) => void;
  /** Internal bounded aggregator. Deliberately absent from public query models. */
  readonly operation_telemetry?: QueryOperationTelemetry;
  /** Monotonic clock injection used only by internal timing tests/telemetry. */
  readonly metric_clock?: () => number;
  /** Operation-local resource probe. Storage adapters may inject exact counters. */
  readonly operation_metric_probe?: QueryOperationMetricProbe;
}

export interface QueryOperationMetric {
  readonly operation_id: string;
  readonly duration_ms: number;
  readonly rows: number;
  readonly decoded_bytes: number;
  readonly serialized_bytes: number;
  readonly event_loop_delay_ms: number;
  readonly copies: number;
  readonly rss_bytes: number;
  /** Compatibility alias for the original serialized-byte metric. */
  readonly bytes: number;
  readonly success: boolean;
}

export interface QueryOperationResourceMeasurement {
  readonly decoded_bytes?: number;
  readonly serialized_bytes?: number;
  readonly event_loop_delay_ms?: number;
  readonly copies?: number;
  readonly rss_bytes?: number;
}

export interface QueryOperationMetricProbe {
  readonly begin: (operation_id: string) => {
    readonly finish: () => QueryOperationResourceMeasurement;
  };
}

export interface QueryMetricDistribution {
  /** Lifetime total, including samples evicted from the percentile window. */
  readonly total: number;
  /** Min/max and percentiles are exact over the retained bounded window. */
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface QueryOperationTelemetrySummary {
  readonly operation_id: string;
  readonly sample_count: number;
  readonly retained_sample_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly duration_ms: QueryMetricDistribution;
  readonly rows: QueryMetricDistribution;
  readonly decoded_bytes: QueryMetricDistribution;
  readonly serialized_bytes: QueryMetricDistribution;
  readonly event_loop_delay_ms: QueryMetricDistribution;
  readonly copies: QueryMetricDistribution;
  readonly rss_bytes: QueryMetricDistribution;
}

type QueryMetricField = "duration_ms" | "rows" | "decoded_bytes" | "serialized_bytes" | "event_loop_delay_ms" | "copies" | "rss_bytes";

const QUERY_METRIC_FIELDS: readonly QueryMetricField[] = ["duration_ms", "rows", "decoded_bytes", "serialized_bytes", "event_loop_delay_ms", "copies", "rss_bytes"];

interface QueryOperationTelemetryAccumulator {
  sample_count: number;
  success_count: number;
  failure_count: number;
  next_sample_index: number;
  readonly totals: Record<QueryMetricField, number>;
  readonly samples: QueryOperationMetric[];
}

function emptyMetricTotals(): Record<QueryMetricField, number> {
  return { duration_ms: 0, rows: 0, decoded_bytes: 0, serialized_bytes: 0, event_loop_delay_ms: 0, copies: 0, rss_bytes: 0 };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
}

function distribution(samples: readonly QueryOperationMetric[], field: QueryMetricField, total: number): QueryMetricDistribution {
  const sorted = samples.map((sample) => sample[field]).sort((left, right) => left - right);
  return {
    total,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
  };
}

/** Internal, bounded and deterministic per-operation telemetry aggregation. */
export class QueryOperationTelemetry {
  private readonly maxSamplesPerOperation: number;
  private readonly operations = new Map<string, QueryOperationTelemetryAccumulator>();

  constructor(options: { readonly max_samples_per_operation?: number } = {}) {
    const limit = options.max_samples_per_operation ?? 1_024;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("max_samples_per_operation must be a positive safe integer");
    this.maxSamplesPerOperation = limit;
  }

  record(metric: QueryOperationMetric): void {
    let accumulator = this.operations.get(metric.operation_id);
    if (accumulator === undefined) {
      accumulator = { sample_count: 0, success_count: 0, failure_count: 0, next_sample_index: 0, totals: emptyMetricTotals(), samples: [] };
      this.operations.set(metric.operation_id, accumulator);
    }
    accumulator.sample_count += 1;
    if (metric.success) accumulator.success_count += 1;
    else accumulator.failure_count += 1;
    for (const field of QUERY_METRIC_FIELDS) accumulator.totals[field] += metric[field];
    if (accumulator.samples.length < this.maxSamplesPerOperation) accumulator.samples.push(metric);
    else {
      accumulator.samples[accumulator.next_sample_index] = metric;
      accumulator.next_sample_index = (accumulator.next_sample_index + 1) % this.maxSamplesPerOperation;
    }
  }

  snapshot(): readonly QueryOperationTelemetrySummary[] {
    return [...this.operations.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([operationId, accumulator]) => ({
        operation_id: operationId,
        sample_count: accumulator.sample_count,
        retained_sample_count: accumulator.samples.length,
        success_count: accumulator.success_count,
        failure_count: accumulator.failure_count,
        duration_ms: distribution(accumulator.samples, "duration_ms", accumulator.totals.duration_ms),
        rows: distribution(accumulator.samples, "rows", accumulator.totals.rows),
        decoded_bytes: distribution(accumulator.samples, "decoded_bytes", accumulator.totals.decoded_bytes),
        serialized_bytes: distribution(accumulator.samples, "serialized_bytes", accumulator.totals.serialized_bytes),
        event_loop_delay_ms: distribution(accumulator.samples, "event_loop_delay_ms", accumulator.totals.event_loop_delay_ms),
        copies: distribution(accumulator.samples, "copies", accumulator.totals.copies),
        rss_bytes: distribution(accumulator.samples, "rss_bytes", accumulator.totals.rss_bytes),
      }));
  }
}

export interface QueryContinuationRequest {
  readonly cursor: string;
  readonly response_budget: { readonly max_items: number; readonly max_characters: number };
}

export interface QueryManifestStore {
  readonly append: (execution_id: string, result_stream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>) => Promise<void>;
  /** Streaming variant used by v3 pipelines. Implementations may choose a
   * bounded persistence batch; callers must not materialize the whole stream
   * merely to create the immutable cursor manifest. */
  readonly appendIterable?: (execution_id: string, result_stream: string, direction: CursorDirection, items: AsyncIterable<QueryStreamItem>) => Promise<void>;
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

interface MemoryManifest {
  readonly segments: readonly QueryStreamItem[][];
  readonly positions: ReadonlyMap<string, number>;
  readonly entry_count: number;
}

class MemoryManifestStore implements QueryManifestStore {
  private readonly values = new Map<string, MemoryManifest>();
  async append(executionId: string, resultStream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>): Promise<void> {
    const key = `${executionId}\u0000${resultStream}\u0000${direction}`;
    if (this.values.has(key)) return;
    this.values.set(key, memoryManifest(items));
  }
  async appendIterable(executionId: string, resultStream: string, direction: CursorDirection, items: AsyncIterable<QueryStreamItem>): Promise<void> {
    const key = `${executionId}\u0000${resultStream}\u0000${direction}`;
    if (this.values.has(key)) return;
    const segments: QueryStreamItem[][] = [];
    const positions = new Map<string, number>();
    let segment: QueryStreamItem[] = [];
    let ordinal = 0;
    for await (const value of items) {
      if (!positions.has(value.stable_sort_key)) positions.set(value.stable_sort_key, ordinal);
      segment.push(value);
      ordinal += 1;
      if (segment.length >= MANIFEST_SEGMENT_ROWS) { segments.push(segment); segment = []; }
    }
    if (segment.length > 0 || segments.length === 0) segments.push(segment);
    this.values.set(key, { segments, positions, entry_count: ordinal });
  }
  readonly reader: ManifestStreamReader<QueryStreamItem> = {
    read: async (request) => {
      const manifest = this.values.get(`${request.execution_id}\u0000${request.result_stream}\u0000${request.direction}`);
      if (manifest === undefined || manifest.entry_count === 0) return { items: [], has_more: false };
      const positionOrdinal = request.position === undefined ? undefined : manifest.positions.get(request.position);
      let nextOrdinal = positionOrdinal === undefined ? 0 : positionOrdinal + 1;
      const items: QueryStreamItem[] = [];
      while (nextOrdinal < manifest.entry_count && items.length < request.limit) {
        const segmentIndex = Math.floor(nextOrdinal / MANIFEST_SEGMENT_ROWS);
        const segmentOffset = nextOrdinal % MANIFEST_SEGMENT_ROWS;
        const segment = manifest.segments[segmentIndex] ?? [];
        const take = Math.min(request.limit - items.length, segment.length - segmentOffset);
        if (take <= 0) break;
        items.push(...segment.slice(segmentOffset, segmentOffset + take));
        nextOrdinal += take;
      }
      return { items, has_more: nextOrdinal < manifest.entry_count };
    },
  };
}

const MANIFEST_SEGMENT_ROWS = 512;
const MANIFEST_SEGMENT_BYTES = 1024 * 1024;

function memoryManifest(items: ReadonlyArray<QueryStreamItem>): MemoryManifest {
  const segments: QueryStreamItem[][] = [];
  const positions = new Map<string, number>();
  for (let start = 0; start < items.length; start += MANIFEST_SEGMENT_ROWS) segments.push(items.slice(start, start + MANIFEST_SEGMENT_ROWS));
  for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
    const stableSortKey = items[ordinal]!.stable_sort_key;
    if (!positions.has(stableSortKey)) positions.set(stableSortKey, ordinal);
  }
  if (segments.length === 0) segments.push([]);
  return { segments, positions, entry_count: items.length };
}

interface DurableManifestSegmentDescriptor {
  readonly segment_id: string;
  readonly first_ordinal: number;
  readonly entry_count: number;
  readonly first_stable_sort_key?: string;
  readonly last_stable_sort_key?: string;
}

interface DurableManifestDescriptor {
  readonly ordinal: 0;
  readonly manifest_version: 1;
  readonly entry_count: number;
  readonly segments: readonly DurableManifestSegmentDescriptor[];
  readonly position_order?: "ascending" | "descending" | "unordered";
}

function durableDescriptor(value: unknown): DurableManifestDescriptor | undefined {
  if (value === null || typeof value !== "object" || !("manifest_version" in value) || value.manifest_version !== 1 || !("segments" in value) || !Array.isArray(value.segments)) return undefined;
  return value as DurableManifestDescriptor;
}

function compareStableSortKeys(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareInPositionOrder(left: string, right: string, order: "ascending" | "descending"): -1 | 0 | 1 {
  const comparison = compareStableSortKeys(left, right);
  return order === "ascending" ? comparison : comparison === 0 ? 0 : comparison === 1 ? -1 : 1;
}

function segmentIndexForPosition(descriptor: DurableManifestDescriptor, position: string): number | undefined {
  const order = descriptor.position_order;
  if (order !== "ascending" && order !== "descending") return undefined;
  let low = 0;
  let high = descriptor.segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const first = descriptor.segments[middle]!.first_stable_sort_key;
    if (first === undefined) return undefined;
    if (compareInPositionOrder(first, position, order) <= 0) { candidate = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (candidate < 0) return undefined;
  while (candidate > 0 && descriptor.segments[candidate - 1]!.last_stable_sort_key === position) candidate -= 1;
  const last = descriptor.segments[candidate]!.last_stable_sort_key;
  if (last === undefined || compareInPositionOrder(position, last, order) > 0) return undefined;
  return candidate;
}

function segmentIndexForOrdinal(segments: readonly DurableManifestSegmentDescriptor[], ordinal: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const segment = segments[middle]!;
    if (ordinal < segment.first_ordinal) high = middle - 1;
    else if (ordinal >= segment.first_ordinal + segment.entry_count) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(low, segments.length - 1));
}

/** Durable manifest adapter. Forward and backward streams use the same stable
 * item positions but are persisted as independent bounded immutable segments. */
export class DurableManifestStore implements QueryManifestStore {
  constructor(private readonly lifecycle: WorkspaceLifecycleRepository) {}
  async append(executionId: string, resultStream: string, direction: CursorDirection, items: ReadonlyArray<QueryStreamItem>): Promise<void> {
    await this.appendIterable(executionId, resultStream, direction, (async function* (): AsyncIterable<QueryStreamItem> { for (const value of items) yield value; })());
  }
  async appendIterable(executionId: string, resultStream: string, direction: CursorDirection, items: AsyncIterable<QueryStreamItem>): Promise<void> {
    const manifestId = `${resultStream}\u0000${direction}`;
    const descriptors: DurableManifestSegmentDescriptor[] = [];
    let values: Array<QueryStreamItem & { ordinal: number }> = [];
    let bytes = 0;
    let ordinal = 0;
    let ascending = true;
    let descending = true;
    let previousStableSortKey: string | undefined;
    const flush = async (): Promise<void> => {
      if (values.length === 0) return;
      const segmentId = `${manifestId}\u0000chunk:${String(descriptors.length).padStart(8, "0")}`;
      const firstOrdinal = values[0]!.ordinal;
      await this.lifecycle.appendManifestSegment(executionId, segmentId, values);
      descriptors.push({ segment_id: segmentId, first_ordinal: firstOrdinal, entry_count: values.length, first_stable_sort_key: values[0]!.stable_sort_key, last_stable_sort_key: values.at(-1)!.stable_sort_key });
      values = [];
      bytes = 0;
    };
    for await (const value of items) {
      if (previousStableSortKey !== undefined) {
        const comparison = compareStableSortKeys(previousStableSortKey, value.stable_sort_key);
        if (comparison > 0) ascending = false;
        if (comparison < 0) descending = false;
      }
      previousStableSortKey = value.stable_sort_key;
      const valueBytes = canonicalBytes(value).byteLength;
      if (values.length > 0 && (values.length >= MANIFEST_SEGMENT_ROWS || bytes + valueBytes > MANIFEST_SEGMENT_BYTES)) await flush();
      values.push({ ...value, ordinal: ordinal++ });
      bytes += valueBytes;
    }
    await flush();
    const descriptor: DurableManifestDescriptor = { ordinal: 0, manifest_version: 1, entry_count: ordinal, segments: descriptors, position_order: ascending ? "ascending" : descending ? "descending" : "unordered" };
    await this.lifecycle.appendManifestSegment(executionId, manifestId, [descriptor]);
  }
  readonly reader: ManifestStreamReader<QueryStreamItem> = {
    read: async (request) => {
      const manifestId = `${request.result_stream}\u0000${request.direction}`;
      const raw = await this.lifecycle.hydrateManifestSegment<unknown>(request.execution_id, manifestId, 0, 1);
      const descriptor = durableDescriptor(raw[0]);
      if (descriptor === undefined || descriptor.entry_count === 0) return { items: [], has_more: false };
      const hydrated = new Map<number, readonly (QueryStreamItem & { ordinal: number })[]>();
      const hydrate = async (segmentIndex: number): Promise<readonly (QueryStreamItem & { ordinal: number })[]> => {
        const cached = hydrated.get(segmentIndex);
        if (cached !== undefined) return cached;
        const segment = descriptor.segments[segmentIndex]!;
        const rows = await this.lifecycle.hydrateManifestSegment<QueryStreamItem & { ordinal: number }>(request.execution_id, segment.segment_id, segment.first_ordinal, segment.entry_count);
        hydrated.set(segmentIndex, rows);
        return rows;
      };
      let nextOrdinal = 0;
      if (request.position !== undefined) {
        const indexedSegment = segmentIndexForPosition(descriptor, request.position);
        const candidates = indexedSegment === undefined ? descriptor.segments.map((_segment, index) => index) : [indexedSegment];
        let foundOrdinal: number | undefined;
        for (const segmentIndex of candidates) {
          const row = (await hydrate(segmentIndex)).find((entry) => entry.stable_sort_key === request.position);
          if (row !== undefined) { foundOrdinal = row.ordinal; break; }
        }
        if (foundOrdinal !== undefined) nextOrdinal = foundOrdinal + 1;
      }
      const page: QueryStreamItem[] = [];
      if (nextOrdinal < descriptor.entry_count && request.limit > 0) {
        let segmentIndex = segmentIndexForOrdinal(descriptor.segments, nextOrdinal);
        while (segmentIndex < descriptor.segments.length && page.length < request.limit) {
          for (const row of await hydrate(segmentIndex)) {
            if (row.ordinal < nextOrdinal) continue;
            const { ordinal: _ordinal, ...item } = row;
            page.push(item);
            if (page.length >= request.limit) break;
          }
          segmentIndex += 1;
        }
      }
      return { items: page, has_more: nextOrdinal + page.length < descriptor.entry_count };
    },
  };
}

const EMPTY_RESOURCE_MEASUREMENT: QueryOperationResourceMeasurement = Object.freeze({});

function finiteNonNegative(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function defaultMetricProbe(): QueryOperationMetricProbe {
  return {
    begin: () => {
      const startedRss = process.memoryUsage.rss();
      let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
      try {
        histogram = monitorEventLoopDelay({ resolution: 10 });
        histogram.enable();
      } catch { /* Resource telemetry remains best-effort and fail-isolated. */ }
      return {
        finish: () => {
          const finishedRss = process.memoryUsage.rss();
          const delay = histogram === undefined ? 0 : finiteNonNegative(histogram.max / 1_000_000);
          histogram?.disable();
          return { rss_bytes: Math.max(startedRss, finishedRss), event_loop_delay_ms: delay };
        },
      };
    },
  };
}

function beginResourceMeasurement(probe: QueryOperationMetricProbe, operationId: string): () => QueryOperationResourceMeasurement {
  try {
    const measurement = probe.begin(operationId);
    return () => {
      try { return measurement.finish(); }
      catch { return EMPTY_RESOURCE_MEASUREMENT; }
    };
  } catch {
    return () => EMPTY_RESOURCE_MEASUREMENT;
  }
}

function measuredPort(port: QueryDataPort, sink: (metric: QueryOperationMetric) => void, clock: () => number, probe: QueryOperationMetricProbe): QueryDataPort {
  const report = (metric: QueryOperationMetric): void => { try { sink(metric); } catch { /* Telemetry cannot affect query correctness. */ } };
  return {
    ...(port.consumes_stage_handles === undefined ? {} : { consumes_stage_handles: port.consumes_stage_handles }),
    execute: async (operation) => {
      const started = clock();
      const finishResources = beginResourceMeasurement(probe, operation.operation_id);
      try {
        const evaluation = await port.execute(operation);
        const rows = Object.values(evaluation.streams).reduce((total, stream) => total + stream.length, 0);
        let canonicalByteLength = 0;
        try { canonicalByteLength = canonicalBytes(evaluation.streams).byteLength; } catch { /* Metrics remain best-effort and internal. */ }
        const resources = finishResources();
        const serializedBytes = finiteNonNegative(resources.serialized_bytes, canonicalByteLength);
        report({
          operation_id: operation.operation_id,
          duration_ms: finiteNonNegative(clock() - started),
          rows,
          decoded_bytes: finiteNonNegative(resources.decoded_bytes, canonicalByteLength),
          serialized_bytes: serializedBytes,
          event_loop_delay_ms: finiteNonNegative(resources.event_loop_delay_ms),
          copies: finiteNonNegative(resources.copies, canonicalByteLength === 0 ? 0 : 1),
          rss_bytes: finiteNonNegative(resources.rss_bytes),
          bytes: serializedBytes,
          success: true,
        });
        return evaluation;
      } catch (error) {
        const resources = finishResources();
        const serializedBytes = finiteNonNegative(resources.serialized_bytes);
        report({
          operation_id: operation.operation_id,
          duration_ms: finiteNonNegative(clock() - started),
          rows: 0,
          decoded_bytes: finiteNonNegative(resources.decoded_bytes),
          serialized_bytes: serializedBytes,
          event_loop_delay_ms: finiteNonNegative(resources.event_loop_delay_ms),
          copies: finiteNonNegative(resources.copies),
          rss_bytes: finiteNonNegative(resources.rss_bytes),
          bytes: serializedBytes,
          success: false,
        });
        throw error;
      }
    },
    ...(port.relation_exists === undefined ? {} : { relation_exists: port.relation_exists.bind(port) }),
    ...(port.relation_pairs === undefined ? {} : { relation_pairs: port.relation_pairs.bind(port) }),
    ...(port.relation_pairs_handles === undefined ? {} : { relation_pairs_handles: port.relation_pairs_handles.bind(port) }),
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

async function appendEvaluationStream(store: QueryManifestStore, executionId: string, stream: string, direction: CursorDirection, values: AsyncIterable<QueryStreamItem> | undefined, fallback: readonly QueryStreamItem[]): Promise<void> {
  if (values !== undefined && store.appendIterable !== undefined) {
    await store.appendIterable(executionId, stream, direction, values);
    return;
  }
  if (values !== undefined) {
    const collected: QueryStreamItem[] = [];
    for await (const value of values) collected.push(value);
    await store.append(executionId, stream, direction, collected);
    return;
  }
  await store.append(executionId, stream, direction, fallback);
}

export class QueryEngine {
  private readonly dataPort: QueryDataPort;
  private readonly cursorCache: CursorCache;
  private readonly manifestStore: QueryManifestStore;
  private readonly now: () => string;
  private readonly idFactory: (plan: NormalizedQueryPlan) => string;
  private readonly stageSpoolFactory: () => Promise<StageSpool>;
  private readonly abortSignal: AbortSignal | undefined;
  private sequence = 0;

  constructor(options: QueryExecutionOptions) {
    const metricSinks = [
      ...(options.operation_metrics === undefined ? [] : [options.operation_metrics]),
      ...(options.operation_telemetry === undefined ? [] : [(metric: QueryOperationMetric) => options.operation_telemetry!.record(metric)]),
    ];
    this.dataPort = metricSinks.length === 0 ? options.data_port : measuredPort(
      options.data_port,
      (metric) => { for (const sink of metricSinks) { try { sink(metric); } catch { /* One telemetry sink cannot suppress another. */ } } },
      options.metric_clock ?? (() => performance.now()),
      options.operation_metric_probe ?? defaultMetricProbe(),
    );
    this.cursorCache = options.cursor_cache;
    this.manifestStore = options.manifest_store ?? new MemoryManifestStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.execution_id_factory ?? ((plan) => `query-${plan.plan_digest.slice(-16)}-${this.sequence++}`);
    // Every pipeline gets an execution-local relational spool by default. A
    // daemon can still inject a file-backed instance rooted in its data root;
    // the in-memory SQLite variant keeps ordinary calls isolated without
    // retaining a second JavaScript representation after the stage is sealed.
    this.stageSpoolFactory = options.stage_spool_factory ?? (async () => SqliteStageSpool.memory());
    this.abortSignal = options.abort_signal;
  }

  /**
   * Evaluates one normalized request exactly once, seals every result stream
   * into immutable forward and reverse manifests, returns the first bounded
   * page, and always releases the execution-local pipeline spool. Cursor
   * continuations read those manifests through {@link continue}; they never
   * re-evaluate this request.
   */
  async execute(request: QueryRequest, requestSignal?: AbortSignal): Promise<QueryExecutionPage> {
    const plan = normalizeQueryRequest(request);
    const executionId = this.idFactory(plan);
    const now = this.now();
    const expiresAt = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
    const spool = plan.normalized_expression.expression_type === "pipeline" ? await this.stageSpoolFactory() : undefined;
    const abortSignal = requestSignal ?? this.abortSignal;
    if (abortSignal?.aborted) throw new EngineError("core:operation_cancelled", "Query execution was cancelled.");
    let evaluation: OperationEvaluation;
    try {
      evaluation = await this.evaluate(plan, request.scope, executionId, spool, abortSignal);
    } catch (error) {
      if (spool) {
        await spool.cleanup(executionId);
        await spool.close();
      }
      throw error;
    }
    try {
      if (request.options.coverage_requirement === "require_complete" && (evaluation.completeness as { overall_status?: string } | undefined)?.overall_status !== "complete") throw new EngineError("core:coverage_incomplete", "Complete coverage was required by the request.");
      const streams = streamItems(evaluation);
      const pages: Record<string, QueryStreamPage> = {};
      const streamNames = new Set([...Object.keys(streams), ...Object.keys(evaluation.stream_sources ?? {})]);
      // `max_characters` bounds the WHOLE response, not each stream in
      // isolation -- an operation like `core:find_references` publishes two
      // streams (`references`, `owners`) in one page, and handing each the
      // full budget independently would let the combined page grow to
      // (stream count * budget). Each stream instead spends down a shared
      // remaining budget; `readPage` itself still guarantees at least one
      // item per stream regardless of what is left, so a stream ordered
      // after a large one is never silently starved to zero rows.
      let remainingCharacters = request.options.response_budget.max_characters;
      for (const stream of streamNames) {
        const values = streams[stream] ?? [];
        await appendEvaluationStream(this.manifestStore, executionId, stream, "forward", evaluation.stream_sources?.[stream], values);
        await appendEvaluationStream(this.manifestStore, executionId, stream, "backward", evaluation.reverse_stream_sources?.[stream], [...values].reverse());
        const page = await this.cursorCache.readPage({ execution_id: executionId, result_stream: stream, direction: "forward", projection_digest: plan.plan_digest, ordering_digest: plan.plan_digest, scope_digest: scopeDigest(request.scope), response_budget_ceiling_digest: computeDigest("core:query_budget", "core:query_budget_digest", 1, "core:ResponseBudget", 1, request.options.response_budget), frozen_snapshot_digest: scopeDigest(request.scope), frozen_status_digest: evaluation.semantic_state ?? "ready", completeness: evaluation.completeness as QueryExecutionPage["completeness"] | undefined, expires_at: expiresAt, now, limit: request.options.response_budget.max_items, max_characters: Math.max(1, remainingCharacters), reader: this.manifestStore.reader });
        remainingCharacters = Math.max(0, remainingCharacters - page.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0));
        pages[stream] = page;
      }
      return { query_execution_id: executionId, plan_digest: plan.plan_digest, streams: pages, completeness: (evaluation.completeness as QueryExecutionPage["completeness"]) ?? { overall_status: "unknown", dimensions: [] }, diagnostics: request.options.diagnostics.diagnostics === "none" ? [] : evaluation.diagnostics ?? [], registry: { mode: request.options.registry.registry, operation_ids: request.options.registry.registry === "none" ? [] : [...plan.operation_versions].map((binding) => binding.operation_id), recipe_ids: request.options.registry.registry === "none" ? [] : [...plan.recipe_versions].map((binding) => binding.recipe_id) }, ...(evaluation.semantic_state === undefined ? {} : { semantic_state: evaluation.semantic_state }), expires_at: expiresAt };
    } finally {
      if (spool) {
        await spool.cleanup(executionId);
        await spool.close();
      }
    }
  }

  async continue(request: QueryContinuationRequest): Promise<QueryExecutionPage> {
    const claims = this.cursorCache.decode(request.cursor);
    const read = await this.cursorCache.readPage({ cursor: request.cursor, limit: request.response_budget.max_items, max_characters: request.response_budget.max_characters, reader: this.manifestStore.reader, now: this.now() });
    // Backward storage is traversed in reverse, but every public page is
    // rendered in canonical forward order. CursorCache's traversal-relative
    // next/previous fields therefore swap when projected back to page order.
    const page: ReadPageResult<QueryStreamItem> = claims.direction === "forward" ? read : {
      items: [...read.items].reverse(),
      has_next: read.has_previous,
      has_previous: read.has_next,
      ...(read.previous_cursor === undefined ? {} : { next_cursor: read.previous_cursor }),
      ...(read.next_cursor === undefined ? {} : { previous_cursor: read.next_cursor }),
    };
    return { query_execution_id: claims.execution_id, plan_digest: claims.projection_digest, streams: { [claims.result_stream]: page }, completeness: claims.completeness ?? { overall_status: "unknown", dimensions: [] }, diagnostics: [], registry: { mode: "none", operation_ids: [], recipe_ids: [] }, expires_at: claims.expires_at };
  }

  private async evaluate(plan: NormalizedQueryPlan, scope: QueryScope, executionId: string, spool?: StageSpool, abortSignal?: AbortSignal): Promise<OperationEvaluation> {
    const expression = plan.normalized_expression as unknown as QueryRequest["expression"];
    if (expression.expression_type === "operation") return evaluateOperation({ operation_id: expression.operation, arguments: expression.arguments, scope, port: this.dataPort });
    if (expression.expression_type === "recipe") {
      const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === expression.recipe_id)!;
      return executeRecipe({ recipe, recipeArguments: expression.arguments as unknown as Readonly<Record<string, unknown>>, scope, port: this.dataPort });
    }
      return executePipeline({ execution_id: executionId, stages: expression.stages as ReadonlyArray<import("@urdira/contracts").QueryStage>, outputs: expression.outputs as ReadonlyArray<import("@urdira/contracts").StageOutputReference>, scope, port: this.dataPort, stream_final: true, ...(spool === undefined ? {} : { spool }), ...(abortSignal === undefined ? {} : { abort_signal: abortSignal }) });
  }
}

export { MemoryManifestStore };
