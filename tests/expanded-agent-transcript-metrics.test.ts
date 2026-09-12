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

  it("excludes isolated Codex skill reads from repository context while retaining shell actions", () => {
    const metrics = analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,120p' /private/tmp/codex-home/.codex/skills/urdira-discovery/SKILL.md", aggregated_output: "skill guidance", exit_code: 0 } },
      { type: "item.completed", item: { type: "command_execution", command: "rg onDiagnostic src/services/transpile.ts", aggregated_output: "repo source", exit_code: 0 } },
    ], "baseline", task);
    expect(metrics).toMatchObject({
      repository_read_calls: 1,
      repository_context_characters: 11,
      host_instruction_read_calls: 1,
      host_instruction_context_characters: 14,
      observed_tool_usage: { shell_calls: 1, host_instruction_reads: 1 },
      action_counts: { command_execution: 2 },
    });
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

  it("separates tool and shell output, target attribution, protocol components, and fallback adoption", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_query", arguments: { path: "src/services/transpile.ts", query: { snippets: { mode: "inline" }, evidence: { evidence: "summary" }, registry: { registry: "used" } } }, result: { content: [{ type: "text", text: "target snippet evidence registry" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,20p' src/services/transpile.ts", aggregated_output: "target shell source", exit_code: 0 } },
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
      tool_output_characters: 32,
      shell_output_characters: 19,
      tgrep_output_characters: null,
      target_attributed_characters: 51,
      target_unattributed_characters: 0,
      output_characters_by_method: { mcp: 32, shell: 19, tgrep: null },
      context_component_characters: { snippets: 32, evidence: 32, registry: 32, hydration: null },
      discovery_adoption: { mcp_before_shell: true, shell_after_mcp: true, zero_mcp: false },
    });
  });

  it("uses null for unavailable component and method measurements", () => {
    const metrics = analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "command_execution", command: "rg -n onDiagnostic src/services/transpile.ts", aggregated_output: "match", exit_code: 0 } },
    ], "baseline", task);
    expect(metrics).toMatchObject({
      tool_output_characters: null,
      shell_output_characters: 5,
      tgrep_output_characters: null,
      target_attributed_characters: 5,
      target_unattributed_characters: 0,
      context_component_characters: { snippets: null, hydration: null, evidence: null, registry: null },
      discovery_adoption: { mcp_before_shell: null, shell_after_mcp: null, zero_mcp: true },
    });
  });

  it("reports completed Codex actions separately from repository reads", () => {
    const v6Like = [
      ...Array.from({ length: 6 }, () => ({ type: "item.completed", item: { type: "error", message: "hook trust warning" } })),
      ...Array.from({ length: 9 }, () => ({ type: "item.completed", item: { type: "web_search", query: "https://example.test/source" } })),
      ...Array.from({ length: 9 }, () => ({ type: "item.completed", item: { type: "file_change", status: "completed" } })),
    ];
    expect(analyzeExpandedTranscript(v6Like, "urdira-typescript", task)).toMatchObject({
      action_counts: { error: 6, web_search: 9, file_change: 9 },
      web_search_calls: 9,
      file_change_actions: 9,
      first_action_type: "web_search",
      integration_warning_count: 6,
      hook_error_count: 6,
      unclassified_action_count: 0,
      repository_read_calls: 0,
      observed_tool_usage: { mcp_calls: 0, shell_calls: 0 },
    });
  });

  it("keeps legacy reads stable while counting v5-like actions and unknown types", () => {
    const v5Like = [
      ...Array.from({ length: 2 }, () => ({ type: "item.completed", item: { type: "web_search", query: "source" } })),
      ...Array.from({ length: 6 }, () => ({ type: "item.completed", item: { type: "file_change", status: "completed" } })),
      ...Array.from({ length: 18 }, () => ({ type: "item.completed", item: { type: "command_execution", command: "rg -n target src/example.ts", aggregated_output: "src/example.ts:1:target", exit_code: 0 } })),
      { type: "item.completed", item: { type: "future_action", payload: { opaque: true } } },
    ];
    const metrics = analyzeExpandedTranscript(v5Like, "baseline", task);
    expect(metrics).toMatchObject({
      action_counts: { web_search: 2, file_change: 6, command_execution: 18, future_action: 1 },
      web_search_calls: 2,
      file_change_actions: 6,
      first_action_type: "web_search",
      unclassified_action_count: 1,
      repository_read_calls: 18,
      observed_tool_usage: { mcp_calls: 0, shell_calls: 18 },
    });
  });
});

import { readFileSync } from "node:fs";
import { classifyMcpResponseComponents } from "../release/benchmarks/expanded-agent-transcript-metrics.mjs";

describe("real Urdira MCP response component metrics", () => {
  it("parses the retained production text-content shape and keeps unavailable fields null", () => {
    const event = JSON.parse(readFileSync(new URL("./fixtures/urdira-mcp-context-real-shape.json", import.meta.url), "utf8"));
    const components = classifyMcpResponseComponents(event.item)!;
    expect(components).toMatchObject({
      tool_envelope: expect.any(Number),
      model_visible_serialized: expect.any(Number),
      source_text: expect.any(Number),
      records: expect.any(Number),
      hydration: null,
      evidence: null,
      registry: null,
      classification: { source_text: "indented_source_lines", records: "result_headers_and_record_lines" },
    });
    expect(components.model_visible_serialized).toBeGreaterThan(components.source_text!);
  });

  it("propagates component byte metrics through the transcript analyzer", () => {
    const event = JSON.parse(readFileSync(new URL("./fixtures/urdira-mcp-context-real-shape.json", import.meta.url), "utf8"));
    const metrics = analyzeExpandedTranscript([event], "urdira-typescript", { required_patterns: [{ path: "src/example.ts", regex: "target" }] });
    expect(metrics.mcp_component_bytes).toMatchObject({
      tool_envelope: expect.any(Number),
      model_visible_serialized: expect.any(Number),
      source_text: expect.any(Number),
      records: expect.any(Number),
      hydration: null,
      evidence: null,
      registry: null,
    });
  });
});
