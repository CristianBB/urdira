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
        tool: "urdira_query",
        status,
        arguments: { request_type: "query", query: { api_version: 3, scope } },
        result,
      },
    });
    const events = [
      query("completed", { content: [{ type: "text", text: "# 1 result" }] }),
      query("failed", { content: [{ type: "text", text: '{"error":{"code":"core:selector_ambiguous"}}' }] }),
      query("completed", { content: [{ type: "text", text: "no results\nhint: narrow the pattern" }] }),
      { type: "item.completed", item: { type: "file_change", status: "completed" } },
      query("completed", { content: [{ type: "text", text: "# 2 results" }] }),
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, reasoning_output_tokens: 1 } },
    ];
    await writeFile(transcript, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const auditPath = join(root, "audit.json");
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
        manifest: {
          completed_successfully: true,
          transcript,
          setup_elapsed_ms: 1,
          elapsed_ms_from_first_instruction: 2,
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
      mcp_discovery_calls: 4,
      mcp_discovery_successful_calls: 3,
      mcp_selector_ambiguous_calls: 1,
      mcp_unexpected_failed_calls: 0,
      mcp_empty_discovery_calls: 1,
      mcp_useful_discovery_calls: 2,
      api_v3_discovery_calls: 4,
      explicit_workspace_discovery_calls: 4,
    });
    expect(await readFile(`${output}.md`, "utf8")).toContain("working code-intelligence alternative");
  });
});
