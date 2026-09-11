import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("expanded agent report", () => {
  it("separates recoverable selector narrowing from unexpected MCP failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-report-"));
    const transcript = join(root, "run.jsonl");
    const workspaceId = "workspace:test";
    const scope = { scope_type: "single_workspace", workspace_id: workspaceId };
    const query = (status: "completed" | "failed", result: unknown) => ({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "urdira",
        tool: "urdira_query",
        status,
        arguments: { request_type: "query", query: { api_version: 3, scope, expression: { expression_type: "operation", operation: "core:search_text" } } },
        result,
      },
    });
    const events = [
      query("completed", { content: [{ type: "text", text: "# 1 result" }] }),
      query("failed", { content: [{ type: "text", text: '{"error":{"code":"core:selector_ambiguous"}}' }] }),
      query("failed", { content: [{ type: "text", text: '{"error":{"code":"core:execution_resource_limit"}}' }] }),
      query("completed", { content: [{ type: "text", text: "no results\nhint: narrow the pattern" }] }),
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      query("completed", { content: [{ type: "text", text: "# 2 results" }] }),
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 1 } },
    ];
    await writeFile(transcript, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const auditPath = join(root, "audit.json");
    const timingSidecar = join(root, "run.timing.json");
    await writeFile(timingSidecar, `${JSON.stringify({
      schema_version: 1,
      turns: [{ label: "turn-1", line_count: 2, malformed_lines: 0, calls: [{ item_id: "mcp-1", kind: "mcp", server: "urdira", tool: "urdira_query", status: "completed", pairing_status: "paired", duration_ms: 7 }] }],
      mcp_calls: [{ item_id: "mcp-1", kind: "mcp", server: "urdira", tool: "urdira_query", status: "completed", pairing_status: "paired", duration_ms: 7 }],
      command_calls: [],
      aggregates: { mcp_by_tool: { urdira_query: { calls: 1, paired_calls: 1, total_duration_ms: 7, p95_duration_ms: 7 } }, commands_by_command: {} },
    }, null, 2)}\n`, "utf8");
    await writeFile(auditPath, `${JSON.stringify({
      campaign_id: "test",
      model: "test",
      expected_runs: 1,
      independent_campaigns: 1,
      arms: ["urdira-typescript"],
      repositories: [{ id: "repo", repository: "owner/repo", commit: "abc", tasks: [{ id: "task", complexity: "medium" }] }],
      runs: [{
        run_id: "run",
        repository: "repo",
        task: "task",
        arm: "urdira-typescript",
        sample: 1,
        exit_code: 0,
        process_metrics: { scope: "cell_runner_process_tree", peak_rss_kib: 4321, peak_process_count: 4, mean_cpu_percent: 25, sample_count: 3, duration_ms: 5 },
        manifest: {
          completed_successfully: true,
          transcript,
          timing_sidecar: timingSidecar,
          setup_elapsed_ms: 1,
          elapsed_ms_from_first_instruction: 2,
          setup: { semantic_index: false, readiness: "structural" },
          host_metrics: {
            readiness_boundary: "structural",
            structural_readiness_ms: 123,
            semantic_index: false,
            semantic_materialization: false,
            semantic_sidecar_created: false,
            semantic_sqlite_bytes: 0,
            catalog_sqlite_bytes: 10,
            lexical_sqlite_bytes: 20,
            structural_store_bytes: 30,
            rust_sidecar_bytes: 40,
            cas_bytes: 50,
          },
          correctness: { evidence: {
            changed_paths: true,
            focused_test_changed: true,
            diff_clean: true,
            required_patterns: { expected: true },
            fallback_shell: false,
            first_discovery_before_edit: true,
            rediscovery_after_edit: true,
          } },
        },
      }],
    }, null, 2)}\n`, "utf8");

    const comparisonPath = join(root, "comparison.json");
    await writeFile(comparisonPath, `${JSON.stringify({ runs: [] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [
      resolve("release/benchmarks/render-expanded-agent-report.mjs"),
      "--audit", auditPath,
      "--comparison-report", comparisonPath,
      "--output", output,
    ]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({
      mcp_discovery_calls: 5,
      mcp_discovery_successful_calls: 3,
      mcp_selector_ambiguous_calls: 1,
      mcp_resource_limit_calls: 1,
      mcp_unexpected_failed_calls: 0,
      mcp_empty_discovery_calls: 1,
      mcp_useful_discovery_calls: 2,
      api_v3_discovery_calls: 5,
      explicit_workspace_discovery_calls: 5,
      composition_metrics: { composition_shape_valid: null, pipeline_calls: 0, recipe_calls: 0, direct_operation_calls: 5 },
      shell_output_characters: null,
      tgrep_output_characters: null,
      target_attributed_characters: null,
      discovery_adoption: { zero_mcp: false },
    });
    expect(report.runs[0].metrics.tool_output_characters).toBeGreaterThan(0);
    expect(report).toMatchObject({
      report_version: 2,
      task_comparisons: [{
        structural_readiness_ms: 123,
        semantic_index_enabled: false,
        semantic_sidecar_created: false,
        process_tree_peak_rss_kib: 4321,
        mcp_timing: { urdira_query: { calls: 1, paired_calls: 1, total_duration_ms: 7, p95_duration_ms: 7 } },
      }],
    });
    expect(report.measurement_contract.readiness).toContain("Semantic indexing");
    const markdown = await readFile(`${output}.md`, "utf8");
    expect(markdown).toContain("working code-intelligence alternative");
    expect(markdown).toContain("Semantic sidecar created");
    expect(markdown).toContain("Process-tree peak RSS KiB");
    expect(markdown).toContain("External Codex call timing");
    expect(markdown).toContain("7.0");
  });
});
