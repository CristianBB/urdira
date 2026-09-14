import { describe, expect, it } from "vitest";
import { analyzeExpandedTranscript, analyzeContextEfficiency, isShellSourceReadCommand } from "../release/benchmarks/expanded-agent-transcript-metrics.mjs";

const task = {
  required_patterns: [{ path: "src/services/transpile.ts", regex: "onDiagnostic" }],
};

describe("expanded agent transcript metrics", () => {
  it("accounts for all completed transport text without adding tgrep twice", () => {
    const events = [
      { type: "item.started", item: { type: "command_execution", command: "pnpm test", aggregated_output: "ignored" } },
      { type: "item.completed", item: { type: "mcp_tool_call", tool: "urdira_index_status", result: { content: [{ type: "text", text: "ready" }, { type: "text", text: "yes" }] } } },
      { type: "item.completed", item: { type: "command_execution", command: "pnpm test", aggregated_output: "passed", stdout: "passed", exit_code: 0 } },
      { type: "item.completed", item: { type: "command_execution", command: "tgrep name src; cat src/a.ts", aggregated_output: "source", exit_code: 0 } },
      { type: "item.completed", item: { type: "command_execution", command: "cat /tmp/.codex/skills/example/SKILL.md", aggregated_output: "rules", exit_code: 0 } },
    ];
    expect(analyzeExpandedTranscript(events, "tgrep", task)).toMatchObject({
      completed_tool_output: {
        mcp: { calls: 1, missing_output_calls: 0, characters: 8, known_characters: 8 },
        shell: { calls: 3, missing_output_calls: 0, characters: 17, known_characters: 17 },
        tgrep: { calls: 1, characters: 6 },
        total_characters: 25,
        full_model_context_characters: null,
      },
      repository_context_characters: 6,
    });
  });

  it("distinguishes absent transport output from explicitly empty output", () => {
    const metrics = analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "mcp_tool_call", result: { content: [] } } },
      { type: "item.completed", item: { type: "mcp_tool_call" } },
      { type: "item.completed", item: { type: "command_execution", command: "git status", aggregated_output: "" } },
      { type: "item.completed", item: { type: "command_execution", command: "git status" } },
    ], "baseline", task);
    expect(metrics).toMatchObject({ completed_tool_output: {
      mcp: { calls: 2, missing_output_calls: 1, known_characters: 0, characters: null },
      shell: { calls: 2, missing_output_calls: 1, known_characters: 0, characters: null },
      tgrep: { calls: 0, characters: null }, total_characters: null,
    } });
    expect(analyzeExpandedTranscript([], "baseline", task)).toMatchObject({ completed_tool_output: { total_characters: null } });
  });

  it("does not invent text for structured-only or malformed MCP output", () => {
    expect(analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "mcp_tool_call", result: { structured_content: { value: "not attested text" } } } },
      { type: "item.completed", item: { type: "mcp_tool_call", result: { content: [{ type: "text" }] } } },
    ], "baseline", task)).toMatchObject({ completed_tool_output: { mcp: { missing_output_calls: 2, characters: null }, total_characters: null } });
  });

  it("reuses prior exact script evidence without guessing another script or masked exit", () => {
    const commands = [
      ["/bin/zsh -lc 'npm run check-local -- case'", "> node runner.js test --grep case", 1],
      ["/bin/zsh -lc 'npm run check-local -- case'", "1 passed", 0],
      ["/bin/zsh -lc 'npm run check-local -- case && git diff --check'", "1 passed", 0],
      ["/bin/zsh -lc 'npm run check-local -- case && git diff --check'", "diff failed", 1],
      ["/bin/zsh -lc 'npm run check-local -- another-case'", "1 passed", 0],
      ["npm run test-sounding-name", "1 passed", 0],
    ];
    const events = commands.map(([command, aggregated_output, exit_code]) => ({ type: "item.completed", item: { type: "command_execution", command, aggregated_output, exit_code } }));
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({ test_attempts: 4, test_passes: 2, test_failures: 1, test_results_unknown: 1 });
  });

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
      hook_error_count: 0,
      unclassified_action_count: 0,
      repository_read_calls: 0,
      observed_tool_usage: { mcp_calls: 0, shell_calls: 0 },
    });
  });

  it("distinguishes hook failures from hook-trust warnings", () => {
    const events = [
      { type: "item.completed", item: { type: "error", message: "--dangerously-bypass-hook-trust is enabled. Enabled hooks may run without review." } },
      { type: "item.completed", item: { type: "error", message: "Command blocked by PreToolUse hook: runtime unavailable" } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)["hook_error_count"]).toBe(1);
  });

  it("counts hook-served repository searches as Urdira use without inventing MCP or shell transport", () => {
    const events = [
      { type: "item.completed", item: { type: "error", message: "Command blocked by PreToolUse hook: [urdira hook served]\nsrc/services/transpile.ts:10:onDiagnostic" } },
      { type: "item.completed", item: { type: "error", message: "Command blocked by PreToolUse hook: runtime unavailable" } },
      { type: "item.completed", item: { type: "error", message: "--dangerously-bypass-hook-trust is enabled. Enabled hooks may run without review." } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
      repository_read_calls: 1,
      configured_repository_read_calls: 1,
      repository_context_characters: 41,
      output_characters_by_method: { mcp: null, hook: 41, shell: null },
      observed_tool_usage: {
        mcp_calls: 0,
        urdira_hook_calls: 1,
        urdira_effective_calls: 1,
        shell_calls: 0,
      },
      discovery_adoption: { zero_mcp: true, zero_urdira_effective_use: false },
      context_lead: { first_repository_discovery_transport: "hook" },
      hook_error_count: 1,
    });
  });

  it("counts audited hook interceptions even when the native command falls back", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "rg needle src", aggregated_output: "src/a.ts:1:needle", exit_code: 0, status: "completed" } },
    ];
    const metrics = analyzeExpandedTranscript(events, "urdira-typescript", task, {
      hook_audit: [{ decision: "fallback", fallback_reason: "output_overflow" }],
    });
    expect(metrics).toMatchObject({
      observed_tool_usage: {
        urdira_hook_calls: 1,
        urdira_hook_served_calls: 0,
        urdira_hook_fallback_calls: 1,
        urdira_hook_fallback_reasons: { output_overflow: 1 },
        urdira_effective_calls: 1,
      },
      discovery_adoption: { zero_urdira_effective_use: false },
    });
  });

  it("counts model-visible UserPromptSubmit context from the audit sidecar", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,20p' src/a.ts", aggregated_output: "native", exit_code: 0, status: "completed" } },
    ];
    const metrics = analyzeExpandedTranscript(events, "urdira-typescript", task, {
      hook_audit: [
        { hook_event_name: "UserPromptSubmit", operation: "context", decision: "serve", output_characters: 1200 },
        { hook_event_name: "PreToolUse", operation: "grep", decision: "serve", output_characters: 100 },
      ],
    });
    expect(metrics).toMatchObject({
      repository_read_calls: 2,
      configured_repository_read_calls: 1,
      repository_context_characters: 1206,
      hook_output_characters: 1200,
      output_characters_by_method: { hook: 1200, shell: 6 },
      context_lead: {
        first_repository_discovery_transport: "hook",
        configured_calls_before_first_edit: 1,
        configured_characters_before_first_edit: 1200,
        hook_calls_before_first_edit: 1,
        hook_characters_before_first_edit: 1200,
      },
    });
  });

  it("attributes replacement-file bytes to the serving hook without double-counting shell output", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "rg --files src && cat '/tmp/urdira-hook-output-abc/result.txt'", aggregated_output: "native\n[urdira hook served]\nhooked", exit_code: 0, status: "completed" } },
    ];
    const metrics = analyzeExpandedTranscript(events, "urdira-typescript", task, {
      hook_audit: [{ hook_event_name: "PreToolUse", operation: "grep", decision: "serve", output_characters: 6 }],
    });

    expect(metrics).toMatchObject({
      repository_context_characters: 13,
      hook_output_characters: 6,
      shell_output_characters: 7,
      output_characters_by_method: { hook: 6, shell: 7 },
      configured_repository_read_calls: 1,
      context_lead: { configured_characters_before_first_edit: 6, configured_character_share_before_first_edit: 6 / 13 },
      observed_tool_usage: { urdira_hook_served_calls: 1, shell_calls: 1 },
    });
  });

  it("keeps direct MCP and hook-served Urdira calls separate and counts each observed use once", () => {
    const events = [
      { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_context", arguments: {}, result: { content: [{ type: "text", text: "direct" }] }, status: "completed" } },
      { type: "item.completed", item: { type: "error", message: "Command blocked by PreToolUse hook: [urdira hook served]\nhooked" } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
      repository_read_calls: 2,
      configured_repository_read_calls: 2,
      observed_tool_usage: { mcp_calls: 1, urdira_hook_calls: 1, urdira_effective_calls: 2, shell_calls: 0 },
    });
  });

  it("recognizes test executable paths and keeps newline-masked exits unknown", () => {
    const run = (command: string) => analyzeExpandedTranscript([{ type: "item.completed", item: { type: "command_execution", command, aggregated_output: "", exit_code: 0 } }], "urdira-typescript", task);
    expect(run("node_modules/.bin/vitest run test.ts")).toMatchObject({ test_attempts: 1, test_passes: 1 });
    expect(run("/tools/bin/pytest test.py\ntrue")).toMatchObject({ test_attempts: 1, test_passes: 0, test_results_unknown: 1 });
    expect(run("cat node_modules/.bin/vitest")).toMatchObject({ test_attempts: 0 });
  });

  it("recognizes a custom package script from its emitted test command", () => {
    const metrics = analyzeExpandedTranscript([{ type: "item.completed", item: {
      type: "command_execution", command: "npm run check-local", exit_code: 0,
      aggregated_output: "> project check-local\n> node runner.js test --grep example\n1 passed",
    } }], "urdira-typescript", task);
    expect(metrics).toMatchObject({ test_attempts: 1, test_passes: 1 });
  });

  it("recognizes a Node CLI test behind a login shell without inventing a compound test exit", () => {
    const run = (command: string) => analyzeExpandedTranscript([
      { type: "item.completed", item: { type: "command_execution", command, aggregated_output: "1 passed", exit_code: 0 } },
    ], "urdira-typescript", task);
    expect(run("/bin/zsh -lc 'node ./tools/cli test --grep case'")).toMatchObject({ test_attempts: 1, test_passes: 1 });
    expect(run("/bin/zsh -lc 'node ./tools/cli test; true'")).toMatchObject({ test_attempts: 1, test_passes: 0, test_results_unknown: 1 });
  });

  it("recognizes VS Code's test-node package command", () => {
    const events = [
      { type: "item.completed", item: { type: "command_execution", command: "yarn test-node --grep LanguageFeatureRegistry", aggregated_output: "15019 passing\n1 failing", exit_code: 1 } },
    ];
    expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
      test_attempts: 1,
      test_passes: 0,
      test_failures: 1,
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


it("counts tgrep shell transport exactly once in total context", () => {
  const metrics = analyzeExpandedTranscript([{ type: "item.completed", item: { type: "command_execution", command: "tgrep name src; cat src/a.ts", aggregated_output: "some source", exit_code: 0 } }], "tgrep", task);
  expect(metrics).toMatchObject({ shell_output_characters: 11, tgrep_output_characters: 11, repository_context_characters: 11, observed_tool_usage: { shell_calls: 1, tgrep_calls: 1 } });
});


it("retains evidence-backed efficiency observations without guessing source use", () => {
  const text = 'details: {"primary_result":{"record_id":"r1"}}\nMORE: {"continuation":{"continuation_ref":"opaque"}}';
  const call = { type: "item.completed", item: { type: "mcp_tool_call", arguments: {}, result: { content: [{ type: "text", text }] } } };
  const metrics = analyzeContextEfficiency([call, { ...call, item: { ...call.item, arguments: { continuation: { continuation_ref: "opaque" } } } }]);
  expect(metrics).toMatchObject({ unique_record_ids: 1, record_id_occurrences: 2, unique_record_ratio: 0.5, exact_repeated_output_characters: text.length, continuations_offered: 1, continuations_consumed: 1, unused_hydration_characters: null, completeness_preserved: null });
});

it("resolves edited paths only against explicit workspace scope and separates failed continuation attempts", () => {
  const call = (text: string, extra = {}) => ({ type: "item.completed", item: { type: "mcp_tool_call", result: { content: [{ type: "text", text }] }, ...extra } });
  const events = [call('details: {"primary_result":{"record_id":"r","body":{"path":"src/a.ts"}}}\nMORE: {"continuation":{"continuation_ref":"ref"}}'), call("failure", { arguments: { continuation: { continuation_ref: "ref" } }, status: "failed" }), { type: "item.completed", item: { type: "file_change", changes: [{ path: "/repo/src/a.ts" }] } }];
  expect(analyzeContextEfficiency(events, { workspace_root: "/repo" })).toMatchObject({ continuations_attempted: 1, continuations_consumed: 0, used_artifact_positions: [{ path: "/repo/src/a.ts", first_typed_context_position: { event_index: 0, ordinal: 1 } }] });
  expect(analyzeContextEfficiency(events).used_artifact_positions?.[0]?.first_typed_context_position).toBeNull();
});

it("measures exact source-line overlap in shell reads without attributing source use", () => {
  const source = 'source:1 {"span":{"artifact_version_id":"v"}}\n    const shared = 1;\n    const other = 2;\ndetails: {}';
  const mcp = { type: "item.completed", item: { type: "mcp_tool_call", result: { content: [{ type: "text", text: source }] } } };
  const read = { type: "item.completed", item: { type: "command_execution", command: "cat src/a.ts", aggregated_output: "const shared = 1;\nnew source" } };
  expect(analyzeContextEfficiency([mcp, read])).toMatchObject({ shell_source_line_overlap_characters: 17, unused_hydration_characters: null });
  expect(analyzeContextEfficiency([mcp, { ...read, item: { ...read.item, command: "git diff | sed -n '1,20p'" } }]).shell_source_line_overlap_characters).toBe(0);
  expect(analyzeContextEfficiency([read]).shell_source_line_overlap_characters).toBeNull();
});

it("measures whether configured context leads while classifying later shell reads by overlap", () => {
  const events = [
    { type: "item.completed", item: { type: "mcp_tool_call", server: "urdira", tool: "urdira_context", status: "completed", result: { content: [{ type: "text", text: "source:1 {\"span\":{}}\n    const shared = 1;\n    const context = 2;" }] } } },
    { type: "item.completed", item: { type: "command_execution", command: "sed -n '1,20p' src/a.ts", aggregated_output: "const shared = 1;\nconst novel = 3;", exit_code: 0 } },
    { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts" }] } },
    { type: "item.completed", item: { type: "command_execution", command: "cat src/b.ts", aggregated_output: "only later verification", exit_code: 0 } },
  ];
  expect(analyzeExpandedTranscript(events, "urdira-typescript", task)).toMatchObject({
    context_lead: {
      first_repository_discovery_transport: "mcp",
      configured_before_shell: true,
      configured_calls_before_first_edit: 1,
      configured_characters_before_first_edit: 65,
      mcp_calls_before_first_edit: 1,
      shell_source_calls_before_first_edit: 1,
      mcp_characters_before_first_edit: 65,
      shell_source_characters_before_first_edit: 34,
      configured_character_share_before_first_edit: 65 / 99,
    },
    context_efficiency: { shell_source_reads: {
      total_calls: 2,
      before_first_mcp_calls: 0,
      after_first_mcp_calls: 2,
      overlapping_calls: 1,
      nonoverlapping_calls: 1,
    } },
  });
});

it("retains a source read combined with a diff review without counting the output twice", () => {
  const command = "cat src/a.ts; git diff | sed -n '1,20p'";
  expect(isShellSourceReadCommand(command)).toBe(true);
  expect(analyzeExpandedTranscript([{ type: "item.completed", item: { type: "command_execution", command, aggregated_output: "source and review", exit_code: 0 } }], "baseline", task)).toMatchObject({ repository_read_calls: 1, shell_output_characters: 17 });
});
