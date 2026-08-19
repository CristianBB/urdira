import { describe, expect, test } from "vitest";
import {
  classifyWorkspaceConfigurationImpact,
  detectWorkspaceTechnologies,
  WorkspaceConfigurationCoordinator,
  resolveWorkspaceRoot,
  resolveIndexStatusRequest,
  DeterministicFakeWatcher,
  WorkspaceWatcherManager,
  type WorkspaceDetectionInput,
} from "../packages/engine/src/index.js";
import { createUrdiraToolDefinitions } from "../packages/mcp/src/index.js";
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

describe("MCP index status v2", () => {
  test("resolves an explicit root and normalizes away a redundant workspace id list", async () => {
    const calls: unknown[] = [];
    const tools = createUrdiraToolDefinitions({ client: { call: async (_name: string, payload: unknown) => { calls.push(payload); return { protocol_version: 1, request_id: "request-1", outcome: "success", payload: { workspaces: [{ workspace_id: "workspace-1", workspace_root: "/tmp/example", display_root: "project" }] } }; } } });
    const status = tools.find((tool) => tool.name === "urdira_index_status")!;
    const response = await status.invoke({ requestType: "initial", apiVersion: 2, workspaceIds: [], workspaceRoot: "/tmp/example", includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 1000 }, render: "json" });
    // No outputSchema is registered for any Urdira tool (a live benchmark
    // found Claude Code's MCP client reads only structuredContent instead
    // of content[0].text when an outputSchema is declared, so the fix
    // stopped declaring one) -- render:"json" therefore puts the full page
    // in content[0].text only, with no structuredContent at all.
    expect(response.structuredContent).toBeUndefined();
    const responseBlock = response.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    expect(JSON.parse(responseBlock.text)).toEqual({ page: { workspaces: [{ workspace_id: "workspace-1", display_root: "project" }] } });
    // A v2 request's workspace_root is authoritative; a caller-supplied
    // workspace_ids is redundant for this variant and is normalized to []
    // rather than rejected -- the adapter's server-side defaulting layer
    // does not force an agent to get this exactly right.
    const secondResponse = await status.invoke({ requestType: "initial", apiVersion: 2, workspaceIds: ["workspace-1"], workspaceRoot: "/tmp/example", includeCapabilities: false, includePlugins: false, includeActivationIssues: false, includeCandidateIssues: false, includeConfigurationIssues: false, responseBudget: { maxItems: 10, maxCharacters: 1000 }, render: "json" });
    expect(secondResponse.structuredContent).toBeUndefined();
    const secondBlock = secondResponse.content.find((block): block is { type: "text"; text: string } => block.type === "text")!;
    expect(JSON.parse(secondBlock.text)).toEqual({ page: { workspaces: [{ workspace_id: "workspace-1", display_root: "project" }] } });
    expect(calls).toEqual([
      { request_type: "initial", api_version: 2, workspace_ids: [], include_capabilities: false, include_plugins: false, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 10, max_characters: 1000 }, workspace_root: "/tmp/example", include_configuration_issues: false },
      { request_type: "initial", api_version: 2, workspace_ids: [], include_capabilities: false, include_plugins: false, include_activation_issues: false, include_candidate_issues: false, response_budget: { max_items: 10, max_characters: 1000 }, workspace_root: "/tmp/example", include_configuration_issues: false },
    ]);
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
  test("parses add and configure as explicit two-phase commands", () => {
    expect(parseCliArgs(["workspace", "add", "/tmp/project", "--dry-run", "--json"]).name).toBe("workspace-add");
    expect(parseCliArgs(["workspace", "configure", "workspace-1", "--dry-run", "--confirm", "--proposal-id", "proposal-1"]).name).toBe("workspace-configure");
    expect(parseCliArgs(["workspace", "purge", "workspace-1", "--dry-run", "--confirm"]).name).toBe("workspace-purge");
  });

  test("passes the exact proposal id to the confirmed configure call", async () => {
    const calls: Array<{ call: string; payload: unknown }> = [];
    const result = await runCli(["workspace", "configure", "workspace-1", "--dry-run", "--confirm", "--proposal-id", "proposal-1", "--json"], {
      client: { call: async (call, payload) => { calls.push({ call, payload }); return { outcome: "success", payload: { applied: true } }; } },
      preview_admin: async () => ({ proposal_id: "proposal-1", digest: "sha256:proposal" }),
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "core:workspace_configure", payload: { proposal_id: "proposal-1" } });
  });

  test("supports the interactive add assistant after detection preview", async () => {
    const calls: string[] = [];
    const result = await runCli(["workspace", "add", "/tmp/project"], {
      client: { call: async (call) => { calls.push(call); return { outcome: "success", payload: { workspace_id: "workspace-1" } }; } },
      preview_admin: async () => ({ proposal_id: "proposal-1", technologies: ["typescript"] }),
      prompt: async (question) => question.includes("confirm") ? "yes" : "yes",
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toEqual(["core:workspace_add"]);
  });

  test("defaults the non-interactive add path to the full preview-derived plugin selection", async () => {
    const calls: Array<{ call: string; payload: unknown }> = [];
    const preview = { proposal_id: "proposal-1", technologies: [
      { technology_id: "typescript", compatible_plugin_ids: ["core/typescript"] },
      { technology_id: "javascript", compatible_plugin_ids: ["core/javascript", "core/typescript"] },
    ] };
    const result = await runCli(["workspace", "add", "/tmp/project", "--dry-run", "--confirm", "--json"], {
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
    const result = await runCli(["workspace", "add", "/tmp/project", "--dry-run", "--confirm", "--payload", JSON.stringify({ selected_technology_ids: ["typescript"], selected_plugin_ids: ["core/custom"] }), "--json"], {
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
    expect(resolveIndexStatusRequest(registry, { api_version: 2, workspace_ids: [], workspace_root: "/tmp/project" })).toEqual({ error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>" } } });
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
});
