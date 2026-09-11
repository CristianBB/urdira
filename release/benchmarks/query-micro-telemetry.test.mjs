import test from "node:test";
import assert from "node:assert/strict";
import { extractQueryTelemetry } from "./query-micro-telemetry.mjs";

test("extracts operation and page metrics from MCP progress", () => {
  assert.deepEqual(
    extractQueryTelemetry({ method: "notifications/progress", params: { message: "operation_metrics=[{\"operation\":\"core:resolve_symbol\"}]" } }),
    { kind: "operation_metrics", value: [{ operation: "core:resolve_symbol" }] },
  );
  assert.deepEqual(
    extractQueryTelemetry({ method: "notifications/progress", params: { message: "operation_page_metrics=[{\"rows\":1}]" } }),
    { kind: "operation_page_metrics", value: [{ rows: 1 }] },
  );
  assert.equal(extractQueryTelemetry({ method: "notifications/progress", params: { message: "hydration_ms=2" } }), undefined);
});
