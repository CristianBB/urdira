import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPostMeasurementPlan,
  analyzePostMeasurement,
  mergePostMeasurements,
  operationOf,
  resultObject,
} from "../release/benchmarks/post-index-measurement.mjs";

describe("post indexing measurement harness", () => {
  it("builds a directed, production-contract plan without adding pipelines", () => {
    const plan = buildPostMeasurementPlan({
      repositoryIds: ["vscode"],
      corpus: { repositories: [{ id: "vscode", repository: "microsoft/vscode", commit: "abc", tasks: [] }] },
    });
    expect(plan.repositories).toHaveLength(1);
    expect(plan.environment).toMatchObject({
      semantic_index: false,
      semantic_materialization: false,
      semantic_sidecar: false,
      readiness: "structural",
      mcp_instructions: "production",
      pipeline_required: false,
    });
    expect(plan.operations.map((item) => item.operation)).toEqual([
      "core:resolve_symbol", "core:find_records", "core:search_text", "core:compare_workspaces",
    ]);
    expect(plan.operations.find((item) => item.operation === "core:resolve_symbol")?.variants).toEqual([
      "context", "qualified", "kind",
    ]);
  });

  it("preserves failures, pagination, caps, completeness, typed byte splits, and latency", () => {
    const plan = buildPostMeasurementPlan({ repositoryIds: ["vscode"], corpus: { repositories: [{ id: "vscode", repository: "microsoft/vscode", commit: "abc", tasks: [] }] } });
    const events = [
      { type: "item.started", id: "r1", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "item.completed", id: "r1", timestamp: "2026-01-01T00:00:00.125Z", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", arguments: { query: { expression: { expression_type: "operation", operation: "core:resolve_symbol", arguments: { reference: "Registry", file_path: "src/a.ts", kind: "class" } } } }, result: { structuredContent: { declarations: [{ id: "x" }], completeness: "complete", bytes: { snippets: 12, hydration: 3, evidence: 4, registry: 5 } } } } },
      { type: "item.completed", id: "f1", timestamp: "2026-01-01T00:00:01.000Z", item: { type: "mcp_tool_call", tool: "urdira_query", status: "failed", arguments: { query: { expression: { expression_type: "operation", operation: "core:find_records", arguments: { limit: 2 } } } }, result: { structuredContent: { error: "cap" } } } },
      { type: "item.completed", id: "s1", timestamp: "2026-01-01T00:00:02.000Z", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", arguments: { query: { expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern: "Registry", limit: 2 } } } }, result: { structuredContent: { matches: [1, 2], next_cursor: "c1", completeness: "partial", truncated: true, cap: { limit: 2, applied: true }, bytes: { snippets: 10 } } } } },
      { type: "item.completed", id: "s2", timestamp: "2026-01-01T00:00:02.050Z", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", arguments: { query: { continuation: { cursor: "c1" } } }, result: { structuredContent: { matches: [3], completeness: "complete", bytes: { snippets: 7 } } } } },
      { type: "item.completed", id: "c1", timestamp: "2026-01-01T00:00:03.000Z", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", arguments: { query: { expression: { expression_type: "operation", operation: "core:compare_workspaces", arguments: {} } } }, result: { structuredContent: { added: [], removed: [], completeness: "complete" } } } },
    ];
    const result = analyzePostMeasurement({ events, plan, hostMetrics: { structural_readiness_ms: 57859, semantic_index: false, semantic_materialization: false } });
    expect(result.readiness).toMatchObject({ structural_readiness_ms: 57859, semantic_index: false });
    expect(result.operations.resolve_symbol).toMatchObject({ calls: 1, latency_ms: { count: 1, total: 125, average: 125 } });
    expect(result.operations.find_records).toMatchObject({ calls: 1, failures: 1, completeness: [null] });
    expect(result.operations.search_text).toMatchObject({ calls: 2, pages: 2, cap_applied: true, completeness: ["partial", "complete"], bytes: { snippets: 17, hydration: null } });
    expect(result.operations.compare_workspaces).toMatchObject({ calls: 1, completeness: ["complete"] });
    expect(result.failures).toHaveLength(1);
  });

  it("merges only directed post metrics and leaves absent values null", () => {
    const merged = mergePostMeasurements({ runs: [{ repository_id: "vscode", task_id: "x", arm: "urdira-typescript", sample: 1 }] }, { runs: [{ repository_id: "vscode", task_id: "x", arm: "urdira-typescript", sample: 1, post_measurement: { operations: {} } }] });
    expect(merged.runs[0].post_measurement).toBeTruthy();
    expect(merged.runs[0].post_measurement.operations.resolve_symbol).toBeNull();
  });

  it("parses compact agent text and counts compare recipe/stage once", () => {
    const compact = { content: [{ type: "text", text: "# 1 result\ncoverage: complete\nTRUNCATED: dropped 2 items (response_budget)\nMORE: pass cursor cursor:opaque via request_type=continuation\n\ncursor:opaque" }] };
    expect(resultObject({ result: compact })).toMatchObject({ completeness: "complete", cap: { applied: true, truncated: true }, pagination: { has_next: true } });
    const recipe = { arguments: { query: { expression: { expression_type: "recipe", recipe_id: "core:compare_workspaces" } } } };
    const stage = { arguments: { query: { expression: { expression_type: "operation", operation: "core:compare" } } } };
    expect(operationOf(recipe)).toBe("core:compare_workspaces");
    expect(operationOf(stage)).toBe("core:compare_workspaces");
    const plan = buildPostMeasurementPlan({ repositoryIds: ["vscode"], corpus: { repositories: [{ id: "vscode", repository: "microsoft/vscode", commit: "abc", tasks: [] }] } });
    const result = analyzePostMeasurement({ plan, events: [
      { type: "item.completed", id: "recipe", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", ...recipe, result: compact } },
      { type: "item.completed", id: "stage", item: { type: "mcp_tool_call", tool: "urdira_query", status: "completed", ...stage, result: compact } },
    ] });
    expect(result.operations.compare_workspaces.calls).toBe(2);
  });

  it("renders a complete report with transcript component metrics", () => {
    const output = mkdtempSync(join(tmpdir(), "post-index-render-"));
    const planPath = join(output, "plan.json");
    const eventsPath = join(output, "events.jsonl");
    const hostPath = join(output, "host.json");
    const reportPath = join(output, "report");
    const compactEvent = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/urdira-mcp-context-real-shape.json"), "utf8"));
    try {
      writeFileSync(planPath, `${JSON.stringify({ repositories: [{ id: "vscode", commit: "abc" }], arm: "urdira-typescript" })}\n`);
      writeFileSync(eventsPath, `${JSON.stringify(compactEvent)}\n`);
      writeFileSync(hostPath, JSON.stringify({ structural_readiness_ms: 123, semantic_index: false, semantic_materialization: false, semantic_sidecar_created: false }));
      execFileSync(process.execPath, ["release/benchmarks/render-post-index-measurement.mjs", "--plan", planPath, "--events", eventsPath, "--host-metrics", hostPath, "--output", reportPath], { cwd: process.cwd(), encoding: "utf8" });
      const rendered = JSON.parse(readFileSync(`${reportPath}.json`, "utf8"));
      expect(rendered.transcript_metrics.mcp_component_bytes).toMatchObject({ tool_envelope: expect.any(Number), model_visible_serialized: expect.any(Number), source_text: expect.any(Number), records: expect.any(Number) });
      expect(readFileSync(`${reportPath}.md`, "utf8")).toContain("Transcript components");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});

import { buildPostExecutionPlan, collectPostMeasurements } from "../release/benchmarks/run-post-index-measurement.mjs";

describe("post index executor composition", () => {
  it("plans one directed Urdira sample through the existing campaign driver", () => {
    const plan = buildPostExecutionPlan({
      corpus: { model: "gpt-5.6-luna", repositories: [{ id: "vscode", repository: "microsoft/vscode", commit: "abc", tasks: [] }] },
      repositoryIds: ["vscode"], output: "/tmp/post-index-new", repositoriesRoot: "/tmp/repos", node: "/node", codexPath: "/codex", indexingWorkerPath: "/worker",
    });
    expect(plan.no_retries).toBe(true);
    expect(plan.command.some((value) => value.endsWith("run-expanded-agent-benchmark.mjs"))).toBe(true);
    expect(plan.command).toContain("urdira-typescript");
    expect(plan.environment).toMatchObject({ URDIRA_SEMANTIC_INDEX: "0", URDIRA_SEMANTIC_MATERIALIZATION: "0", URDIRA_SEMANTIC_SIDECAR: "0", URDIRA_INDEXING_CORE_WORKER_PATH: "/worker", production_mcp_instructions: true });
  });

  it("retains failed runs and parses daemon operation/page telemetry without rerunning", () => {
    const post = collectPostMeasurements({
      audit: { runs: [{ run_id: "vscode-task-urdira-typescript-1", repository: "vscode", task: "x", arm: "urdira-typescript", sample: 1, exit_code: 1, failure: "host failed", manifest: { completed_successfully: false, host_metrics: null } }] },
      output: "/tmp/does-not-exist-post-index",
    });
    expect(post.rerun_competitors).toBe(false);
    expect(post.runs[0]).toMatchObject({ completed_successfully: false, failure: "host failed", daemon_telemetry: { operation_metrics: [], operation_page_metrics: [] } });
  });

  it("retains grader and process failure status when the manifest has no failure text", () => {
    const post = collectPostMeasurements({
      audit: { runs: [{ run_id: "prisma-task-urdira-typescript-1", repository: "prisma", task: "x", arm: "urdira-typescript", sample: 1, exit_code: 0, manifest: { completed_successfully: false, exit_code: 0, grader_exit_code: 1, host_metrics: null } }] },
      output: "/tmp/does-not-exist-post-index",
    });
    expect(post.runs[0]).toMatchObject({ completed_successfully: false, failure: "run failed (exit_code=0, grader_exit_code=1)" });
  });

  it("propagates protocol-aware MCP component bytes from a real transcript fixture", () => {
    const output = mkdtempSync(join(tmpdir(), "post-index-transcript-"));
    mkdirSync(join(output, "runs"));
    const fixturePath = join(process.cwd(), "tests/fixtures/urdira-mcp-context-real-shape.json");
    const runId = "vscode-language-registry-change-notification-urdira-typescript-1";
    const transcriptPath = join(output, "runs", `${runId}.jsonl`);
    const hostPath = join(output, "runs", `${runId}.host.log`);
    writeFileSync(transcriptPath, `${JSON.stringify(JSON.parse(readFileSync(fixturePath, "utf8")))}\n`);
    writeFileSync(hostPath, "");
    try {
      const post = collectPostMeasurements({
        audit: { runs: [{ run_id: runId, repository: "vscode", task: "language-registry-change-notification", arm: "urdira-typescript", sample: 1, manifest: { completed_successfully: true, transcript: transcriptPath, host_log: hostPath } }] },
        output,
      });
      expect(post.runs[0].transcript_metrics.mcp_component_bytes).toMatchObject({
        tool_envelope: expect.any(Number),
        model_visible_serialized: expect.any(Number),
        source_text: expect.any(Number),
        records: expect.any(Number),
        hydration: null,
        evidence: null,
        registry: null,
      });
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
