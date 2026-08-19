import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installAgent, runIsolatedDiscoveryDigest, runAgentHook, translateAgentSearch, uninstallAgent } from "../packages/cli/src/agent-integration.js";

describe("coding-agent bridge", () => {
  it("fails open for unsupported Grep modes", async () => {
    const decision = await translateAgentSearch({ client: "codex", operation: "grep", working_directory: "/workspace", native_arguments: { pattern: "x", count: true }, host_output_limit: 1000 }, { call: async () => ({ outcome: "success", payload: {} }) });
    expect(decision).toEqual({ decision: "fallback", fallback_reason: "unsupported_input" });
  });

  it("fails open when the indexed answer is incomplete or truncated", async () => {
    const bridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { completeness: { overall_status: "partial" }, truncated: true, streams: { matches: [] } } } };
    await expect(translateAgentSearch({ client: "codex", operation: "grep", working_directory: "/workspace", native_arguments: { pattern: "x" }, host_output_limit: 1000 }, bridge)).resolves.toMatchObject({ decision: "fallback", fallback_reason: "stale_index" });
  });

  it("translates a bounded Glob request to find_artifacts", async () => {
    const calls: unknown[] = [];
    const decision = await translateAgentSearch({ client: "claude-code", operation: "glob", working_directory: "/workspace", native_arguments: { pattern: "src/**/*.ts" }, host_output_limit: 1000 }, { call: async (name, payload) => { calls.push({ name, payload }); return name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { artifacts: [{ body: { path: "src/a.ts" } }] } } }; } });
    expect(decision.decision).toBe("serve");
    expect(decision.output).toBe("src/a.ts");
    expect(JSON.stringify(calls)).toContain("core:find_artifacts");
  });

  it("installs and removes only managed user entries", async () => {
    const home = `/tmp/urdira-agent-test-${process.pid}`;
    try {
      const preview = await installAgent("codex", { dry_run: true, confirm: false, home });
      expect(preview.dry_run).toBe(true);
      const installed = await installAgent("codex", { dry_run: false, confirm: true, home });
      expect(installed.changed).toBe(true);
      const hooks = JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8"));
      expect(hooks.hooks.PreToolUse[0]).toMatchObject({ matcher: "^(Grep|Glob|Bash)$", hooks: [{ type: "command" }] });
      const removed = await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      expect(removed.changed).toBe(true);
      expect(JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8")).hooks.PreToolUse).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("fails open for compound Codex shell commands and translates simple rg", async () => {
    const fallback = await runAgentHook({ client: "codex", tool_name: "Bash", tool_input: { command: "rg foo | head" } }, { call: async () => ({ outcome: "success" }) });
    expect(fallback).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const served = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg -i -g '*.ts' foo src" }, max_output: 1000 }, { call: async (name, payload) => { calls.push({ name, payload }); return name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { matches: [{ body: { path: "src/a.ts", text: "foo" }, evidence: [{ line: 1 }] }] } } }; } });
    expect(served).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(calls.some((call) => call.name === "core:query" && JSON.stringify(call.payload).includes("core:search_text"))).toBe(true);
  });

  it("keeps multi-query discovery inside a child context and returns only a bounded digest", async () => {
    let childCalls = 0;
    const bridge = { call: async () => ({ outcome: "success", payload: { streams: { matches: [{ path: "src/a.ts", line: 4 }] } } }) };
    const digest = await runIsolatedDiscoveryDigest({ run: async (operation) => { childCalls += 1; return operation(bridge); } }, bridge, "ws-1", [{ api_version: 1 }]);
    expect(childCalls).toBe(1);
    expect(digest.workspace_id).toBe("ws-1");
    expect(digest.findings.length).toBeLessThanOrEqual(8);
    expect(digest.incomplete_work).toEqual([]);
  });
});
