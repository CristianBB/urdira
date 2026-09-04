import { readFile, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  classifyWorkspaceConfigurationImpact,
  detectWorkspaceTechnologies,
  summarizeWorkspaceTechnologyProposal,
  WorkspaceConfigurationCoordinator,
  resolveWorkspaceRoot,
  resolveIndexStatusRequest,
  DeterministicFakeWatcher,
  WorkspaceWatcherManager,
  type WorkspaceDetectionInput,
} from "../packages/engine/src/index.js";
import { createUrdiraMcpServer, createUrdiraToolDefinitions } from "../packages/mcp/src/index.js";
import { operationErrorDefinitions } from "../packages/contracts/src/index.js";
import { parseCliArgs, runCli } from "../packages/cli/src/index.js";
import { WorkspaceRegistry } from "../packages/engine/src/index.js";
import { defaultDaemonOptions } from "../apps/urdira/src/index.js";

describe("workspace technology detection", () => {
  test("produces deterministic declarative proposals with evidence and fingerprint", () => {
    const input: WorkspaceDetectionInput = {
      provider_fingerprint: "provider-1",
      git_state_fingerprint: "git-1",
      plugin_catalog_fingerprint: "catalog-1",
      files: [
        { path: "src/app.tsx" },
        { path: "src/index.js" },
        { path: "package.json", content: '{"dependencies":{"next":"15.0.0","react":"19.0.0"}}' },
      ],
    };

    const proposal = detectWorkspaceTechnologies(input);
    expect(proposal).toMatchObject({
      provider_fingerprint: "provider-1",
      git_state_fingerprint: "git-1",
      plugin_catalog_fingerprint: "catalog-1",
      technologies: [
        { technology_id: "javascript", kind: "language" },
        { technology_id: "next", kind: "framework" },
        { technology_id: "react", kind: "framework" },
        { technology_id: "typescript", kind: "language" },
      ],
    });
    expect(proposal.proposal_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proposal.technologies.every((technology) => technology.evidence.length > 0)).toBe(true);
    expect(detectWorkspaceTechnologies(input)).toEqual(proposal);
  });

  test("bounds transport evidence without weakening the full proposal fingerprint", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/unit-${String(index).padStart(3, "0")}.ts` }));
    const proposal = detectWorkspaceTechnologies({
      provider_fingerprint: "provider-large",
      git_state_fingerprint: "git-large",
      plugin_catalog_fingerprint: "catalog-large",
      files,
    });

    const summary = summarizeWorkspaceTechnologyProposal(proposal, 8);
    const typescript = summary.technologies.find((technology) => technology.technology_id === "typescript");
    expect(summary.proposal_fingerprint).toBe(proposal.proposal_fingerprint);
    expect(typescript).toMatchObject({ evidence_count: 100, evidence_complete: false });
    expect(typescript?.evidence).toHaveLength(8);
    expect(typescript?.evidence.map((entry) => entry.path)).toEqual(files.slice(0, 8).map((entry) => entry.path));
    expect(summarizeWorkspaceTechnologyProposal(proposal, 8)).toEqual(summary);
  });
});

describe("workspace configuration impact", () => {
  test("classifies plugin, source, semantic, analysis and query-only changes", () => {
    const base = { plugins: ["core/typescript"], source_selection: ["src/**"], analysis: { depth: 1 }, semantic_profile: "default", query: { max_items: 20 } };
    expect(classifyWorkspaceConfigurationImpact(base, { ...base, query: { max_items: 40 } })).toBe("query_only");
    expect(classifyWorkspaceConfigurationImpact(base, { ...base, analysis: { depth: 2 } })).toBe("analysis");
    expect(classifyWorkspaceConfigurationImpact(base, { ...base, source_selection: ["lib/**"] })).toBe("source_selection");
    expect(classifyWorkspaceConfigurationImpact(base, { ...base, plugins: ["core/typescript", "local/react"] })).toBe("plugin_resolution");
    expect(classifyWorkspaceConfigurationImpact(base, { ...base, semantic_profile: "code-v2" })).toBe("semantic_projection");
  });
});

describe("MCP index status v3", () => {
  test("advertises the closed build-context facets and repeats them in SDK validation errors", async () => {
    const client = { call: async () => ({ protocol_version: 1, request_id: "request-1", outcome: "success" as const, payload: {} }) };
    const tools = createUrdiraToolDefinitions({ client });
    const context = tools.find((tool) => tool.name === "urdira_context")!;
    const facets = (context.input_schema.properties as Record<string, { items?: { enum?: string[] } }>) ["facets"];
    expect(facets?.items?.enum).toEqual([
      "definitions", "implementations", "callers", "callees", "dependencies", "contracts",
      "effects", "tests", "configuration", "analogues", "extension_points",
    ]);

    const server = createUrdiraMcpServer({ client });
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema: { "~standard": { validate: (input: unknown) => Promise<{ issues?: readonly { message: string }[] }> } } }> })._registeredTools;
    const result = await registered["urdira_context"]!.inputSchema["~standard"].validate({
      api_version: 3,
      scope: { scope_type: "single_workspace", workspace_id: "workspace-1" },
      task: "diagnostic callback",
      facets: ["public_surfaces"],
    });
    expect(result.issues?.[0]?.message).toContain("valid facets: definitions, implementations, callers, callees, dependencies, contracts, effects, tests, configuration, analogues, extension_points");
  });

  test("resolves an explicit root and normalizes away a redundant workspace id list", async () => {
    const calls: unknown[] = [];
    const tools = createUrdiraToolDefinitions({ client: { call: async (_name: string, payload: unknown) => { calls.push(payload); return { protocol_version: 1, request_id: "request-1", outcome: "success", payload: { workspaces: [{ workspace_id: "workspace-1", workspace_root: "/tmp/example", display_root: "project" }] } }; } } });
    const status = tools.find((tool) => tool.name === "urdira_index_status")!;
    const response = await status.invoke({ requestType: "initial", apiVersion: 3, workspaceIds: [], workspaceRoot: "/tmp/example", includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 1000 }, render: "json" });
    // No outputSchema is registered for any Urdira tool (a live benchmark
    // found Claude Code's MCP client reads only structuredContent instead
    // of content[0].text when an outputSchema is declared, so the fix
    // stopped declaring one) -- render:"json" therefore puts the full page
    // in content[0].text only, with no structuredContent at all.
    expect(response.structuredContent).toBeUndefined();
    const responseBlock = response.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    expect(JSON.parse(responseBlock.text)).toEqual({ page: { workspaces: [{ workspace_id: "workspace-1", display_root: "project" }] } });
    // A v3 request's workspace_root is authoritative; a caller-supplied
    // workspace_ids is redundant for this variant and is normalized to []
    // rather than rejected -- the adapter's server-side defaulting layer
    // does not force an agent to get this exactly right.
    const secondResponse = await status.invoke({ requestType: "initial", apiVersion: 3, workspaceIds: ["workspace-1"], workspaceRoot: "/tmp/example", includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 1000 }, render: "json" });
    expect(secondResponse.structuredContent).toBeUndefined();
    const secondBlock = secondResponse.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    expect(JSON.parse(secondBlock.text)).toEqual({ page: { workspaces: [{ workspace_id: "workspace-1", display_root: "project" }] } });
    expect(calls).toEqual([
      { request_type: "initial", api_version: 3, workspace_ids: [], include_capabilities: false, include_plugins: false, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 10, max_characters: 1000 }, workspace_root: "/tmp/example", include_configuration_issues: false },
      { request_type: "initial", api_version: 3, workspace_ids: [], include_capabilities: false, include_plugins: false, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 10, max_characters: 1000 }, workspace_root: "/tmp/example", include_configuration_issues: false },
    ]);
  });

  // P4-d: compact-text rendering of a v4 workspace's lane fields
  // (`v4StatusFields`, `packages/daemon/src/runtime.ts`) via
  // `urdira_index_status`'s default text render (`renderIndexStatusText`,
  // `packages/mcp/src/index.ts`). A stubbed daemon `client.call` stands in
  // for the real daemon here (this test never spins one up) -- it returns
  // the exact wire shape `v4StatusFields` produces for a v4 workspace whose
  // lexical lane has NOT yet caught up to its durable structural
  // generation, so the "lagging"/hint lines below have something to fire on.
  test("renders v4 lane generations, a lagging lexical hint, and the last-scan summary as compact text", async () => {
    const tools = createUrdiraToolDefinitions({ client: { call: async () => ({ protocol_version: 1, request_id: "request-1", outcome: "success", payload: { workspaces: [{
      workspace_id: "workspace-v4", display_root: "project-v4", workspace_status: "ready", freshness_status: "current",
      source_ready: true, structural_ready: true, semantic_ready: false,
      storage_format: "v4",
      structural: { queryable_generation: 3, durable_generation: 3, queryable: true },
      lexical: { completed_generation: 2, current: false },
      semantic: { current: false },
      last_scan: { kind: "changed", changed_paths: 4, timings: { total_ms: 812 } },
      search_text_ready: false,
      search_semantic_ready: false,
      plugins: [], capabilities: [],
    }] } }) } });
    const status = tools.find((tool) => tool.name === "urdira_index_status")!;
    const response = await status.invoke({ requestType: "initial", apiVersion: 3, workspaceIds: [], includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 10_000 } });
    const text = response.content.find((block): block is { type: "text"; text: string } => block.type === "text")!.text;
    expect(text).toContain("workspace_id=workspace-v4 (project-v4): ready");
    expect(text).toContain("structural: queryable_gen=3, durable_gen=3");
    expect(text).toContain("lexical: completed_gen=2 (lagging)");
    expect(text).toContain("semantic: completed_gen=- (lagging)");
    expect(text).toContain("last_scan: kind=changed, changed_paths=4, wall_ms=812");
    expect(text).toContain("hint: search_text will report partial until lexical catches up");
    expect(text).toContain("hint: search_semantic is unavailable until semantic indexing catches up");
  });

  // A v3 workspace never sets `storage_format`/`structural`/`lexical`/
  // `semantic`/`last_scan` at all (`v4StatusFields` only ever emits
  // `storage_format: "v3"` alongside them for a v3 workspace, and
  // `renderIndexStatusText`'s v4 block is gated on `storage_format === "v4"`)
  // -- this pins that a v3 render carries none of the new lines.
  test("keeps the v3 render free of v4 lane lines", async () => {
    const tools = createUrdiraToolDefinitions({ client: { call: async () => ({ protocol_version: 1, request_id: "request-1", outcome: "success", payload: { workspaces: [{
      workspace_id: "workspace-v3", display_root: "project-v3", workspace_status: "ready", freshness_status: "current",
      source_ready: true, structural_ready: true, semantic_ready: true,
      storage_format: "v3",
      plugins: [], capabilities: [],
    }] } }) } });
    const status = tools.find((tool) => tool.name === "urdira_index_status")!;
    const response = await status.invoke({ requestType: "initial", apiVersion: 3, workspaceIds: [], includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 10_000 } });
    const text = response.content.find((block): block is { type: "text"; text: string } => block.type === "text")!.text;
    expect(text).toContain("workspace_id=workspace-v3 (project-v3): ready");
    expect(text).not.toContain("structural: queryable_gen");
    expect(text).not.toContain("last_scan:");
    expect(text).not.toContain("hint: search_text will report partial");
  });

  test("publishes an actionable unregistered-root operation error", () => {
    const definition = operationErrorDefinitions.find((entry) => entry.code === "core:workspace_not_registered");
    expect(definition).toMatchObject({ retryable_default: false, recovery_actions: ["register_workspace"] });
    expect(definition?.details_schema.properties).toHaveProperty("registration_command");
  });

  test("fills the registration command when a daemon omits optional error details", async () => {
    const { formatUrdiraResult } = await import("../packages/mcp/src/index.js");
    const result = formatUrdiraResult({ error: { code: "core:workspace_not_registered", message: "not indexed" } });
    expect(result.structuredContent).toBeUndefined();
    const block = result.content.find((entry): entry is { type: "text"; text: string } => entry.type === "text")!;
    expect(JSON.parse(block.text)).toMatchObject({ error: { details: { registration_command: "urdira workspace add <workspace-root>" } } });
  });
});

describe("workspace administration CLI", () => {
  test("parses direct workspace commands with optional preview/confirmation flags", () => {
    expect(parseCliArgs(["workspace", "add", "/tmp/project", "--dry-run", "--json"]).name).toBe("workspace-add");
    expect(parseCliArgs(["workspace", "configure", "workspace-1", "--confirm", "--proposal-id", "proposal-1"]).name).toBe("workspace-configure");
    expect(parseCliArgs(["workspace", "purge", "workspace-1", "--confirm"]).name).toBe("workspace-purge");
  });

  test("passes the exact proposal id to the confirmed configure call", async () => {
    const calls: Array<{ call: string; payload: unknown }> = [];
    const result = await runCli(["workspace", "configure", "workspace-1", "--confirm", "--proposal-id", "proposal-1", "--json"], {
      client: { call: async (call, payload) => { calls.push({ call, payload }); return { outcome: "success", payload: { applied: true } }; } },
      preview_admin: async () => ({ proposal_id: "proposal-1", digest: "sha256:proposal" }),
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "core:workspace_configure", payload: { proposal_id: "proposal-1" } });
  });

  test("supports the interactive add assistant after detection preview", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const result = await runCli(["workspace", "add", "/tmp/project"], {
      client: { call: async (call) => { calls.push(call); return { outcome: "success", payload: { workspace_id: "workspace-1" } }; } },
      preview_admin: async () => ({ proposal_id: "proposal-1", technologies: [{ technology_id: "typescript", kind: "language", confidence: 1, compatible_plugin_ids: ["urdira:javascript_typescript"], evidence: [{ path: "src/index.ts", rule: "extension.typescript" }] }] }),
      prompt: async (question) => { prompts.push(question); return question.includes("Configure Urdira") ? "no" : "yes"; },
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toEqual(["core:workspace_add"]);
    expect(prompts[0]).toContain("Detected technologies and compatible plugins:");
    expect(prompts[0]).toContain("typescript, language, confidence 100%");
    expect(prompts[0]).toContain("compatible plugins: urdira:javascript_typescript");
    expect(prompts[0]).toContain("src/index.ts (extension.typescript)");
    expect(prompts[1]).toContain("Compatible plugins to activate: urdira:javascript_typescript");
    expect(prompts[1]).toContain("Activate these plugins and start observation?");
  });

  test("labels bounded workspace evidence instead of hiding omitted paths", async () => {
    const prompts: string[] = [];
    await runCli(["workspace", "add", "/tmp/project"], {
      client: { call: async () => ({ outcome: "success", payload: { workspace_id: "workspace-1" } }) },
      preview_admin: async () => ({
        proposal_id: "proposal-1",
        technologies: [{
          technology_id: "typescript",
          kind: "language",
          confidence: 1,
          compatible_plugin_ids: ["urdira:javascript_typescript"],
          evidence: [{ path: "src/000.ts", rule: "extension.typescript" }],
          evidence_count: 100,
          evidence_complete: false,
        }],
      }),
      prompt: async (question) => { prompts.push(question); return question.includes("Configure Urdira") ? "no" : "yes"; },
    });
    expect(prompts[0]).toContain("showing 1 of 100 deterministic evidence paths");
  });

  test("explains the exact target instead of inventing a technology proposal for configure", async () => {
    const prompts: string[] = [];
    const result = await runCli(["workspace", "configure", "workspace-1"], {
      client: { call: async () => ({ outcome: "success", payload: { applied: true } }) },
      prompt: async (question) => { prompts.push(question); return "yes"; },
    });
    expect(result.exit_code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Workspace configuration target: workspace-1.");
    expect(prompts[0]).toContain("No technology detection is performed");
    expect(prompts[0]).toContain("Apply this configuration?");
  });

  test("rejects workspace add without a workspace path before prompting", async () => {
    const prompt = vi.fn();
    await expect(runCli(["workspace", "add"], { client: { call: async () => ({ outcome: "success", payload: {} }) }, prompt })).rejects.toMatchObject({ code: "cli:command_invalid" });
    expect(prompt).not.toHaveBeenCalled();
  });

  test("offers native agent installation after interactive workspace registration", async () => {
    const home = `/tmp/urdira-interactive-agent-${process.pid}`;
    try {
      const result = await runCli(["workspace", "add", "/tmp/project"], {
        client: { call: async (call) => call === "core:workspace_add" ? { outcome: "success", payload: { workspace_id: "workspace-1" } } : { outcome: "success", payload: {} } },
        preview_admin: async () => ({ proposal_id: "proposal-1", technologies: [{ technology_id: "typescript", compatible_plugin_ids: ["core/typescript"] }] }),
        home_directory: home,
        prompt: async (question) => question.includes("Configure Urdira") ? "codex, cursor" : "yes",
      });
      expect(result.exit_code).toBe(0);
      expect(result.data).toMatchObject({ agent_integrations: { installed: [{ client: "codex", changed: true }, { client: "cursor", changed: true }], unknown: [] } });
      await expect(readFile(`${home}/.cursor/hooks.json`, "utf8")).resolves.toContain("--client cursor");
      await expect(readFile(`${home}/.codex/hooks.json`, "utf8")).resolves.toContain("--client codex");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  test("defaults the non-interactive add path to the full preview-derived plugin selection", async () => {
    const calls: Array<{ call: string; payload: unknown }> = [];
    const preview = { proposal_id: "proposal-1", technologies: [
      { technology_id: "typescript", compatible_plugin_ids: ["core/typescript"] },
      { technology_id: "javascript", compatible_plugin_ids: ["core/javascript", "core/typescript"] },
    ] };
    const result = await runCli(["workspace", "add", "/tmp/project", "--confirm", "--json"], {
      client: { call: async (call, payload) => { calls.push({ call, payload }); return { outcome: "success", payload: { workspace_id: "workspace-1" } }; } },
      preview_admin: async () => preview,
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      call: "core:workspace_add",
      payload: { selected_technology_ids: ["typescript", "javascript"], selected_plugin_ids: ["core/typescript", "core/javascript"] },
    });
  });

  test("lets an explicit --payload override the default non-interactive plugin selection", async () => {
    const calls: Array<{ call: string; payload: unknown }> = [];
    const preview = { proposal_id: "proposal-1", technologies: [{ technology_id: "typescript", compatible_plugin_ids: ["core/typescript"] }] };
    const result = await runCli(["workspace", "add", "/tmp/project", "--confirm", "--payload", JSON.stringify({ selected_technology_ids: ["typescript"], selected_plugin_ids: ["core/custom"] }), "--json"], {
      client: { call: async (call, payload) => { calls.push({ call, payload }); return { outcome: "success", payload: { workspace_id: "workspace-1" } }; } },
      preview_admin: async () => preview,
    });
    expect(result.exit_code).toBe(0);
    expect(calls[0]).toMatchObject({ call: "core:workspace_add", payload: { selected_plugin_ids: ["core/custom"] } });
  });
});

describe("workspace root resolution", () => {
  test("matches only the canonical registered root and never exposes an absolute root in the error payload", () => {
    const registry = new WorkspaceRegistry({ canonicalize_root: (root) => root.replace(/\\$/u, "").toLowerCase() });
    expect(typeof registry.findByCanonicalRoot).toBe("function");
    expect(registry.findByCanonicalRoot("/tmp/project/")).toBeUndefined();
    expect(resolveWorkspaceRoot(registry, "/tmp/project")).toEqual({ error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>" } } });
    expect(resolveIndexStatusRequest(registry, { api_version: 2, workspace_ids: [], workspace_root: "/tmp/project" })).toEqual({ error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>", requested_version: 2, supported_versions: [3] } } });
  });
});

describe("transactional configuration proposals", () => {
  test("invalidates a proposal when provider, git or catalog fingerprints change", () => {
    const coordinator = new WorkspaceConfigurationCoordinator({ create_id: (kind) => `${kind}-1` });
    const proposal = coordinator.preview({ workspace_root: "/tmp/project", provider_fingerprint: "p1", git_state_fingerprint: "g1", plugin_catalog_fingerprint: "c1", files: [{ path: "index.ts" }] });
    expect(() => coordinator.confirmTechnologies(proposal.proposal_id, ["typescript"], { provider_fingerprint: "p2", git_state_fingerprint: "g1", plugin_catalog_fingerprint: "c1", files: [{ path: "index.ts" }] })).toThrow(/stale/i);
  });

  test("keeps the active configuration when a workspace config document is invalid", () => {
    const coordinator = new WorkspaceConfigurationCoordinator({ create_id: (kind) => `${kind}-1` });
    const result = coordinator.applyConfigDocument("workspace-1", '{"analysis":', { plugins: ["core/typescript"] });
    expect(result.applied).toBe(false);
    expect(result.configuration).toEqual({ plugins: ["core/typescript"] });
    expect(result.attempt.issues[0]).toMatchObject({ code: "invalid_config", severity: "error" });
  });
});

/**
 * `defaultDaemonOptions` (`apps/urdira/src/index.ts`) now resolves a REAL
 * embedding provider by default -- the bundled open-model local neural
 * provider, which downloads a model on first use -- per
 * `docs/decisions/16-semantic-search-wiring.md`'s open-model-default
 * addendum. Every test below only inspects scheduler/concurrency defaults,
 * not embeddings, so each forces the explicit `URDIRA_EMBEDDINGS_PROVIDER=hash`
 * escape hatch for the duration of the wrapped call, restoring whatever was
 * there before -- keeping this suite hermetic (no network, no model
 * download).
 */
async function withHashEmbeddingsProvider<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["URDIRA_EMBEDDINGS_PROVIDER"];
  process.env["URDIRA_EMBEDDINGS_PROVIDER"] = "hash";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env["URDIRA_EMBEDDINGS_PROVIDER"];
    else process.env["URDIRA_EMBEDDINGS_PROVIDER"] = previous;
  }
}

describe("persistent daemon defaults", () => {
  test("provide a per-user data root and all scheduler pools", async () => {
    const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions("/tmp/urdira-test-data"));
    expect(options.data_root).toBe("/tmp/urdira-test-data");
    // `structural` defaults to 2 (Phase 4 scheduler knob,
    // `URDIRA_STRUCTURAL_CONCURRENCY`); the other pools are unaffected.
    expect(options.scheduler.pool_concurrency).toMatchObject({ source: 1, structural: 2, semantic: 1, query: 1 });
    expect(options.scan_io_concurrency).toBeUndefined();
  });

  test("URDIRA_STRUCTURAL_CONCURRENCY overrides the structural pool's default concurrency", async () => {
    const previous = process.env["URDIRA_STRUCTURAL_CONCURRENCY"];
    process.env["URDIRA_STRUCTURAL_CONCURRENCY"] = "5";
    try {
      const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions("/tmp/urdira-test-data"));
      expect(options.scheduler.pool_concurrency).toMatchObject({ structural: 5 });
    } finally {
      if (previous === undefined) delete process.env["URDIRA_STRUCTURAL_CONCURRENCY"];
      else process.env["URDIRA_STRUCTURAL_CONCURRENCY"] = previous;
    }
  });

  test("an invalid URDIRA_STRUCTURAL_CONCURRENCY falls back to the default of 2", async () => {
    const previous = process.env["URDIRA_STRUCTURAL_CONCURRENCY"];
    process.env["URDIRA_STRUCTURAL_CONCURRENCY"] = "not-a-number";
    try {
      const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions("/tmp/urdira-test-data"));
      expect(options.scheduler.pool_concurrency).toMatchObject({ structural: 2 });
    } finally {
      if (previous === undefined) delete process.env["URDIRA_STRUCTURAL_CONCURRENCY"];
      else process.env["URDIRA_STRUCTURAL_CONCURRENCY"] = previous;
    }
  });

  test("URDIRA_SCAN_IO_CONCURRENCY threads through to scan_io_concurrency, following the same positive-integer-env pattern as URDIRA_SCAN_BUDGET_MS", async () => {
    const previous = process.env["URDIRA_SCAN_IO_CONCURRENCY"];
    process.env["URDIRA_SCAN_IO_CONCURRENCY"] = "32";
    try {
      const options = await withHashEmbeddingsProvider(() => defaultDaemonOptions("/tmp/urdira-test-data"));
      expect(options.scan_io_concurrency).toBe(32);
    } finally {
      if (previous === undefined) delete process.env["URDIRA_SCAN_IO_CONCURRENCY"];
      else process.env["URDIRA_SCAN_IO_CONCURRENCY"] = previous;
    }
  });
});

describe("workspace watcher lifecycle", () => {
  test("reconciles overflow and git branch events while keeping workspace identity", async () => {
    const watcher = new DeterministicFakeWatcher({ workspace_id: "workspace-1", source_provider_binding_id: "binding-1", source_provider: "core:git_worktree_source_provider", source_provider_version: "1", ordering_domain: "git:1", root: "/tmp/project" });
    const reconciled: string[] = [];
    const batches: string[] = [];
    const manager = new WorkspaceWatcherManager({ on_batch: async (batch) => { batches.push(batch.workspace_id); }, on_reconcile: async (workspaceId) => { reconciled.push(workspaceId); } });
    await manager.start({ workspace_id: "workspace-1", watcher });
    watcher.modify("src/index.ts");
    watcher.emit([{ event_class: "git_head", normalized_uri: ".git/HEAD" }]);
    watcher.emit([{ event_class: "overflow", normalized_uri: "" }]);
    await watcher.idle();
    await manager.idle();
    expect(batches).toEqual(["workspace-1", "workspace-1", "workspace-1"]);
    // Phase 5's changed-path plumbing: every batch reaches `on_reconcile`
    // now, not only the ones that force a full rescan -- so the ordinary
    // `modify` batch reconciles too (with a changed-URI hint), in addition
    // to the git-branch and overflow batches (which still force a full
    // rescan, no hint).
    expect(reconciled).toEqual(["workspace-1", "workspace-1", "workspace-1"]);
    await manager.stop("workspace-1");
  });

  test("carries changed-URI hints for ordinary batches and undefined for unsafe/full-rescan reasons", async () => {
    const watcher = new DeterministicFakeWatcher({ workspace_id: "workspace-1", source_provider_binding_id: "binding-1", source_provider: "core:filesystem_source_provider", source_provider_version: "1", ordering_domain: "fs:1", root: "/tmp/project" });
    const reconciled: { readonly workspaceId: string; readonly changedUris: readonly string[] | undefined; readonly reason: string }[] = [];
    const manager = new WorkspaceWatcherManager({ on_reconcile: async (workspaceId, changedUris, reason) => { reconciled.push({ workspaceId, changedUris, reason }); } });
    await manager.start({ workspace_id: "workspace-1", watcher });
    watcher.modify("src/index.ts");
    watcher.presence("src/new-file.ts");
    watcher.emit([{ event_class: "overflow", normalized_uri: "" }]);
    await watcher.idle();
    await manager.idle();
    expect(reconciled).toEqual([
      { workspaceId: "workspace-1", changedUris: ["src/index.ts"], reason: "changed" },
      { workspaceId: "workspace-1", changedUris: ["src/new-file.ts"], reason: "changed" },
      { workspaceId: "workspace-1", changedUris: undefined, reason: "events_lost" },
    ]);
    await manager.stop("workspace-1");
  });

  test("P3-2 item 4: a cross-path rename (delete + create in one batch) reaches on_reconcile as ONE combined call", async () => {
    // Was: "splits authoritative delete and rename presence into ordered
    // generations" -- two SEQUENTIAL `on_reconcile` calls. Fixed: the v4
    // worker already accepts a delete and a create together in one
    // `ScanScope::Changed{paths}` and handles it as a single rename
    // generation (`crates/urdira-indexing-worker/src/v4/delta.rs`), and a
    // real bug in the daemon's own aggregation buffering
    // (`packages/daemon/src/runtime.ts`'s `flushScanAggregation`) could
    // silently DROP the create half entirely when the two callbacks landed
    // far enough apart -- see that file's own `mergeScanRequestIntoBuffer`/
    // `flushScanAggregation` comments for the full mechanism. A cross-path
    // rename now reaches `on_reconcile` as one call with both halves.
    const watcher = new DeterministicFakeWatcher({ workspace_id: "workspace-1", source_provider_binding_id: "binding-1", source_provider: "core:directory_source_provider", source_provider_version: "1", ordering_domain: "fs:1", root: "/tmp/project", authoritative_delete_events: true });
    const reconciled: { readonly changedUris: readonly string[] | undefined; readonly deletes: readonly string[] }[] = [];
    const manager = new WorkspaceWatcherManager({ on_reconcile: async (_workspaceId, changedUris, _reason, deletes = []) => { reconciled.push({ changedUris, deletes: deletes.map((event) => event.normalized_uri) }); } });
    await manager.start({ workspace_id: "workspace-1", watcher });
    watcher.emit([{ event_class: "absence", normalized_uri: "src/old.ts" }, { event_class: "presence", normalized_uri: "src/new.ts" }]);
    await watcher.idle();
    await manager.idle();
    expect(reconciled).toEqual([{ changedUris: ["src/new.ts"], deletes: ["src/old.ts"] }]);
    await manager.stop("workspace-1");
  });

  test("a same-path delete-then-recreate still splits into ordered generations", async () => {
    // Unlike a cross-path rename, a delete and a presence for the SAME uri
    // cannot be folded into one `ChangedPath` entry: `mapV4ChangedPaths`
    // (`packages/daemon/src/runtime.ts`) dedupes by path with delete
    // winning, so combining them would silently discard the recreate. This
    // case must keep splitting into two ordered `on_reconcile` calls.
    const watcher = new DeterministicFakeWatcher({ workspace_id: "workspace-1", source_provider_binding_id: "binding-1", source_provider: "core:directory_source_provider", source_provider_version: "1", ordering_domain: "fs:1", root: "/tmp/project", authoritative_delete_events: true });
    const reconciled: { readonly changedUris: readonly string[] | undefined; readonly deletes: readonly string[] }[] = [];
    const manager = new WorkspaceWatcherManager({ on_reconcile: async (_workspaceId, changedUris, _reason, deletes = []) => { reconciled.push({ changedUris, deletes: deletes.map((event) => event.normalized_uri) }); } });
    await manager.start({ workspace_id: "workspace-1", watcher });
    watcher.emit([{ event_class: "absence", normalized_uri: "src/same.ts" }, { event_class: "presence", normalized_uri: "src/same.ts" }]);
    await watcher.idle();
    await manager.idle();
    expect(reconciled).toEqual([
      { changedUris: [], deletes: ["src/same.ts"] },
      { changedUris: ["src/same.ts"], deletes: [] },
    ]);
    await manager.stop("workspace-1");
  });
});
