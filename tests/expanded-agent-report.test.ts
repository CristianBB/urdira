import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("expanded agent report", () => {
  it("uses the final counter when resumed Codex turns report cumulative thread usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-cumulative-"));
    const transcript = join(root, "run.jsonl");
    const hookAudit = join(root, "run.hook-audit.jsonl");
    const events = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4 } },
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.completed", usage: { input_tokens: 170, cached_input_tokens: 130, output_tokens: 18, reasoning_output_tokens: 7 } },
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.completed", usage: { input_tokens: 220, cached_input_tokens: 160, output_tokens: 25, reasoning_output_tokens: 9 } },
    ];
    await writeFile(transcript, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    await writeFile(hookAudit, `${JSON.stringify({ hook_event_name: "UserPromptSubmit", operation: "context", decision: "serve", output_characters: 1200 })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ campaign_id: "test", model: "test", expected_runs: 1, independent_campaigns: 1, arms: ["urdira-typescript"], repositories: [{ id: "repo", repository: "owner/repo", commit: "abc", tasks: [{ id: "task", complexity: "small" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "urdira-typescript", sample: 1, exit_code: 0, manifest: { completed_successfully: true, counter_mode: "cumulative", transcript, hook_audit_path: hookAudit, correctness: { evidence: {} } } }] }, null, 2)}\n`, "utf8");
    const comparisonPath = join(root, "comparison.json");
    await writeFile(comparisonPath, `${JSON.stringify({ runs: [] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--comparison-report", comparisonPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({
      input_tokens: 220,
      cached_input_tokens: 160,
      output_tokens: 25,
      reasoning_tokens: 9,
      token_usage_semantics: "cumulative_thread",
      hook_output_characters: 1200,
      observed_tool_usage: { urdira_hook_calls: 1, urdira_hook_served_calls: 1, urdira_effective_calls: 1 },
      discovery_adoption: { zero_urdira_effective_use: false },
    });
  });

  it("keeps missing token counters and derived cost unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-missing-usage-"));
    const transcript = join(root, "run.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 4 } })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, manifest: { completed_successfully: true, transcript } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({ input_tokens: 100, cached_input_tokens: null, output_tokens: 10, reasoning_tokens: 4, total_tokens: 114, estimated_cost_usd: null });
  });

  it("uses only matched host evidence when the manifest omits a direct counter mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-host-counter-evidence-"));
    const transcript = join(root, "run.jsonl");
    const usage = { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 4 };
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, manifest: { completed_successfully: true, transcript, token_counter_evidence: { status: "matched", counter_mode: "per_turn", source: { kind: "codex_host_session" } } } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({ token_usage_semantics: "per_turn", total_tokens: 114 });
  });

  it("keeps token aggregates and cost null when declared host evidence is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-missing-host-evidence-"));
    const transcript = join(root, "run.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1 } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3, reasoning_output_tokens: 1 } })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, manifest: { completed_successfully: true, transcript, counter_mode: null, token_counter_evidence: { status: "missing_host", counter_mode: null } } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({ input_tokens: null, total_tokens: null, estimated_cost_usd: null });
  });

  it("does not let a direct counter mode override mismatched host evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-counter-evidence-conflict-"));
    const transcript = join(root, "run.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1 } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3, reasoning_output_tokens: 1 } })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, manifest: { completed_successfully: true, transcript, counter_mode: "cumulative", token_counter_evidence: { status: "matched", counter_mode: "per_turn" } } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0].metrics).toMatchObject({ input_tokens: null, total_tokens: null, estimated_cost_usd: null });
  });

  it("does not report P95 from exactly three independent observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-p95-"));
    const transcript = join(root, "run.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 4 } })}\n`, "utf8");
    const runs = [1, 2, 3].map((sample) => ({ run_id: `run-${sample}`, repository: "repo", task: "task", arm: "baseline", sample, exit_code: 0, manifest: { completed_successfully: true, transcript, elapsed_ms_from_first_instruction: sample } }));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 3, independent_campaigns: 3, p95_eligible: true, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.groups["repo:task:baseline"].elapsed_ms_from_first_instruction.p95).toBeNull();
    expect(report.campaign_gate.p95_eligible).toBe(false);
  });

  it("rejects historical comparator rows when the current audit has the same cell", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-overlap-"));
    const transcript = join(root, "run.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 1 } })}\n`, "utf8");
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, manifest: { completed_successfully: true, transcript } }] })}\n`, "utf8");
    const comparisonPath = join(root, "comparison.json");
    await writeFile(comparisonPath, `${JSON.stringify({ runs: [{ run_id: "old", repository: "repo", task: "task", arm: "baseline" }] })}\n`, "utf8");
    await expect(execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--comparison-report", comparisonPath, "--output", join(root, "report")])).rejects.toThrow();
  });

  it("reports separate cold and warm readiness probes from the declared probe shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-readiness-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 0, independent_campaigns: 1, arms: [], repositories: [{ id: "repo", tasks: [] }], runs: [], readiness_probes: [
      { probe_id: "r1-cold", campaign: 1, repository: "repo", phase: "cold", structural_readiness_ms: 12, time_to_first_query_ms: 20, timestamps: { data_root_created: 1, source_ready: 2, structural_ready: 3, validated_first_query: 4, first_query_complete: 5 }, storage: { catalog_bytes: 10 }, process: { peak_rss_kib: 11 }, publication: { records: 12 }, freshness: { complete: true }, passed: true },
      { probe_id: "r1-warm", campaign: 1, repository: "repo", phase: "warm", structural_readiness_ms: 3, time_to_first_query_ms: 7, passed: true },
    ] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.readiness_gate).toMatchObject({ expected_probes: 2, observed_probes: 2, passed: true });
    expect(report.readiness_probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "cold", structural_readiness_ms: 12, timestamps: expect.objectContaining({ first_query_complete: 5 }), storage: { catalog_bytes: 10 }, process: { peak_rss_kib: 11 }, publication: { records: 12 }, freshness: { complete: true } }),
      expect.objectContaining({ phase: "warm", structural_readiness_ms: 3 }),
    ]));
  });

  it("keeps repository_id/task_id aliases and failed process outcomes visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-alias-failure-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository_id: "repo", task_id: "task", arm: "baseline", sample: 1, exit_code: 137, signal: "SIGKILL", manifest: { completed_successfully: false } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0]).toMatchObject({ repository: "repo", task: "task" });
    expect(report.runs[0].failure).toContain("137");
    expect(report.task_comparisons[0].failure_categories).toBeTruthy();
  });

  it("keeps a failed cell in the failure table when no detail field is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-undescribed-failure-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["baseline"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository: "repo", task: "task", arm: "baseline", sample: 1, exit_code: 0, grader_exit_code: 1, manifest: { completed_successfully: false, correctness: {} } }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const markdown = await readFile(`${output}.md`, "utf8");
    const failureSection = markdown.split("## Failures and recovery details\n", 2)[1]?.split("## Indexing and readiness evidence\n", 2)[0] ?? "";
    expect(failureSection).toContain("| repo | task | baseline |");
  });

  it("normalizes nested process results and preserves blocked-cell evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-nested-process-result-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 1, independent_campaigns: 1, arms: ["urdira-typescript"], repositories: [{ id: "repo", tasks: [{ id: "task" }] }], runs: [{ run_id: "run", repository_id: "repo", task_id: "task", arm: "urdira-typescript", sample: 1, model_invoked: null, result: { code: 1, signal: null, timed_out: true, stdout_path: "/retained/stdout.log", stdout_sha256: "a".repeat(64), stdout_bytes: 12, stderr_path: "/retained/stderr.log", stderr_sha256: "b".repeat(64), stderr_bytes: 34 }, manifest: null }] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.runs[0]).toMatchObject({ process_exit_code: 1, process_signal: null, process_timed_out: true, model_invoked: null, process_evidence: { stdout_path: "/retained/stdout.log", stdout_bytes: 12, stderr_path: "/retained/stderr.log", stderr_bytes: 34 } });
    const markdown = await readFile(`${output}.md`, "utf8");
    const failureSection = markdown.split("## Failures and recovery details\n", 2)[1]?.split("## Indexing and readiness evidence\n", 2)[0] ?? "";
    expect(failureSection).toContain("process exited with code 1");
  });

  it("does not pass an empty readiness gate without an explicit expected probe count", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-empty-gate-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 0, independent_campaigns: 1, arms: [], repositories: [], runs: [] })}\n`, "utf8");
    const output = join(root, "report");
    await execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", output]);
    const report = JSON.parse(await readFile(`${output}.json`, "utf8"));
    expect(report.readiness_gate.passed).toBe(false);
  });

  it("rejects a non-frozen renderer price override", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-expanded-price-card-"));
    const auditPath = join(root, "audit.json");
    await writeFile(auditPath, `${JSON.stringify({ generated_at: "2026-09-15", expected_runs: 0, independent_campaigns: 1, arms: [], repositories: [], runs: [] })}\n`, "utf8");
    await expect(execFileAsync(process.execPath, [resolve("release/benchmarks/render-expanded-agent-report.mjs"), "--audit", auditPath, "--output", join(root, "report")], { env: { ...process.env, BENCH_OUTPUT_USD_PER_MILLION: "0" } })).rejects.toThrow();
  });

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
        completed_tool_output: { mcp: { calls: 5 }, shell: { calls: 0, characters: null }, full_model_context_characters: null },
        structural_readiness_ms: 123,
        semantic_index_enabled: false,
        semantic_sidecar_created: false,
        process_tree_peak_rss_kib: 4321,
        mcp_timing: { urdira_query: { calls: 1, paired_calls: 1, total_duration_ms: 7, p95_duration_ms: 7 } },
      }],
    });
    expect(report.measurement_contract.readiness).toContain("Semantic indexing");
    const markdown = await readFile(`${output}.md`, "utf8");
    expect(markdown).toContain("primary repository-context source");
    expect(markdown).toContain("Configured share before edit");
    expect(markdown).not.toContain("with no native source-reading fallback");
    expect(markdown).toContain("Semantic sidecar created");
    expect(markdown).toContain("Process-tree peak RSS KiB");
    expect(markdown).toContain("External Codex call timing");
    expect(markdown).toContain("Completed transport text");
    expect(markdown).toContain("7.0");
  });
});
