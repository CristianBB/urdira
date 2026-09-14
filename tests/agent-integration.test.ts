import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { agentStatus, installAgent, runIsolatedDiscoveryDigest, runAgentHook, translateAgentSearch, uninstallAgent } from "../packages/cli/src/agent-integration.js";

async function codexHookOutput(response: unknown): Promise<{ readonly command: string; readonly output: string }> {
  const command = (response as any).hookSpecificOutput?.updatedInput?.command ?? "";
  const paths = [...command.matchAll(/'([^']*urdira-hook-output-[^']*\/result\.txt)'/gu)].map((match) => match[1]!);
  const output = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
  await Promise.all(paths.map((path) => rm(path.slice(0, -"/result.txt".length), { recursive: true, force: true })));
  return { command, output };
}

describe("coding-agent bridge", () => {
  it("does not infer a hook's source scope from the integration process directory", async () => {
    let calls = 0;
    const response = await runAgentHook({ client: "codex", tool_name: "Grep", tool_input: { pattern: "example" } }, {
      call: async () => { calls++; return { outcome: "success" }; },
    });
    expect(calls).toBe(0);
    expect(response).toEqual({});
  });
  it("pins and upgrades the managed launcher independently of the host PATH", async () => {
    const home = `/tmp/urdira-agent-launcher-${process.pid}`;
    try {
      await mkdir(home, { recursive: true });
      const script = `${home}/current 'runtime.mjs`;
      await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      await installAgent("codex", { dry_run: false, confirm: true, home });
      const options = { dry_run: false, confirm: true, home, launcher: [process.execPath, script] };
      await installAgent("codex", options);
      await installAgent("codex", options);
      const config = JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8"));
      expect(config.hooks.PreToolUse).toHaveLength(1);
      const result = spawnSync('/bin/sh', ['-c', config.hooks.PreToolUse[0].hooks[0].command], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['agent', 'hook', '--client', 'codex']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("preserves Codex configuration while installing additive developer guidance", async () => {
    const home = `/tmp/urdira-codex-config-${process.pid}`;
    const path = `${home}/.codex/config.toml`;
    const original = '# user comment\nmodel = "user-model"\ndeveloper_instructions = "Keep my rule." # keep inline\n\n[features]\nshell_tool = true\n';
    try {
      await mkdir(`${home}/.codex`, { recursive: true });
      await writeFile(path, original);
      await installAgent("codex", { dry_run: false, confirm: true, home });
      const first = await readFile(path, "utf8");
      expect(first).toContain("An empty result is valid evidence, not missing coverage");
      expect(first).toContain("Keep my rule.");
      expect(first).toContain("# user comment");
      expect(first).toContain("# keep inline");
      expect(first).not.toContain("model_instructions_file");
      await installAgent("codex", { dry_run: false, confirm: true, home });
      expect(await readFile(path, "utf8")).toBe(first);
      await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      const restored = await readFile(path, "utf8");
      expect(restored).toContain('developer_instructions = "Keep my rule."');
      expect(restored).toContain('model = "user-model"');
      expect(restored).toContain("# keep inline");
      expect(restored).not.toContain("urdira-managed");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("rejects invalid Codex configuration before writing integration files", async () => {
    const home = `/tmp/urdira-codex-invalid-${process.pid}`;
    try {
      await mkdir(`${home}/.codex`, { recursive: true });
      const invalid = 'developer_instructions = ["invalid"]\n';
      await writeFile(`${home}/.codex/config.toml`, invalid);
      await expect(installAgent("codex", { dry_run: false, confirm: true, home })).rejects.toThrow("must be a string");
      await expect(readFile(`${home}/.codex/hooks.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(`${home}/.codex/config.toml`, "utf8")).toBe(invalid);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("preserves unrelated hooks sharing a managed matcher group", async () => {
    const home = `/tmp/urdira-codex-mixed-hooks-${process.pid}`;
    try {
      await installAgent("codex", { dry_run: false, confirm: true, home });
      const path = `${home}/.codex/hooks.json`;
      const hooks = JSON.parse(await readFile(path, "utf8"));
      hooks.hooks.PreToolUse[0].hooks.push({ type: "command", command: "user-hook" });
      await writeFile(path, JSON.stringify(hooks));
      await installAgent("codex", { dry_run: false, confirm: true, home });
      expect(await readFile(path, "utf8")).toContain("user-hook");
      await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      expect(JSON.parse(await readFile(path, "utf8")).hooks.PreToolUse).toEqual([
        { matcher: "^(Grep|Glob|Bash)$", hooks: [{ type: "command", command: "user-hook" }] },
      ]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("fails open for unsupported Grep modes", async () => {
    const decision = await translateAgentSearch({ client: "codex", operation: "grep", working_directory: "/workspace", native_arguments: { pattern: "x", count: true }, host_output_limit: 1000 }, { call: async () => ({ outcome: "success", payload: {} }) });
    expect(decision).toEqual({ decision: "fallback", fallback_reason: "unsupported_input" });
  });

  it("fails open when the indexed answer is incomplete or truncated", async () => {
    const bridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { completeness: { overall_status: "partial" }, truncated: true, streams: { matches: [] } } } };
    await expect(translateAgentSearch({ client: "codex", operation: "grep", working_directory: "/workspace", native_arguments: { pattern: "x" }, host_output_limit: 1000 }, bridge)).resolves.toMatchObject({ decision: "fallback", fallback_reason: "stale_index" });
  });

  it("accepts an equivalent complete structural snapshot as queryable", async () => {
    const bridge = { call: async (name: string) => name === "core:index_status"
      ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
      : { outcome: "success", payload: { freshness_status: "equivalent", completeness: { overall_status: "complete" }, streams: { matches: [{ body: { path: "src/a.ts", text: "Target" }, evidence: [{ line: 1 }] }] } } } };
    await expect(translateAgentSearch({ client: "codex", operation: "grep", working_directory: "/workspace", native_arguments: { pattern: "Target" }, host_output_limit: 1000 }, bridge)).resolves.toMatchObject({ decision: "serve", output: "src/a.ts:1:Target" });
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
      const legacySkill = `${home}/.codex/skills/urdira-discovery/SKILL.md`;
      await mkdir(`${home}/.codex/skills/urdira-discovery`, { recursive: true });
      await writeFile(legacySkill, "<!-- urdira-managed-agent-integration-v1 -->\nlegacy managed discovery skill\n");
      const preview = await installAgent("codex", { dry_run: true, confirm: false, home });
      expect(preview.dry_run).toBe(true);
      const installed = await installAgent("codex", { dry_run: false, confirm: true, home });
      expect(installed.changed).toBe(true);
      const hooks = JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8"));
      expect(hooks.hooks.PreToolUse[0]).toMatchObject({ matcher: "^(Grep|Glob|Bash)$", hooks: [{ type: "command" }] });
      const config = await readFile(`${home}/.codex/config.toml`, "utf8");
      expect(config).toContain("Begin repository discovery and source reading with Urdira");
      expect(config).toContain("urdira query --payload <json> --json");
      expect(config).toContain("Do not consume MORE or search alternative files");
      expect(config).toContain("redirect noisy successful build output to a temporary log");
      expect(config).toContain("do not use the reserved zsh parameter `status`");
      await expect(readFile(`${home}/.codex/AGENTS.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(agentStatus("codex", { home })).resolves.toMatchObject({ installed: true, managed_files: expect.arrayContaining([`${home}/.codex/config.toml`]) });
      const explorer = await readFile(`${home}/.codex/agents/urdira_explorer.toml`, "utf8");
      await expect(readFile(legacySkill, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(explorer).toMatch(/^# urdira-managed-agent-integration-v1\nname = "urdira_explorer"\ndescription = "Read-only bounded repository discovery via Urdira\."\ndeveloper_instructions = """\n[\s\S]+\n"""\n$/u);
      const instructionBlock = explorer.match(/^developer_instructions = """\n([\s\S]+)\n"""\n$/mu);
      expect(instructionBlock?.[1]).toContain("Start repository discovery with Urdira");
      expect(instructionBlock?.[1]).toContain("Before declaring Urdira unavailable, call the visible urdira_index_status tool");
      expect(instructionBlock?.[1]).toContain("Decide availability from that tool response only");
      expect(instructionBlock?.[1]).toContain("preserve its exact error");
      expect(explorer).toContain("Start repository discovery with Urdira");
      expect(explorer).toContain("continue pagination");
      expect(explorer).toContain("coverage is complete");
      expect(explorer).toContain("appropriate Urdira operation demonstrates a capability or coverage failure");
      const removed = await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      expect(removed.changed).toBe(true);
      expect(JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8")).hooks.PreToolUse).toEqual([]);
      await expect(readFile(`${home}/.codex/AGENTS.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("preserves unrelated global Codex instructions while removing the legacy duplicated managed block", async () => {
    const home = `/tmp/urdira-codex-global-test-${process.pid}`;
    try {
      await mkdir(`${home}/.codex`, { recursive: true });
      await writeFile(`${home}/.codex/AGENTS.md`, "USER_GLOBAL_RULE\n\n<!-- urdira-managed-agent-integration-v1:global-instructions -->\nOLD_DUPLICATE\n<!-- /urdira-managed-agent-integration-v1:global-instructions -->\n", { mode: 0o600 });
      await installAgent("codex", { dry_run: false, confirm: true, home });
      await installAgent("codex", { dry_run: false, confirm: true, home });
      const content = await readFile(`${home}/.codex/AGENTS.md`, "utf8");
      expect(content).toBe("USER_GLOBAL_RULE\n");
      expect(content).not.toContain("global-instructions");
      await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      await expect(readFile(`${home}/.codex/AGENTS.md`, "utf8")).resolves.toBe("USER_GLOBAL_RULE\n");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("fails open for compound Codex shell commands and translates simple rg", async () => {
    const fallback = await runAgentHook({ client: "codex", tool_name: "Bash", tool_input: { command: "rg foo | head" } }, { call: async () => ({ outcome: "success" }) });
    expect(fallback).toEqual({});
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const served = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg -i -g '*.ts' foo src" }, max_output: 1000 }, { call: async (name, payload) => { calls.push({ name, payload }); return name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { matches: [{ body: { path: "src/a.ts", text: "foo" }, evidence: [{ line: 1 }] }] } } }; } });
    expect(served).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: expect.stringMatching(/cat.*urdira-hook-output/u) } } });
    const replacement = (served as any).hookSpecificOutput.updatedInput.command as string;
    expect(replacement).not.toContain("src/a.ts:1:foo");
    expect(replacement).not.toContain("rm -");
    expect(spawnSync("/bin/sh", ["-c", replacement], { encoding: "utf8" }).stdout).toContain("[urdira hook served]\nsrc/a.ts:1:foo");
    const query = calls.find((call) => call.name === "core:query");
    expect(query).toBeDefined();
    expect(query?.payload).toMatchObject({ options: {
      evidence: { evidence: "none" },
      diagnostics: { diagnostics: "none" },
      registry: { registry: "none" },
    } });
  });

  it("keeps rg exclusion globs on the native path instead of turning them into positive filters", async () => {
    let calls = 0;
    const response = await runAgentHook({
      client: "codex",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "rg -n 'Target|TargetTest' packages tests --glob '!packages/generated/**'" },
      max_output: 10_000,
    }, {
      call: async (name) => {
        calls += 1;
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { matches: { items: [], has_next: false } } } };
      },
    });

    expect(response).toEqual({});
    expect(calls).toBe(0);
  });

  it("replaces complete recursive searches inside a semicolon command sequence", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({
      client: "codex",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "sed -n '1p' src/a.ts; grep -R \"setMode\" -n src/test | head -20; grep -R \"Registry\" -n src | head -20" },
      max_output: 2000,
    }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        if ((payload as any).expression?.operation === "core:get_source") return { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { sources: { items: [
          { value: { primary_result: { body: { path: "src/a.ts" } }, optional_source_snippets: [{ span: { start_line: "1" }, text: "const source = true;\n" }] } },
        ], has_next: false } } } };
        const pattern = ((payload as { expression?: { arguments?: { pattern?: string } } }).expression?.arguments?.pattern) ?? "unknown";
        return { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [
          { value: { primary_result: { body: { path: "src/result.ts", text: pattern }, source_span: { start_line: "7" } } } },
        ], has_next: false } } } };
      },
    });
    const { command, output } = await codexHookOutput(response);
    expect(command).not.toContain("sed -n '1p' src/a.ts");
    expect(command).not.toContain("grep -R");
    expect(output.match(/\[urdira hook served\]/g)).toHaveLength(3);
    expect(output).toContain("src/result.ts:7:setMode");
    expect(output).toContain("src/result.ts:7:Registry");
    expect(calls.filter((call) => call.name === "core:query")).toHaveLength(3);
  });

  it("preserves an indexed fallback reason for compound commands", async () => {
    const audit = `/tmp/urdira-compound-fallback-${process.pid}.jsonl`;
    const previous = process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"];
    process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"] = audit;
    try {
      const response = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg Target src; rg Provider src" }, max_output: 2000 }, {
        call: async (name) => name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { freshness_status: "equivalent", completeness: { overall_status: "partial" }, streams: { matches: [] } } },
      });
      expect(response).toEqual({});
      expect(JSON.parse((await readFile(audit, "utf8")).trim())).toMatchObject({ decision: "fallback", fallback_reason: "stale_index" });
    } finally {
      if (previous === undefined) delete process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"];
      else process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"] = previous;
      await rm(audit, { force: true });
    }
  });

  it("replaces repository searches and source reads inside conditional command sequences", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({
      client: "codex",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "git status --short && rg -n affectedTestFiles packages/playwright | head -200 && sed -n '10,30p' packages/playwright/src/compilationCache.ts" },
      max_output: 3000,
    }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        if ((payload as any).expression?.operation === "core:get_source") return { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { sources: { items: [
          { value: { primary_result: { body: { path: "packages/playwright/src/compilationCache.ts" } }, optional_source_snippets: [{ span: { start_line: "10" }, text: `${["function affectedTestFiles() {", "  return [];", "}", ...Array.from({ length: 18 }, (_, index) => `// line ${index + 13}`)].join("\n")}\n` }] } },
        ], has_next: false } } } };
        return { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [
          { value: { primary_result: { body: { path: "packages/playwright/src/compilationCache.ts", text: "affectedTestFiles" }, source_span: { start_line: 10 } } } },
        ], has_next: false } } } };
      },
    });
    const { command, output } = await codexHookOutput(response);
    expect(command).toMatch(/^git status --short && /u);
    expect(command).not.toContain("rg -n affectedTestFiles");
    expect(command).not.toContain("sed -n '10,30p'");
    expect(command.match(/ && /g)).toHaveLength(2);
    expect(output.match(/\[urdira hook served\]/g)).toHaveLength(2);
    expect(output).toContain("packages/playwright/src/compilationCache.ts:10:affectedTestFiles");
    expect(output).toContain("function affectedTestFiles()");
    expect(calls.filter((call) => call.name === "core:query")).toHaveLength(2);
  });

  it("falls through a semicolon sequence when one search cannot be served completely", async () => {
    let queryCalls = 0;
    const response = await runAgentHook({
      client: "codex",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "sed -n '1,20p' src/a.ts; grep -R needle -n src" },
      max_output: 2000,
    }, {
      call: async (name, payload) => name === "core:index_status"
        ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
        : (++queryCalls, (payload as any).expression?.operation === "core:get_source"
          ? { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { sources: { items: [{ value: { primary_result: { body: { path: "src/a.ts" } }, optional_source_snippets: [{ span: { start_line: "1" }, text: `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n` }] } }], has_next: false } } } }
          : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [{ value: { primary_result: { body: { path: "src/a.ts", text: "needle" } } } }], has_next: true } } } }),
    });
    expect(queryCalls).toBe(2);
    expect(response).toMatchObject({ hookSpecificOutput: { updatedInput: { command: expect.stringContaining("grep -R needle -n src") } } });
    expect((await codexHookOutput(response)).output).toContain("[urdira hook served]");
  });

  it("paginates a broad search inside a mixed semicolon sequence and preserves native checks", async () => {
    const response = await runAgentHook({
      client: "codex",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "rg -n Registry src | head -20; rg -n registry src; test -x node_modules/.bin/tsc && echo available || true" },
      max_output: 4000,
    }, {
      call: async (name, payload) => {
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        const pattern = ((payload as { expression?: { arguments?: { pattern?: string } } }).expression?.arguments?.pattern) ?? "unknown";
        return { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [
          { value: { primary_result: { body: { path: "src/result.ts", text: pattern }, source_span: { start_line: 7 } } } },
        ], has_next: pattern === "registry", ...(pattern === "registry" ? { next_cursor: "opaque.cursor" } : {}) } } } };
      },
    });
    const { command, output } = await codexHookOutput(response);
    expect(output).toContain("MORE:");
    expect(output).toContain("opaque.cursor");
    expect(command).toContain("test -x node_modules/.bin/tsc && echo available || true");
    expect(command).not.toMatch(/(?:^|;\s*)rg\s/u);
  });

  it("serves a simple Codex rg command with an explicit trailing head projection", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg -n 'formatWireName|parseWireName' src test | head -n 1" }, max_output: 1000 }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [
              { value: { path: "src/a.ts", text: "formatWireName", source_span: { start_line: 4 } } },
              { value: { path: "test/a.test.ts", text: "parseWireName", source_span: { start_line: 8 } } },
            ] } } } };
      },
    });
    const { output } = await codexHookOutput(response);
    expect(output).toContain("src/a.ts:4:formatWireName");
    expect(output).not.toContain("test/a.test.ts:8:parseWireName");
    expect(calls.find((call) => call.name === "core:query")?.payload).toMatchObject({ expression: { arguments: { filter: { paths: ["src", "test"] } } } });

    await expect(runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg foo | sed -n '1p'" } }, { call: async () => ({ outcome: "success" }) })).resolves.toEqual({});
  });

  it("translates quoted regex alternation and multiple paths without treating them as shell control", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg -n 'formatWireName|parseWireName' src test" }, max_output: 1000 }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [{ value: { path: "src/a.ts", text: "parseWireName", source_span: { start_line: 4 } } }] } } } };
      },
    });
    expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect((await codexHookOutput(response)).output).toContain("src/a.ts:4:parseWireName");
    expect(calls.find((call) => call.name === "core:query")?.payload).toMatchObject({ expression: { arguments: { filter: { paths: ["src", "test"] } } } });
  });

  it("serves a Codex rg command whose only redirection discards stderr", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({ client: "codex", hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg -n 'affectedTestFiles|collectAffectedTestFiles' packages tests 2>/dev/null" }, max_output: 2000 }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [{ value: { path: "src/a.ts", text: "affectedTestFiles", source_span: { start_line: 4 } } }] } } } };
      },
    });
    expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect((await codexHookOutput(response)).output).toContain("[urdira hook served]");
    expect(calls.find((call) => call.name === "core:query")?.payload).toMatchObject({ expression: { arguments: { filter: { paths: ["packages", "tests"] } } } });
  });

  it("serves a stderr-tolerant rg search before a trailing head projection within the host character budget", async () => {
    const calls: Array<{ readonly name: string; readonly payload: unknown }> = [];
    const response = await runAgentHook({
      client: "codex",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/workspace",
      tool_input: { command: "rg -n \"affectedTestFiles|export.*cc|const cc\" packages/playwright/src/common.ts packages/playwright/src packages/playwright-core/src 2>/dev/null | head -40" },
      max_output: 2_000,
    }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [
              { value: { path: "packages/playwright/src/common.ts", text: "export type Generated = " + "x".repeat(20_000), source_span: { start_line: 4 } } },
              { value: { path: "packages/playwright/src/transform/compilationCache.ts", text: "export const affectedTestFiles = new Set<string>();", source_span: { start_line: 8 } } },
            ], has_next: true, next_cursor: "opaque.cursor" } } } };
      },
    });
    const { command, output } = await codexHookOutput(response);
    expect(command).not.toContain("rg -n");
    expect(output).toContain("[urdira hook served]");
    expect(output.length).toBeLessThanOrEqual(2_000 + "[urdira hook served]\n".length);
    expect(calls.find((call) => call.name === "core:query")?.payload).toMatchObject({
      expression: { arguments: { filter: { paths: ["packages/playwright/src/common.ts", "packages/playwright/src", "packages/playwright-core/src"] } } },
      options: { response_budget: { max_characters: 2_000 } },
    });
  });

  it("serves a simple Codex sed source range from Urdira and preserves the requested projection", async () => {
    const calls: Array<{ readonly name: string; readonly payload: any }> = [];
    const response = await runAgentHook({ client: "codex", hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "sed -n '2,3p' src/target.ts" }, max_output: 2000 }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { sources: { items: [
          { value: { primary_result: { body: { path: "src/target.ts" } }, optional_source_snippets: [{ span: { artifact_version_id: "artv-1", start_line: "1", end_line: "4" }, text: "one\ntwo\nthree\nfour\n" }] } },
        ], has_next: false } } } };
      },
    });

    expect(calls[1]!.payload).toMatchObject({ expression: { expression_type: "operation", operation: "core:get_source", arguments: {
      subjects: [{ subject_type: "artifact", path: "src/target.ts" }],
      source: { mode: "body" },
    } } });
    const { output } = await codexHookOutput(response);
    expect(output).toContain("two\nthree");
    expect(output).not.toContain("one\n");
    expect(output).not.toContain("four\n");
  });

  it("records every Codex hook interception separately from whether Urdira served it", async () => {
    const home = `/tmp/urdira-hook-audit-${process.pid}`;
    const path = `${home}/audit.jsonl`;
    const previous = process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"];
    try {
      await mkdir(home, { recursive: true });
      process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"] = path;
      await runAgentHook({ client: "codex", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "call-1", cwd: "/workspace", tool_input: { command: "rg foo | head" } }, { call: async () => ({ outcome: "success" }) });
      const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries).toEqual([expect.objectContaining({
        schema_version: 1,
        client: "codex",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "call-1",
        operation: "grep",
        decision: "fallback",
        fallback_reason: "unsupported_input",
        output_characters: 0,
      })]);
    } finally {
      if (previous === undefined) delete process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"];
      else process.env["URDIRA_AGENT_HOOK_AUDIT_LOG"] = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renders real daemon bundles instead of serving a false empty search", async () => {
    const response = await runAgentHook({ client: "codex", tool_name: "Bash", cwd: "/workspace", tool_input: { command: "rg hookNeedle" }, max_output: 1000 }, {
      call: async (name: string) => name === "core:index_status"
        ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
        : { outcome: "success", payload: { completeness: { overall_status: "complete" }, streams: { matches: { items: [{ stable_sort_key: "match-1", value: {
            result_set: "matches",
            assessment: { classification: "confirmed", completeness: "complete" },
            primary_result: { body: { path: "src/a.ts", text: "const hookNeedle = true;" }, source_span: { start_line: "4" } },
          } }], has_next: false } } } },
    });
    expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect((await codexHookOutput(response)).output).toContain("[urdira hook served]\nsrc/a.ts:4:const hookNeedle = true;");
  });

  it("serves a paginated daemon result with an executable continuation and never hides truncation", async () => {
    const request = { client: "codex" as const, operation: "grep" as const, working_directory: "/workspace", native_arguments: { pattern: "hookNeedle" }, host_output_limit: 1000 };
    const bridge = (payload: unknown) => ({ call: async (name: string) => name === "core:index_status"
      ? { outcome: "success" as const, payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
      : { outcome: "success" as const, payload },
    });
    const item = { stable_sort_key: "match-1", value: { result_set: "matches", assessment: { classification: "confirmed", completeness: "complete" }, primary_result: { body: { path: "src/a.ts", text: "hookNeedle" }, source_span: { start_line: 4 } } } };

    const paginated = await translateAgentSearch(request, bridge({ completeness: { overall_status: "complete" }, streams: { matches: { items: [item], has_next: true, next_cursor: "opaque.cursor" } } }));
    expect(paginated).toMatchObject({ decision: "serve", output: expect.stringContaining('MORE: {"request_type":"continuation","continuation":{"api_version":3,"scope":{"scope_type":"single_workspace","workspace_id":"ws-1"},"cursor":"opaque.cursor"') });
    await expect(translateAgentSearch(request, bridge({ completeness: { overall_status: "complete" }, streams: { matches: { items: [item], has_next: true } } }))).resolves.toEqual({ decision: "fallback", fallback_reason: "output_overflow" });
    const explicitlyPaginated = await translateAgentSearch(request, bridge({ completeness: { overall_status: "complete" }, truncation: { truncated: true }, streams: { matches: { items: [item], has_next: true, next_cursor: "opaque.truncated.cursor" } } }));
    expect(explicitlyPaginated).toMatchObject({ decision: "serve", output: expect.stringContaining('MORE: {"request_type":"continuation"') });
    await expect(translateAgentSearch(request, bridge({ completeness: { overall_status: "complete" }, truncation: { truncated: true }, streams: { matches: { items: [item], has_next: false } } }))).resolves.toEqual({ decision: "fallback", fallback_reason: "output_overflow" });

    const projected = await translateAgentSearch({ ...request, native_arguments: { pattern: "hookNeedle", line_limit: 1 } }, bridge({ completeness: { overall_status: "complete" }, streams: { matches: { items: [item], has_next: true } } }));
    expect(projected).toMatchObject({ decision: "serve", output: "src/a.ts:4:hookNeedle" });
  });

  it("bridges Cursor Grep and Search Files through preToolUse", async () => {
    const bridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { matches: [{ body: { path: "src/a.ts", text: "foo" }, evidence: [{ line: 1 }] }] } } } };
    const grep = await runAgentHook({ client: "cursor", tool_name: "Grep", cwd: "/workspace", tool_input: { pattern: "foo" }, max_output: 1000 }, bridge);
    expect(grep).toMatchObject({ permission: "deny", agent_message: "[urdira hook served]\nsrc/a.ts:1:foo" });
    const files = await runAgentHook({ client: "cursor", tool_name: "Search Files", cwd: "/workspace", tool_input: { query: "src/**/*.ts" }, max_output: 1000 }, { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { artifacts: [{ body: { path: "src/a.ts" } }] } } } });
    expect(files).toMatchObject({ permission: "deny", agent_message: "[urdira hook served]\nsrc/a.ts" });
    const semanticBridge = { call: async (name: string) => name === "core:index_status" ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } } : { outcome: "success", payload: { streams: { candidates: [{ body: { path: "src/a.ts" } }] } } } };
    await expect(runAgentHook({ client: "cursor", tool_name: "Codebase", cwd: "/workspace", tool_input: { query: "foo" } }, semanticBridge)).resolves.toMatchObject({ permission: "deny", agent_message: "[urdira hook served]\nsrc/a.ts" });
  });

  it("injects the Urdira-first context into Claude before prompt processing", async () => {
    const home = `/tmp/urdira-claude-prompt-hook-${process.pid}`;
    try {
      await installAgent("claude-code", { dry_run: false, confirm: true, home });
      const settings = JSON.parse(await readFile(`${home}/.claude/settings.json`, "utf8"));
      expect(settings.hooks.UserPromptSubmit).toEqual([
        { hooks: [{ type: "command", command: expect.stringContaining("--client claude-code") }] },
      ]);
      let calls = 0;
      const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Fix the registry" }, {
        call: async () => { calls++; return { outcome: "success" }; },
      }, "claude-code");
      expect(calls).toBe(0);
      expect(output).toMatchObject({ hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("Urdira should supply the main repository context"),
      } });
      await uninstallAgent("claude-code", { dry_run: false, confirm: true, home });
      expect(JSON.parse(await readFile(`${home}/.claude/settings.json`, "utf8")).hooks.UserPromptSubmit).toEqual([]);
      await expect(readFile(`${home}/.claude/agents/urdira-discovery.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("installs a Codex prompt hook and injects deduplicated Urdira context before the model starts", async () => {
    const home = `/tmp/urdira-codex-prompt-hook-${process.pid}`;
    try {
      await installAgent("codex", { dry_run: false, confirm: true, home, launcher: ["urdira"] });
      const hooks = JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8"));
      expect(hooks.hooks.UserPromptSubmit).toEqual([
        { hooks: [{
          type: "command",
          command: expect.stringContaining("--client codex"),
          timeout: 30,
          additionalContextLimit: 10_000_000,
        }] },
      ]);
      const calls: Array<{ readonly name: string; readonly payload: any }> = [];
      const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Fix Target and its tests", cwd: "/workspace" }, {
        call: async (name, payload) => {
          calls.push({ name, payload });
          if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
          return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [
            { value: { primary_result: { record_id: "record-1", body: { path: "src/target.ts", name: "Target" } }, optional_source_snippets: [{ artifact_version_id: "artv-1", start_byte: "10", end_byte: "37", text: "export function Target() {}" }] } },
            { value: { primary_result: { record_id: "record-2", body: { path: "src/target.ts", name: "Target reference" } }, optional_source_snippets: [{ artifact_version_id: "artv-1", start_byte: "0", end_byte: "37", text: "// header\nexport function Target() {}" }] } },
          ], has_next: false }, "context\0possible": { items: [
            { value: { primary_result: { record_id: "record-test", body: { path: "tests/target.spec.ts", name: "Target test", matched_symbol: "Target" } }, optional_source_snippets: [{ artifact_version_id: "artv-test", start_byte: "10", end_byte: "44", text: "test('Target', () => Target());" }] } },
          ], has_next: true, next_cursor: "possible-next" } } } };
        },
      }, "codex");

      expect(calls.map((call) => call.name)).toEqual(["core:index_status", "core:query"]);
      expect(calls[1]!.payload).toMatchObject({
        scope: { scope_type: "single_workspace", workspace_id: "ws-1" },
        expression: { expression_type: "operation", operation: "core:build_context", arguments: {
          task: "Fix Target and its tests",
          seeds: [{ subject_type: "symbol", name: "Target" }],
          facets: ["definitions", "tests", "implementations", "callers", "contracts"],
        } },
        options: {
          snippets: { context_lines: 12 },
          response_budget: { max_items: 50, max_characters: 40_000 },
        },
      });
      expect(output).toMatchObject({ hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("Urdira prompt context already loaded"),
      } });
      const context = (output as any).hookSpecificOutput.additionalContext as string;
      expect(context).toContain("src/target.ts Target record=record-1");
      expect(context).toContain("[possible] tests/target.spec.ts Target test record=record-test");
      expect(context).toContain("matched_symbol=Target");
      expect(context).toContain("test('Target', () => Target());");
      expect(context).toContain('"cursor":"possible-next"');
      expect(context).toContain("page=incomplete");
      expect(context).toContain("MORE retains every remaining result");
      expect(context).toContain('query_scope={"scope_type":"single_workspace","workspace_id":"ws-1"}');
      expect(context).toContain("work from it before any MCP or shell discovery");
      expect(context).toContain("do not query a listed symbol or path again");
      expect(context).toContain("SOURCE GUIDE production=source:1 tests=source:2");
      expect(context).toContain("Listed production snippets can include definitions, callers, and public wiring");
      expect(context).toContain("ACTION READY: make the first edit from these snippets before repository inventory");
      expect(context).not.toContain("Call deferred tools");
      expect(context.match(/export function Target\(\) \{\}/g)).toHaveLength(1);
      expect(context).toContain("// header");
      expect(context).toContain("source_refs=source:1");
      expect(context.indexOf("WORKING SOURCES")).toBeLessThan(context.indexOf("RESULT INDEX"));

      const installedInstructions = await readFile(`${home}/.codex/config.toml`, "utf8");
      expect(installedInstructions).toContain("inspect its exact-file selector");
      expect(installedInstructions).toContain("compile first when it reads generated output");

      await uninstallAgent("codex", { dry_run: false, confirm: true, home });
      expect(JSON.parse(await readFile(`${home}/.codex/hooks.json`, "utf8")).hooks.UserPromptSubmit).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("keeps exact prompt-source identity and ranges when different artifacts contain identical text", async () => {
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Change Target", cwd: "/workspace" }, {
      call: async (name) => name === "core:index_status"
        ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
        : { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [
          { value: { primary_result: { record_id: "record-1", owner_artifact_version_id: "artv-1", body: { path: "src/a.ts", name: "TargetA" } }, optional_source_snippets: [{ span: { artifact_version_id: "artv-1", start_byte: "0", end_byte: "27", start_line: "1", end_line: "1" }, text: "export const target = true;" }] } },
          { value: { primary_result: { record_id: "record-2", owner_artifact_version_id: "artv-2", body: { path: "src/b.ts", name: "TargetB" } }, optional_source_snippets: [{ span: { artifact_version_id: "artv-2", start_byte: "0", end_byte: "27", start_line: "8", end_line: "8" }, text: "export const target = true;" }] } },
        ], has_next: false } } } },
    }, "codex");

    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context.match(/export const target = true;/g)).toHaveLength(2);
    expect(context).toContain("source:1 src/a.ts:1:1 artifact_version=artv-1 bytes=0-27");
    expect(context).toContain("source:2 src/b.ts:8:8 artifact_version=artv-2 bytes=0-27");
  });

  it("anchors prompt context on the primary identifier instead of a common incidental member", async () => {
    const calls: Array<{ readonly name: string; readonly payload: any }> = [];
    await runAgentHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Improve LanguageFeatureRegistry change notifications through onDidChange without changing disposal.",
      cwd: "/workspace",
    }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "failure", error: { code: "core:selector_unresolvable" } };
      },
    }, "codex");

    expect(calls[1]!.payload.expression.arguments.seeds).toEqual([
      { subject_type: "symbol", name: "LanguageFeatureRegistry" },
    ]);
  });

  it("ignores benchmark paths and metadata before selecting the task symbol", async () => {
    const calls: Array<{ readonly name: string; readonly payload: any }> = [];
    await runAgentHook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Benchmark artifact: /Users/Cristian/BenchmarkResults/urdira-context-density-20260914-v83/runs/provider/host.json. Make TypeScript LanguageProvider registration idempotent and add its focused tests.",
      cwd: "/workspace",
    }, {
      call: async (name, payload) => {
        calls.push({ name, payload });
        return name === "core:index_status"
          ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
          : { outcome: "failure", error: { code: "core:selector_unresolvable" } };
      },
    }, "codex");

    expect(calls[1]!.payload.expression.arguments.seeds).toEqual([
      { subject_type: "symbol", name: "LanguageProvider" },
    ]);
  });

  it("falls back to source search with the typed coverage diagnostic when context facets are not ready", async () => {
    const calls: string[] = [];
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Fix LanguageProvider readiness", cwd: "/workspace" }, {
      call: async (name, payload: any) => {
        calls.push(name);
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        if (payload.expression?.operation === "core:build_context") return { outcome: "error", error: { code: "core:coverage_incomplete", details: { source_safe_fallback_operations: ["core:search_text"] } } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { matches: { items: [
          { primary_result: { body: { path: "src/languageProvider.ts" }, evidence: [{ line: 14 }], text: "LanguageProvider" } },
        ], has_next: false } } } };
      },
    }, "codex");

    expect(calls).toEqual(["core:index_status", "core:query", "core:query"]);
    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("diagnostic=core:coverage_incomplete");
    expect(context).toContain("coverage=partial");
    expect(context).toContain("source_search_coverage=complete");
    expect(context).toContain("src/languageProvider.ts:14:LanguageProvider");
    expect(context).toContain("source-safe fallback");
  });

  it("uses the source-safe fallback when a structural seed is unresolved", async () => {
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Fix LanguageProvider readiness", cwd: "/workspace" }, {
      call: async (name, payload: any) => {
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        if (payload.expression?.operation === "core:build_context") return { outcome: "error", error: { code: "core:selector_unresolvable" } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { matches: { items: [
          { primary_result: { body: { path: "src/languageProvider.ts" }, evidence: [{ line: 14 }], text: "LanguageProvider" } },
        ], has_next: false } } } };
      },
    }, "codex");

    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("diagnostic=core:selector_unresolvable");
    expect(context).toContain("src/languageProvider.ts:14:LanguageProvider");
  });

  it("emits a copy-ready literal continuation for source-safe prompt recovery", async () => {
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Fix LanguageProvider readiness", cwd: "/workspace" }, {
      call: async (name, payload: any) => {
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } };
        if (payload.expression?.operation === "core:build_context") return { outcome: "error", error: { code: "core:coverage_incomplete", details: { source_safe_fallback_operations: ["core:search_text"] } } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "partial" }, streams: { matches: { items: [
          { primary_result: { body: { path: "src/languageProvider.ts" }, evidence: [{ line: 14 }], text: "LanguageProvider" } },
        ], has_next: true, next_cursor: "opaque-cursor" } } } };
      },
    }, "codex");

    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("page=incomplete");
    expect(context).toContain('"cursor":"opaque-cursor"');
    expect(context).toContain("Copy the complete MORE JSON object literally into");
    expect(context).toContain("never reconstruct, abbreviate, or edit");
  });

  it("merges partially overlapping prompt sources from one artifact without losing result references", async () => {
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Change Target", cwd: "/workspace" }, {
      call: async (name) => name === "core:index_status"
        ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
        : { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [
          { value: { primary_result: { record_id: "record-1", owner_artifact_version_id: "artv-1", body: { path: "src/a.ts", name: "Target" } }, optional_source_snippets: [{ span: { artifact_version_id: "artv-1", start_byte: "0", end_byte: "11", start_line: "1", end_line: "2" }, text: "alpha\nbeta\n" }] } },
          { value: { primary_result: { record_id: "record-2", owner_artifact_version_id: "artv-1", body: { path: "src/a.ts", name: "Target caller" } }, optional_source_snippets: [{ span: { artifact_version_id: "artv-1", start_byte: "6", end_byte: "17", start_line: "2", end_line: "3" }, text: "beta\ngamma\n" }] } },
        ], has_next: false } } } },
    }, "codex");

    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context.match(/alpha\nbeta\ngamma\n/g)).toHaveLength(1);
    expect(context).not.toContain("source:2 src/a.ts");
    expect(context.match(/source_refs=source:1/g)).toHaveLength(2);
    expect(context).toContain("source:1 src/a.ts:1:3 artifact_version=artv-1 bytes=0-17");
  });

  it("keeps follow-up turns on their existing context when no new prompt seed resolves", async () => {
    const output = await runAgentHook({ hook_event_name: "UserPromptSubmit", prompt: "Continue the same task and finish validation.", cwd: "/workspace" }, {
      call: async (name) => name === "core:index_status"
        ? { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", freshness_status: "current" }] } }
        : { outcome: "error", error: { code: "core:selector_unresolvable", message: "No structural seed." } },
    }, "codex");

    const context = (output as any).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("No new repository seed resolved from this follow-up prompt");
    expect(context).toContain("Reuse the repository context already present in this conversation");
    expect(context).toContain("do not repeat a successful build or test when no relevant edit followed it");
    expect(context).not.toContain("Start with an explicitly scoped Urdira status/context call");
  });

  it("does not rehydrate unchanged successful prompt context in the same host session", async () => {
    const cacheDir = `${tmpdir()}/urdira-prompt-context-cache-${process.pid}-${Date.now()}`;
    const previousCacheDir = process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
    process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = cacheDir;
    const calls: string[] = [];
    const payload = { hook_event_name: "UserPromptSubmit", session_id: `session-${process.pid}-${Date.now()}`, prompt: "Fix Target and its tests", cwd: "/workspace" };
    const bridge = {
      call: async (name: string) => {
        calls.push(name);
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", current_snapshot_id: "snapshot-1", freshness_status: "current" }] } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [
          { value: { primary_result: { record_id: "record-1", body: { path: "src/target.ts", name: "Target" } }, optional_source_snippets: [{ artifact_version_id: "artv-1", start_byte: "0", end_byte: "28", text: "export function Target() {}" }] } },
        ], has_next: false } } } };
      },
    };
    try {
      const first = await runAgentHook(payload, bridge, "codex");
      const second = await runAgentHook(payload, bridge, "codex");
      expect((first as any).hookSpecificOutput.additionalContext).toContain("WORKING SOURCES");
      expect((second as any).hookSpecificOutput.additionalContext).toContain("Reuse the repository context already present");
      expect((second as any).hookSpecificOutput.additionalContext).not.toContain("WORKING SOURCES");
      expect(calls.filter((name) => name === "core:query")).toHaveLength(1);
    } finally {
      if (previousCacheDir === undefined) delete process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
      else process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = previousCacheDir;
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("reuses context for a follow-up with an incidental identifier unless detail is requested", async () => {
    const cacheDir = `${tmpdir()}/urdira-prompt-context-cache-follow-up-${process.pid}-${Date.now()}`;
    const previousCacheDir = process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
    process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = cacheDir;
    const calls: string[] = [];
    const sessionId = `follow-up-${process.pid}-${Date.now()}`;
    const bridge = {
      call: async (name: string) => {
        calls.push(name);
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", current_snapshot_id: "snapshot-1", freshness_status: "current" }] } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [
          { value: { primary_result: { record_id: "record-1", body: { path: "src/languageProvider.ts", name: "LanguageProvider" } }, optional_source_snippets: [{ artifact_version_id: "artv-1", start_byte: "0", end_byte: "28", text: "export class LanguageProvider {}" }] } },
        ], has_next: false } } } };
      },
    };
    try {
      const first = await runAgentHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Fix LanguageProvider readiness", cwd: "/workspace" }, bridge, "codex");
      const second = await runAgentHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Continue with TypeScript validation and finish the task.", cwd: "/workspace" }, bridge, "codex");
      expect((first as any).hookSpecificOutput.additionalContext).toContain("WORKING SOURCES");
      expect((second as any).hookSpecificOutput.additionalContext).toContain("Reuse the repository context already present");
      expect(calls.filter((name) => name === "core:query")).toHaveLength(1);
    } finally {
      if (previousCacheDir === undefined) delete process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
      else process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = previousCacheDir;
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not reuse the cached packet when a follow-up names a missing detail", async () => {
    const cacheDir = `${tmpdir()}/urdira-prompt-context-cache-missing-detail-${process.pid}-${Date.now()}`;
    const previousCacheDir = process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
    process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = cacheDir;
    const calls: string[] = [];
    const sessionId = `missing-detail-${process.pid}-${Date.now()}`;
    const bridge = {
      call: async (name: string) => {
        calls.push(name);
        if (name === "core:index_status") return { outcome: "success", payload: { workspaces: [{ workspace_id: "ws-1", current_snapshot_id: "snapshot-1", freshness_status: "current" }] } };
        return { outcome: "success", payload: { freshness_status: "current", completeness: { overall_status: "complete" }, streams: { context: { items: [], has_next: false } } } };
      },
    };
    try {
      await runAgentHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Fix LanguageProvider readiness", cwd: "/workspace" }, bridge, "codex");
      await runAgentHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Continue and show the missing caller for TypeScript.", cwd: "/workspace" }, bridge, "codex");
      expect(calls.filter((name) => name === "core:query")).toHaveLength(2);
    } finally {
      if (previousCacheDir === undefined) delete process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"];
      else process.env["URDIRA_PROMPT_CONTEXT_CACHE_DIR"] = previousCacheDir;
      await rm(cacheDir, { recursive: true, force: true });
    }
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

  it("injects working Urdira search tools into OpenCode with session scope", async () => {
    const home = `/tmp/urdira-opencode-tools-${process.pid}`;
    try {
      await installAgent("opencode", { dry_run: false, confirm: true, home, launcher: ["/opt/urdira/node", "/opt/urdira/cli.js"] });
      const grep = await readFile(`${home}/.config/opencode/tools/grep.ts`, "utf8");
      const glob = await readFile(`${home}/.config/opencode/tools/glob.ts`, "utf8");
      for (const source of [grep, glob]) {
        expect(source).toContain("async execute(args, context)");
        expect(source).toContain("working_directory: context.directory");
        expect(source).toContain('Bun.spawn(["/opt/urdira/node", "/opt/urdira/cli.js"');
      }
      expect(grep).toContain("primary repository context");
      await uninstallAgent("opencode", { dry_run: false, confirm: true, home });
      await expect(readFile(`${home}/.config/opencode/tools/grep.ts`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
    const digest = await runIsolatedDiscoveryDigest({ run: async (operation) => { childCalls += 1; return operation(bridge); } }, bridge, "ws-1", [{ api_version: 3 }]);
    expect(childCalls).toBe(1);
    expect(digest.workspace_id).toBe("ws-1");
    expect(digest.findings.length).toBeLessThanOrEqual(8);
    expect(digest.incomplete_work).toEqual([]);
  });
});
