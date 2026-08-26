import { describe, expect, it, vi } from "vitest";
import { CLI_COMMAND_CATALOG, CliError, MUTATING_COMMANDS, parseCliArgs, runCli, type CliDaemonClient } from "../packages/cli/src/index.js";

const client: CliDaemonClient = { call: vi.fn(async (call) => ({ outcome: "success", payload: { call } })) };

describe("Phase 12 closed CLI", () => {
  it("publishes one closed descriptor for every registered command and never exposes shell execution", () => {
    expect(new Set(CLI_COMMAND_CATALOG.map((entry) => entry.command)).size).toBe(CLI_COMMAND_CATALOG.length);
    expect(CLI_COMMAND_CATALOG.some((entry) => entry.command === "workspace-list")).toBe(true);
    expect(CLI_COMMAND_CATALOG.some((entry) => entry.command === "codebase-create" && entry.confirmation === "proposal")).toBe(true);
    expect(JSON.stringify(CLI_COMMAND_CATALOG.map((entry) => ({ command: entry.command, options: entry.options })))).not.toMatch(/shell|spawn/u);
  });

  it("parses workspace inspection and codebase administration aliases", () => {
    expect(parseCliArgs(["workspace", "list"]).name).toBe("workspace-list");
    expect(parseCliArgs(["workspace", "show", "workspace-1"]).name).toBe("workspace-show");
    expect(parseCliArgs(["codebase", "create", "Project", "--confirm"]).name).toBe("codebase-create");
    expect(parseCliArgs(["codebase", "unassign", "workspace-1", "--confirm"]).name).toBe("codebase-unassign");
    expect(parseCliArgs(["agent", "install", "--client", "codex", "--dry-run"]).name).toBe("agent-install");
  });
  it("parses read-only commands and rejects unknown options", () => {
    expect(parseCliArgs(["status", "--json"])).toMatchObject({ name: "status", options: { json: true, dry_run: false, confirm: false } });
    expect(parseCliArgs(["index", "--debug-timing"])).toMatchObject({ name: "index", options: { debug_timing: true } });
    expect(parseCliArgs(["daemon", "start", "--debug-timing"])).toMatchObject({ name: "start", options: { debug_timing: true } });
    expect(() => parseCliArgs(["status", "--shell=rm -rf"])).toThrowError(CliError);
  });

  it("uses direct execution for daemon start/stop/restart and explicit confirmation for other mutations", async () => {
    for (const command of MUTATING_COMMANDS) {
      if (command === "start" || command === "stop" || command === "restart") {
        await expect(runCli([command], { client })).resolves.toMatchObject({ exit_code: 0, data: { command, confirmed: true } });
        continue;
      }
      if (command === "workspace-add") {
        await expect(runCli([command], { client })).rejects.toMatchObject({ code: "cli:command_invalid" });
        continue;
      }
      await expect(runCli([command], { client })).rejects.toMatchObject({ code: "cli:dry_run_required" });
      await expect(runCli([command, "--dry-run"], { client })).resolves.toMatchObject({ exit_code: 0, data: { dry_run: true, command } });
      await expect(runCli([command, "--confirm", "--json"], { client })).resolves.toMatchObject({ exit_code: 0, data: { dry_run: false, command } });
    }
    expect(client.call).toHaveBeenCalled();
  });

  it("delegates status, query, and index without mutation flags", async () => {
    await expect(runCli(["status"], { client })).resolves.toMatchObject({ exit_code: 0, data: { call: "core:status" } });
    await expect(runCli(["query", "--payload", "{\"query\":true}"], { client })).resolves.toMatchObject({ exit_code: 0, data: { call: "core:query" } });
    await expect(runCli(["index"], { client })).resolves.toMatchObject({ exit_code: 0, data: { call: "core:index_status" } });
    expect(() => parseCliArgs(["status", "--payload", "{}"])).toThrowError(CliError);
  });

  // The current provisioning contract
  // (`docs/decisions/18-semantic-model-provisioning.md`) requires a configure
  // RPC that downloads the embedding model to print
  // a clear notice, never download silently. The daemon (`runtime.ts`)
  // attaches a `semantic_model` field to `core:workspace_add`/
  // `core:workspace_configure`/`core:configuration_set` responses whenever
  // it actually provisioned something this call -- these tests drive the
  // CLI's rendering of that field with a stubbed `client.call`, entirely
  // independent of the daemon itself.
  it("prints a visible download notice for a configure RPC response carrying semantic_model: downloaded, only in human (non --json) output", async () => {
    const downloadedClient: CliDaemonClient = { call: vi.fn(async () => ({ outcome: "success", payload: { workspace_id: "w1", status: "indexing", registered: true, observation_started: true, semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", status: "downloaded" } } })) };

    const human = await runCli(["workspace-add", "/tmp/urdira-cli-notice-project", "--confirm"], { client: downloadedClient });
    expect(human.stdout).toContain('downloading embedding model Xenova/all-MiniLM-L6-v2 (first-time setup, one-time download)...\n');
    expect(human.stdout).toContain("model ready\n");

    const json = await runCli(["workspace-add", "/tmp/urdira-cli-notice-project", "--confirm", "--json"], { client: downloadedClient });
    expect(json.stdout).not.toContain("downloading embedding model");
    expect(JSON.parse(json.stdout)).toMatchObject({ result: { semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", status: "downloaded" } } });
  });

  it("prints a failure notice for status: failed, and no notice at all for status: present", async () => {
    const failedClient: CliDaemonClient = { call: vi.fn(async () => ({ outcome: "success", payload: { workspace_id: "w1", configuration_applied: true, reindex_required: false, observation_preserved: true, semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", status: "failed" } } })) };
    const failed = await runCli(["config-set", "w1", "--value", "{}", "--confirm"], { client: failedClient });
    expect(failed.stdout).toContain("could not be downloaded");

    const presentClient: CliDaemonClient = { call: vi.fn(async () => ({ outcome: "success", payload: { workspace_id: "w1", configuration_applied: true, reindex_required: false, observation_preserved: true, semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", status: "present" } } })) };
    const present = await runCli(["config-set", "w1", "--value", "{}", "--confirm"], { client: presentClient });
    expect(present.stdout).not.toContain("downloading embedding model");
    expect(present.stdout).not.toContain("could not be downloaded");
  });

  it("prints no notice at all when a configure RPC response carries no semantic_model field", async () => {
    const plainClient: CliDaemonClient = { call: vi.fn(async () => ({ outcome: "success", payload: { workspace_id: "w1", configuration_applied: true, reindex_required: false, observation_preserved: true } })) };
    const plain = await runCli(["config-set", "w1", "--value", "{}", "--confirm"], { client: plainClient });
    expect(plain.stdout).not.toContain("downloading embedding model");
    expect(plain.stdout).not.toContain("model ready");
    expect(plain.stdout).not.toContain("could not be downloaded");
  });
});
