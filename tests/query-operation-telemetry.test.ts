import { describe, expect, it } from "vitest";
import type { QueryRequest } from "@urdira/contracts";
import {
  CursorCache,
  QueryEngine,
  QueryOperationTelemetry,
  type QueryOperationMetric,
  type QueryOperationMetricProbe,
  type QueryPageMetric,
} from "../packages/engine/src/index.js";

function metric(operationId: string, value: number, success = true): QueryOperationMetric {
  return {
    operation_id: operationId,
    duration_ms: value,
    rows: value * 2,
    decoded_bytes: value * 3,
    serialized_bytes: value * 4,
    event_loop_delay_ms: value * 5,
    copies: value * 6,
    rss_bytes: value * 7,
    bytes: value * 4,
    success,
  };
}

function request(): QueryRequest {
  return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: "workspace:telemetry" },
    expression: {
      expression_type: "operation",
      operation: "core:find_records",
      arguments: { selector: { record_categories: ["entity"] } },
    },
    options: {
      freshness: "current",
      wait_timeout_ms: 0,
      coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 },
      diagnostics: { diagnostics: "none", diagnostic_detail: false },
      snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
      registry: { registry: "none", include_payload_schemas: false },
      response_budget: { max_items: 10, max_characters: 100_000 },
    },
  };
}

