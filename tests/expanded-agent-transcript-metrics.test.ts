import { describe, expect, it } from "vitest";
import { analyzeExpandedTranscript, isShellSourceReadCommand } from "../release/benchmarks/expanded-agent-transcript-metrics.mjs";

const task = {
  required_patterns: [{ path: "src/services/transpile.ts", regex: "onDiagnostic" }],
};

describe("expanded agent transcript metrics", () => {
  it("counts baseline repository context, target attribution, and real test outcomes", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "rg -n onDiagnostic src/services/transpile.ts", aggregated_output: "src/services/transpile.ts:10:onDiagnostic", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,80p' src/services/transpile.ts", aggregated_output: "onDiagnostic callback", exit_code: 0 } },
      { type: "item.completed", item: { type: "command_execution", command: "pnpm test -- transpile", aggregated_output: "1 passed", exit_code: 0 } },
      { type: "item.completed", item: { type: "command_execution", command: "pnpm test -- declaration", aggregated_output: "1 failed", exit_code: 1 } },
    ];
    expect(analyzeExpandedTranscript(events, "baseline", task)).toMatchObject({
      repository_read_calls: 2,
      repository_context_characters: 62,
      context_calls_attributed_to_declared_targets: 2,
      context_calls_unattributed_to_declared_targets: 0,
      assigned_discovery_before_edit: true,
      assigned_rediscovery_after_each_edit: true,
      test_attempts: 2,
      test_passes: 1,
      test_failures: 1,
      test_results_unknown: 0,
    });
  });

  it("records configured MCP usage and keeps unknown test exits explicit", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "codebase-memory", tool: "search_graph", arguments: { query: "onDiagnostic" }, result: { content: [{ type: "text", text: "src/services/transpile.ts" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "codebase-memory", tool: "get_code_snippet", arguments: {}, result: { content: [{ type: "text", text: "onDiagnostic" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "command_execution", command: "vitest run transpile", output: "passed", status: "completed" } },
    ];
    expect(analyzeExpandedTranscript(events, "codebase-memory", task)).toMatchObject({
      repository_read_calls: 2,
      assigned_discovery_before_edit: true,
      assigned_rediscovery_after_each_edit: true,
      test_attempts: 1,
      test_passes: 0,
      test_failures: 0,
      test_results_unknown: 1,
    });
  });

  it("records a natural shell fallback even when an MCP comparator is configured", () => {
    const metrics = analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "command_execution", command: "rg -n onDiagnostic src/services/transpile.ts", aggregated_output: "src/services/transpile.ts:10:onDiagnostic", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
    ], "codegraph", task);
    expect(metrics).toMatchObject({
      repository_read_calls: 1,
      configured_repository_read_calls: 0,
      observed_discovery_before_edit: true,
      observed_tool_usage: { mcp_calls: 0, shell_calls: 1, tgrep_calls: 0 },
    });
  });

  it("excludes Urdira bootstrap status from repository context reads", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_index_status", arguments: { workspace_root: "/repo" }, result: { content: [{ type: "text", text: "structural_ready" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_context", arguments: { task: "onDiagnostic" }, result: { content: [{ type: "text", text: "src/services/transpile.ts onDiagnostic" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_context", arguments: { task: "onDiagnostic" }, result: { content: [{ type: "text", text: "src/services/transpile.ts onDiagnostic" }] }, status: "completed" } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
      repository_read_calls: 2,
      assigned_discovery_before_edit: true,
      assigned_rediscovery_after_each_edit: true,
    });
  });

  it("does not classify git diff pager output as shell source discovery", () => {
    expect(isShellSourceReadCommand("/bin/zsh -lc \"git diff -- src/foo.ts | sed -n '1,120p'\"")).toBe(false);
    expect(isShellSourceReadCommand("sed -n '1,120p' src/foo.ts")).toBe(true);
  });

  it("counts tgrep searches as the assigned repository discovery method", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "tgrep onDiagnostic . --stats", aggregated_output: "src/services/transpile.ts:10:onDiagnostic", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      { type: "item.completed", item: { type: "command_execution", command: "tgrep onDiagnostic . --stats", aggregated_output: "src/services/transpile.ts:10:onDiagnostic", exit_code: 0 } },
    ];
    expect(analyzeExpandedTranscript(events, "tgrep", task)).toMatchObject({
      repository_read_calls: 2,
      assigned_tgrep_calls: 2,
      assigned_discovery_before_edit: true,
      assigned_rediscovery_after_each_edit: true,
    });
  });
});
