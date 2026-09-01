import { describe, expect, it } from "vitest";
import type { QueryRequest } from "@urdira/contracts";
import {
  CursorCache,
  DurableManifestStore,
  QueryEngine,
  type QueryStreamItem,
} from "../packages/engine/src/index.js";
import type { QueryOperationMetric } from "../packages/engine/src/query-execution.js";

class RecordingLifecycle {
  readonly writes: Array<{ readonly segmentId: string; readonly entries: readonly unknown[] }> = [];
  readonly hydrateCalls: string[] = [];
  private readonly segments = new Map<string, readonly unknown[]>();

  async appendManifestSegment(_executionId: string, segmentId: string, entries: readonly unknown[]): Promise<void> {
    this.writes.push({ segmentId, entries });
    this.segments.set(segmentId, entries);
  }

  async hydrateManifestSegment<T>(_executionId: string, segmentId: string, start: number, limit: number): Promise<readonly T[]> {
    this.hydrateCalls.push(segmentId);
    return (this.segments.get(segmentId) ?? []).filter((entry) => {
      const ordinal = typeof entry === "object" && entry !== null && "ordinal" in entry ? Number(entry.ordinal) : 0;
      return ordinal >= start && ordinal < start + limit;
    }) as readonly T[];
  }
}

function values(count: number): readonly QueryStreamItem[] {
  return Array.from({ length: count }, (_, index) => ({ value: { index, text: "x".repeat(64) }, stable_sort_key: `key-${String(index).padStart(5, "0")}` }));
}

describe("segmented query manifests", () => {
  it("persists an async stream in bounded immutable segments and reads across a segment boundary", async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new DurableManifestStore(lifecycle as never);
    const input = values(1_100);
    await store.appendIterable!("execution", "records", "forward", (async function* () { for (const entry of input) yield entry; })());

    const dataWrites = lifecycle.writes.filter(({ segmentId }) => segmentId.includes("\u0000chunk:"));
    expect(dataWrites.length).toBeGreaterThan(1);
    expect(Math.max(...dataWrites.map(({ entries }) => entries.length))).toBeLessThanOrEqual(512);
    const page = await store.reader.read({ execution_id: "execution", result_stream: "records", direction: "forward", position: input[505]!.stable_sort_key, limit: 20 });
    expect(page.items.map((entry) => (entry.value as { index: number }).index)).toEqual(Array.from({ length: 20 }, (_, index) => 506 + index));
    expect(page.has_more).toBe(true);
  });

  it("selects deep forward and backward pages without hydrating preceding segments", async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new DurableManifestStore(lifecycle as never);
    const input = values(20_000);
    await store.append("execution", "records", "forward", input);
    await store.append("execution", "records", "backward", [...input].reverse());

    lifecycle.hydrateCalls.length = 0;
    const forward = await store.reader.read({ execution_id: "execution", result_stream: "records", direction: "forward", position: input[18_000]!.stable_sort_key, limit: 5 });
    expect(forward.items.map((entry) => (entry.value as { index: number }).index)).toEqual([18_001, 18_002, 18_003, 18_004, 18_005]);
    expect(lifecycle.hydrateCalls.length).toBeLessThanOrEqual(2);
    expect(lifecycle.hydrateCalls.some((segmentId) => segmentId.endsWith("chunk:00000000"))).toBe(false);

    lifecycle.hydrateCalls.length = 0;
    const backward = await store.reader.read({ execution_id: "execution", result_stream: "records", direction: "backward", position: input[1_999]!.stable_sort_key, limit: 5 });
    expect(backward.items.map((entry) => (entry.value as { index: number }).index)).toEqual([1_998, 1_997, 1_996, 1_995, 1_994]);
    expect(lifecycle.hydrateCalls.length).toBeLessThanOrEqual(2);
    expect(lifecycle.hydrateCalls.some((segmentId) => segmentId.endsWith("chunk:00000000"))).toBe(false);
  });

  it("replays forward-backward-forward pages byte-equivalently and emits internal operation metrics", async () => {
    const lifecycle = new RecordingLifecycle();
    const store = new DurableManifestStore(lifecycle as never);
    const metrics: QueryOperationMetric[] = [];
    const all = values(25);
    const engine = new QueryEngine({
      data_port: { async execute() { return { streams: { records: all } }; } },
      cursor_cache: new CursorCache({ signing_secret: "query-manifest-streaming" }),
      manifest_store: store,
      now: () => "2026-08-27T00:00:00.000Z",
      operation_metrics: (metric) => metrics.push(metric),
      metric_clock: (() => { let tick = 0; return () => ++tick; })(),
    });
    const request: QueryRequest = {
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace:manifest" },
      expression: { expression_type: "operation", operation: "core:find_records", arguments: { selector: { record_categories: ["entity"] } } },
      options: {
        freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
        evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "none", diagnostic_detail: false },
        snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
        registry: { registry: "none", include_payload_schemas: false }, response_budget: { max_items: 5, max_characters: 100_000 },
      },
    };
    const first = await engine.execute(request);
    const second = await engine.continue({ cursor: first.streams["records"]!.next_cursor!, response_budget: { max_items: 5, max_characters: 100_000 } });
    const backward = await engine.continue({ cursor: second.streams["records"]!.previous_cursor!, response_budget: { max_items: 5, max_characters: 100_000 } });
    const replay = await engine.continue({ cursor: backward.streams["records"]!.next_cursor!, response_budget: { max_items: 5, max_characters: 100_000 } });
    expect(backward.streams["records"]!.items).toEqual(first.streams["records"]!.items);
    expect(replay.streams["records"]!.items).toEqual(second.streams["records"]!.items);
    expect(metrics).toEqual([expect.objectContaining({ operation_id: "core:find_records", rows: 25, bytes: expect.any(Number), duration_ms: 1, success: true })]);
    expect(metrics[0]!.bytes).toBeGreaterThan(0);
  });
});