describe("query operation telemetry", () => {
  it("aggregates exact P50/P95/P99 distributions and lifetime totals by operation_id", () => {
    const telemetry = new QueryOperationTelemetry({ max_samples_per_operation: 128 });
    for (let value = 100; value >= 1; value -= 1) telemetry.record(metric("core:find_records", value, value % 4 !== 0));
    telemetry.record(metric("core:get_outline", 7));

    const summaries = telemetry.snapshot();
    expect(summaries.map(({ operation_id }) => operation_id)).toEqual(["core:find_records", "core:get_outline"]);
    expect(summaries[0]).toEqual({
      operation_id: "core:find_records",
      sample_count: 100,
      retained_sample_count: 100,
      success_count: 75,
      failure_count: 25,
      duration_ms: { total: 5_050, min: 1, max: 100, p50: 50, p95: 95, p99: 99 },
      rows: { total: 10_100, min: 2, max: 200, p50: 100, p95: 190, p99: 198 },
      decoded_bytes: { total: 15_150, min: 3, max: 300, p50: 150, p95: 285, p99: 297 },
      serialized_bytes: { total: 20_200, min: 4, max: 400, p50: 200, p95: 380, p99: 396 },
      event_loop_delay_ms: { total: 25_250, min: 5, max: 500, p50: 250, p95: 475, p99: 495 },
      copies: { total: 30_300, min: 6, max: 600, p50: 300, p95: 570, p99: 594 },
      rss_bytes: { total: 35_350, min: 7, max: 700, p50: 350, p95: 665, p99: 693 },
      candidates: { total: 10_100, min: 2, max: 200, p50: 100, p95: 190, p99: 198 },
      rows_hydrated: { total: 10_100, min: 2, max: 200, p50: 100, p95: 190, p99: 198 },
      routes: {},
      indexes: {},
      decline_reasons: {},
      fallback_reasons: {},
    });
  });

  it("bounds retained percentile samples without losing lifetime counts and totals", () => {
    const telemetry = new QueryOperationTelemetry({ max_samples_per_operation: 3 });
    for (let value = 1; value <= 4; value += 1) telemetry.record(metric("core:find_records", value));

    expect(telemetry.snapshot()[0]).toMatchObject({
      sample_count: 4,
      retained_sample_count: 3,
      duration_ms: { total: 10, min: 2, max: 4, p50: 3, p95: 4, p99: 4 },
      decoded_bytes: { total: 30, min: 6, max: 12, p50: 9, p95: 12, p99: 12 },
    });
  });

  it("attributes injected resource measurements to an operation without exposing telemetry in the query response", async () => {
    const emitted: QueryOperationMetric[] = [];
    const telemetry = new QueryOperationTelemetry();
    const probe: QueryOperationMetricProbe = {
      begin: (operationId) => {
        expect(operationId).toBe("core:find_records");
        return {
          finish: () => ({ decoded_bytes: 901, serialized_bytes: 707, event_loop_delay_ms: 3.5, copies: 4, rss_bytes: 123_456 }),
        };
      },
    };
    const ticks = [10, 16];
    const engine = new QueryEngine({
      data_port: {
        async execute() {
          return { streams: { records: [{ stable_sort_key: "record:1", value: { record_id: "record:1" } }] } };
        },
      },
      cursor_cache: new CursorCache({ signing_secret: "query-operation-telemetry" }),
      now: () => "2026-08-28T00:00:00.000Z",
      operation_metrics: (sample) => emitted.push(sample),
      operation_telemetry: telemetry,
      operation_metric_probe: probe,
      metric_clock: () => ticks.shift()!,
    });

    const page = await engine.execute(request());
    expect(emitted).toEqual([{
      operation_id: "core:find_records",
      duration_ms: 6,
      rows: 1,
      decoded_bytes: 901,
      serialized_bytes: 707,
      event_loop_delay_ms: 3.5,
      copies: 4,
      rss_bytes: 123_456,
      bytes: 707,
      success: true,
    }]);
    expect(telemetry.snapshot()[0]).toMatchObject({ operation_id: "core:find_records", duration_ms: { p50: 6 }, rss_bytes: { p50: 123_456 } });
    expect(page).not.toHaveProperty("telemetry");
    expect(page).not.toHaveProperty("operation_metrics");
  });

  it("records failed operations and isolates telemetry failures from query semantics", async () => {
    const telemetry = new QueryOperationTelemetry();
    const probe: QueryOperationMetricProbe = { begin: () => ({ finish: () => { throw new Error("probe failed"); } }) };
    const engine = new QueryEngine({
      data_port: { async execute() { throw new Error("query failed"); } },
      cursor_cache: new CursorCache({ signing_secret: "query-operation-telemetry-failure" }),
      operation_metrics: () => { throw new Error("sink failed"); },
      operation_telemetry: telemetry,
      operation_metric_probe: probe,
      metric_clock: (() => { let value = 0; return () => value += 2; })(),
    });

    await expect(engine.execute(request())).rejects.toThrow("query failed");
    expect(telemetry.snapshot()[0]).toMatchObject({
      operation_id: "core:find_records",
      sample_count: 1,
      success_count: 0,
      failure_count: 1,
      duration_ms: { p50: 2 },
      rows: { total: 0 },
    });
  });

  it("records bounded route metadata and initial page cost without exposing it in the page", async () => {
    const operationMetrics: QueryOperationMetric[] = [];
    const pageMetrics: QueryPageMetric[] = [];
    const telemetry = new QueryOperationTelemetry();
    let tick = 0;
    const engine = new QueryEngine({
      data_port: {
        async execute() {
          return {
            streams: { records: [{ stable_sort_key: "record:1", value: { record_id: "record:1" } }] },
            telemetry: {
              route: "indexed_lookup",
              index_used: "record_kind",
              candidates: 3,
              rows_hydrated: 1,
            },
          };
        },
      },
      cursor_cache: new CursorCache({ signing_secret: "query-operation-telemetry-page" }),
      now: () => "2026-08-28T00:00:00.000Z",
      metric_clock: () => (tick += 5),
      operation_metrics: (metric) => operationMetrics.push(metric),
      page_metrics: (metric) => pageMetrics.push(metric),
      operation_telemetry: telemetry,
    });

    const page = await engine.execute(request());
    expect(page).not.toHaveProperty("telemetry");
    expect(operationMetrics[0]).toMatchObject({
      route: "indexed_lookup",
      index_used: "record_kind",
      candidates: 3,
      rows_hydrated: 1,
    });
    expect(pageMetrics).toEqual([expect.objectContaining({
      page_kind: "initial",
      stream: "records",
      candidates: 1,
      rows_hydrated: 1,
      success: true,
    })]);
    expect(pageMetrics[0]?.cost_ms).toBeGreaterThanOrEqual(0);
    expect(telemetry.snapshot()[0]).toMatchObject({
      routes: { indexed_lookup: 1 },
      indexes: { record_kind: 1 },
      candidates: { total: 3 },
      rows_hydrated: { total: 1 },
    });
    expect(telemetry.pageSnapshot()).toEqual([expect.objectContaining({
      stream: "records",
      page_kind: "initial",
      sample_count: 1,
      rows_hydrated: expect.objectContaining({ total: 1 }),
    })]);
  });
});
