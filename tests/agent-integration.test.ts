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

  it("bridges Cursor Grep and Search Files through preToolUse", async () => {
    const bridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { matches: [{ body: { path: "src/a.ts", text: "foo" }, evidence: [{ line: 1 }] }] } } } };
    const grep = await runAgentHook({ client: "cursor", tool_name: "Grep", cwd: "/workspace", tool_input: { pattern: "foo" }, max_output: 1000 }, bridge);
    expect(grep).toMatchObject({ permission: "deny", agent_message: "src/a.ts:1:foo" });
    const files = await runAgentHook({ client: "cursor", tool_name: "Search Files", cwd: "/workspace", tool_input: { query: "src/**/*.ts" }, max_output: 1000 }, { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { artifacts: [{ body: { path: "src/a.ts" } }] } } } });
    expect(files).toMatchObject({ permission: "deny", agent_message: "src/a.ts" });
    const semanticBridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { candidates: [{ body: { path: "src/a.ts" } }] } } } };
    await expect(runAgentHook({ client: "cursor", tool_name: "Codebase", cwd: "/workspace", tool_input: { query: "foo" } }, semanticBridge)).resolves.toMatchObject({ permission: "deny", agent_message: "src/a.ts" });
  });

  it("installs and removes a Cursor hook", async () => {
    const home = `/tmp/urdira-cursor-agent-test-${process.pid}`;
    try {
      const installed = await installAgent("cursor", { dry_run: false, confirm: true, home });
      expect(installed.changed).toBe(true);
      const hooks = JSON.parse(await readFile(`${home}/.cursor/hooks.json`, "utf8"));
      expect(hooks.version).toBe(1);
      expect(hooks.hooks.preToolUse[0]).toMatchObject({ matcher: "^(Grep|Search Files|Codebase)$", command: expect.stringContaining("--client cursor") });
      const removed = await uninstallAgent("cursor", { dry_run: false, confirm: true, home });
      expect(removed.changed).toBe(true);
      expect(JSON.parse(await readFile(`${home}/.cursor/hooks.json`, "utf8")).hooks.preToolUse).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("installs and removes the supported MCP clients without touching unrelated servers", async () => {
    const home = `/tmp/urdira-mcp-agents-${process.pid}`;
    const workspace = `${home}/workspace`;
    try {
      const vscode = await installAgent("vscode", { dry_run: false, confirm: true, home });
      expect(vscode.changed).toBe(true);
      expect(await readFile(`${home}/.copilot/hooks/urdira.json`, "utf8")).toContain("--client vscode");
      const cline = await installAgent("cline", { dry_run: false, confirm: true, home });
      expect(cline.changed).toBe(true);
      const clineConfig = JSON.parse(await readFile(`${home}/.cline/data/settings/cline_mcp_settings.json`, "utf8"));
      expect(clineConfig.mcpServers.urdira).toMatchObject({ command: "urdira", args: ["mcp"] });
      const roo = await installAgent("roo", { dry_run: false, confirm: true, home, workspace });
      expect(roo.changed).toBe(true);
      expect(JSON.parse(await readFile(`${workspace}/.roo/mcp.json`, "utf8"))).toHaveProperty("mcpServers.urdira");
      const desktop = await installAgent("claude-desktop", { dry_run: false, confirm: true, home });
      expect(desktop.changed).toBe(true);
      const desktopPath = process.platform === "darwin" ? `${home}/Library/Application Support/Claude/claude_desktop_config.json` : process.platform === "win32" ? `${home}/AppData/Roaming/Claude/claude_desktop_config.json` : `${home}/.config/Claude/claude_desktop_config.json`;
      expect(JSON.parse(await readFile(desktopPath, "utf8"))).toHaveProperty("mcpServers.urdira");
      await uninstallAgent("vscode", { dry_run: false, confirm: true, home });
      await uninstallAgent("cline", { dry_run: false, confirm: true, home });
      await uninstallAgent("roo", { dry_run: false, confirm: true, home, workspace });
      await uninstallAgent("claude-desktop", { dry_run: false, confirm: true, home });
      expect(JSON.parse(await readFile(`${home}/.cline/data/settings/cline_mcp_settings.json`, "utf8"))).toEqual({ mcpServers: {} });
      expect(JSON.parse(await readFile(`${workspace}/.roo/mcp.json`, "utf8"))).toEqual({ mcpServers: {} });
    } finally { await rm(home, { recursive: true, force: true }); }
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
