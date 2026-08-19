import { agentStatus, installAgent, normalizeAgentClient, runAgentHook, uninstallAgent, type AgentClient } from "./agent-integration.js";
export * from "./agent-integration.js";

export type CliCommandName = "status" | "query" | "index" | "start" | "stop" | "restart" | "workspace-add" | "workspace-remove" | "workspace-purge" | "workspace-configure" | "config-set" | "repair" | "gc" | "reindex" | "agent-status" | "agent-install" | "agent-uninstall" | "agent-hook";
export const MUTATING_COMMANDS = ["start", "stop", "restart", "workspace-add", "workspace-remove", "workspace-purge", "workspace-configure", "config-set", "repair", "gc", "reindex"] as const satisfies ReadonlyArray<CliCommandName>;
const READ_ONLY_COMMANDS = ["status", "query", "index", "agent-status"] as const satisfies ReadonlyArray<CliCommandName>;
const ALL_COMMANDS = new Set<CliCommandName>([...READ_ONLY_COMMANDS, ...MUTATING_COMMANDS]);

export class CliError extends Error {
  constructor(readonly code: "cli:command_invalid" | "cli:option_invalid" | "cli:payload_invalid" | "cli:dry_run_required" | "cli:confirmation_required", message: string) { super(`${code}: ${message}`); this.name = "CliError"; }
}
export interface CliOptions { readonly json: boolean; readonly dry_run: boolean; readonly confirm: boolean; readonly payload?: unknown; readonly proposal_id?: string; readonly values: Readonly<Record<string, string>>; }
export interface CliCommand { readonly name: CliCommandName; readonly args: ReadonlyArray<string>; readonly options: CliOptions; }
export interface CliDaemonClient { readonly call: (call: string, payload: unknown) => Promise<{ readonly outcome: string; readonly payload?: unknown; readonly error?: unknown }>; }
export interface CliDependencies { readonly client: CliDaemonClient; readonly preview_admin?: (command: CliCommand) => Promise<unknown>; readonly execute_admin?: (command: CliCommand, preview: unknown) => Promise<unknown>; readonly prompt?: (question: string) => Promise<string | boolean>; readonly read_stdin?: () => Promise<string>; readonly home_directory?: string; }
export interface CliResult { readonly exit_code: number; readonly data: unknown; readonly stdout: string; }

const OPTION_NAMES = new Set(["json", "dry-run", "confirm", "payload", "proposal-id", "workspace", "path", "value", "engine-build-id", "client", "scope"]);
const READ_ONLY_OPTIONS: Readonly<Record<(typeof READ_ONLY_COMMANDS)[number], ReadonlySet<string>>> = { status: new Set(["json"]), query: new Set(["json", "payload", "workspace"]), index: new Set(["json", "workspace"]), "agent-status": new Set(["json", "client", "workspace"]) };
const INTERACTIVE_AGENT_CLIENTS: readonly AgentClient[] = ["claude-code", "codex", "opencode", "cursor", "vscode", "cline", "roo", "claude-desktop"];
function interactiveAgentSelection(value: string | boolean): { readonly native: ReadonlyArray<AgentClient>; readonly unknown: ReadonlyArray<string> } {
  if (value === true) return { native: INTERACTIVE_AGENT_CLIENTS, unknown: [] };
  const text = typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
  if (text === "" || ["n", "no", "none", "ninguno", "ninguna"].includes(text)) return { native: [], unknown: [] };
  if (["y", "yes", "si", "sí", "all", "todos", "todas"].includes(text)) return { native: INTERACTIVE_AGENT_CLIENTS, unknown: [] };
  const aliases: Readonly<Record<string, AgentClient>> = { claude: "claude-code", "claude-code": "claude-code", codex: "codex", opencode: "opencode", cursor: "cursor", "cursor-agent": "cursor", vscode: "vscode", "vs-code": "vscode", "copilot": "vscode", "github-copilot": "vscode", cline: "cline", roo: "roo", "roo-code": "roo", "claude-desktop": "claude-desktop", "claude-desktop-app": "claude-desktop" };
  const native: AgentClient[] = []; const unknown: string[] = [];
  for (const token of text.split(/[\s,;]+/u).filter(Boolean)) { const client = aliases[token]; if (client === undefined) unknown.push(token); else native.push(client); }
  return { native: [...new Set(native)], unknown: [...new Set(unknown)] };
}
async function configureInteractiveAgents(answer: string | boolean, home: string | undefined, workspace: string | undefined): Promise<unknown> {
  const selection = interactiveAgentSelection(answer);
  const installed = await Promise.all(selection.native.map(async (client) => { try { return await installAgent(client, { dry_run: false, confirm: true, ...(home === undefined ? {} : { home }), ...(workspace === undefined ? {} : { workspace }) }); } catch (error) { return { client, changed: false, error: error instanceof Error ? error.message : String(error) }; } }));
  return { installed, unknown: selection.unknown };
}
function parsePayload(value: string): unknown { try { return JSON.parse(value); } catch { throw new CliError("cli:payload_invalid", "--payload must contain valid JSON."); } }

export function parseCliArgs(argv: ReadonlyArray<string>): CliCommand {
  let [rawName, ...tokens] = argv;
  if (rawName === "workspace" || rawName === "config" || rawName === "daemon") {
    const action = tokens[0];
    const normalized = rawName === "workspace" && (action === "add" || action === "remove" || action === "purge" || action === "configure") ? `workspace-${action}` : rawName === "config" && action === "set" ? "config-set" : rawName === "daemon" && (action === "start" || action === "stop" || action === "restart") ? action : undefined;
    if (normalized) { rawName = normalized; tokens = tokens.slice(1); }
  }
  if (rawName === "agent") {
    const action = tokens[0];
    const normalized = action === "status" ? "agent-status" : action === "install" ? "agent-install" : action === "uninstall" ? "agent-uninstall" : action === "hook" ? "agent-hook" : undefined;
    if (normalized) { rawName = normalized; tokens = tokens.slice(1); }
  }
  if (!rawName || !ALL_COMMANDS.has(rawName as CliCommandName)) throw new CliError("cli:command_invalid", `Command ${rawName ?? ""} is not registered.`);
  const args: string[] = []; const values: Record<string, string> = {}; let json = false; let dryRun = false; let confirm = false; let payload: unknown; let proposalId: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) { args.push(token); continue; }
    const withoutPrefix = token.slice(2); const equals = withoutPrefix.indexOf("="); const name = equals >= 0 ? withoutPrefix.slice(0, equals) : withoutPrefix; const inline = equals >= 0 ? withoutPrefix.slice(equals + 1) : undefined;
    if (!OPTION_NAMES.has(name)) throw new CliError("cli:option_invalid", `Option --${name} is not registered.`);
    if ((READ_ONLY_COMMANDS as readonly string[]).includes(rawName) && !READ_ONLY_OPTIONS[rawName as (typeof READ_ONLY_COMMANDS)[number]].has(name)) throw new CliError("cli:option_invalid", `Option --${name} is not valid for ${rawName}.`);
    if (name === "json") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--json does not take a value."); json = true; continue; }
    if (name === "dry-run") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--dry-run does not take a value."); dryRun = true; continue; }
    if (name === "confirm") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--confirm does not take a value."); confirm = true; continue; }
    const value = inline ?? tokens[++index]; if (value === undefined || value.startsWith("--")) throw new CliError("cli:option_invalid", `Option --${name} requires a value.`);
    if (name === "payload") payload = parsePayload(value); else if (name === "proposal-id") proposalId = value; else values[name] = value;
  }
  if ((rawName === "status" || rawName === "index") && args.length > 0) throw new CliError("cli:command_invalid", `${rawName} does not accept positional arguments.`);
  return { name: rawName as CliCommandName, args, options: { json, dry_run: dryRun, confirm, ...(payload === undefined ? {} : { payload }), ...(proposalId === undefined ? {} : { proposal_id: proposalId }), values } };
}

const adminCall: Readonly<Record<(typeof MUTATING_COMMANDS)[number], string>> = { start: "core:daemon_start", stop: "core:daemon_stop", restart: "core:daemon_restart", "workspace-add": "core:workspace_add", "workspace-remove": "core:workspace_remove", "workspace-purge": "core:workspace_purge", "workspace-configure": "core:workspace_configure", "config-set": "core:configuration_set", repair: "core:repair", gc: "core:garbage_collect", reindex: "core:reindex" };
// Owner decision 2026-08-13 (docs/decisions/18-semantic-model-pack.md
// Outcome): a configure RPC that provisioned the embedding model must print
// a clear notice, never download silently. `resultPayload` is whatever an
// admin RPC's own `result:` field in `output`'s `data` already resolves to
// (see the two admin call sites below) -- this reads the SAME `semantic_model`
// field the daemon's `runtime.ts` attaches to `core:workspace_add`/
// `core:workspace_configure`/`core:configuration_set` responses
// (`SemanticModelProvisioningNotice`, `packages/daemon/src/semantic-provider-runtime.ts`),
// never a separate call. `"downloading"` and `"downloaded"` render the same
// notice text: every one of those three RPCs `await`s the ensure before
// responding (no backgrounded provisioning today), so by the time this CLI
// process sees `"downloaded"` the download already finished within this
// very command -- the "starting" and "ready" lines both belong on this one
// output. `"present"` (nothing to download) and a missing/malformed field
// print nothing.
function semanticModelNotice(resultPayload: unknown): string {
  const record = resultPayload !== null && typeof resultPayload === "object" ? resultPayload as { readonly semantic_model?: unknown } : {};
  const model = record.semantic_model !== null && typeof record.semantic_model === "object" ? record.semantic_model as { readonly model_id?: unknown; readonly status?: unknown } : undefined;
  if (model === undefined || typeof model.model_id !== "string" || typeof model.status !== "string") return "";
  if (model.status === "downloading") return `downloading embedding model ${model.model_id} (first-time setup, one-time download)...\n`;
  if (model.status === "downloaded") return `downloading embedding model ${model.model_id} (first-time setup, one-time download)...\nmodel ready\n`;
  if (model.status === "failed") return `embedding model ${model.model_id} could not be downloaded -- semantic search stays unavailable until a later configure command succeeds\n`;
  return "";
}
function output(data: unknown, json: boolean, notice = ""): string {
  const body = json ? `${JSON.stringify(data)}\n` : typeof data === "string" ? `${data}\n` : `${JSON.stringify(data)}\n`;
  return json ? body : `${notice}${body}`;
}
// Both the interactive confirm path and the `--confirm` scripted path confirm the
// same detection preview, so they must derive the same default plugin/technology selection from
// it -- the full set of technologies (and their compatible plugins) the daemon's
// `core:workspace_preview` proposed, exactly what an interactive "yes" would confirm.
function pluginSelectionFromPreview(preview: unknown): { readonly selected_technology_ids: ReadonlyArray<string>; readonly selected_plugin_ids: ReadonlyArray<string> } {
  const proposalRecord = preview !== null && typeof preview === "object" ? preview as { readonly technologies?: readonly { readonly technology_id?: unknown; readonly compatible_plugin_ids?: readonly unknown[] }[] } : {};
  const selected_technology_ids = (proposalRecord.technologies ?? []).map((technology) => technology.technology_id).filter((value): value is string => typeof value === "string");
  const selected_plugin_ids = [...new Set((proposalRecord.technologies ?? []).flatMap((technology) => technology.compatible_plugin_ids ?? []).filter((value): value is string => typeof value === "string"))];
  return { selected_technology_ids, selected_plugin_ids };
}

export async function runCli(argv: ReadonlyArray<string>, dependencies: CliDependencies): Promise<CliResult> {
  const command = parseCliArgs(argv);
  if (command.name === "agent-status" || command.name === "agent-install" || command.name === "agent-uninstall" || command.name === "agent-hook") {
    const requested = normalizeAgentClient(command.options.values["client"] ?? (command.name === "agent-hook" ? undefined : "all"));
    if (command.name !== "agent-hook" && command.options.values["scope"] !== undefined && command.options.values["scope"] !== "user") throw new CliError("cli:option_invalid", "Agent integration currently supports only --scope user.");
    if (command.name === "agent-hook") {
      const payload = command.options.payload ?? (dependencies.read_stdin ? JSON.parse(await dependencies.read_stdin()) : undefined);
      if (payload === undefined) throw new CliError("cli:payload_invalid", "agent hook requires JSON on stdin or --payload.");
      const data = await runAgentHook(payload, dependencies.client, requested === "all" ? undefined : requested);
      return { exit_code: 0, data, stdout: output(data, command.options.json) };
    }
    const clients: readonly AgentClient[] = requested === "all" ? ["claude-code", "codex", "opencode", "cursor", "vscode", "cline", "roo", "claude-desktop"] : [requested];
    if (command.name === "agent-status") {
      const data = await Promise.all(clients.map((client) => agentStatus(client, { ...(dependencies.home_directory === undefined ? {} : { home: dependencies.home_directory }), ...(command.options.values["workspace"] === undefined ? {} : { workspace: command.options.values["workspace"] }) })));
      const result = { clients: data };
      return { exit_code: 0, data: result, stdout: output(result, command.options.json) };
    }
    if (command.options.dry_run === command.options.confirm) throw new CliError("cli:dry_run_required", "Use exactly one of --dry-run or --confirm for agent installation changes.");
    const operation = command.name === "agent-install" ? installAgent : uninstallAgent;
    const data = await Promise.all(clients.map((client) => operation(client, { dry_run: command.options.dry_run, confirm: command.options.confirm, ...(dependencies.home_directory === undefined ? {} : { home: dependencies.home_directory }), ...(command.options.values["workspace"] === undefined ? {} : { workspace: command.options.values["workspace"] }) })));
    return { exit_code: 0, data: { clients: data }, stdout: output({ clients: data }, command.options.json) };
  }
  if ((MUTATING_COMMANDS as readonly string[]).includes(command.name)) {
    const mutationName = command.name as (typeof MUTATING_COMMANDS)[number];
    const directCommand = mutationName === "stop";
    const preview = dependencies.preview_admin ? await dependencies.preview_admin(command) : { command: mutationName, call: adminCall[mutationName], args: command.args, values: command.options.values };
    if (!command.options.dry_run && !command.options.confirm && dependencies.prompt && (mutationName === "workspace-add" || mutationName === "workspace-configure")) {
      const technologyAnswer = await dependencies.prompt(`Confirm detected technologies for ${mutationName}?`);
      const pluginAnswer = await dependencies.prompt("Confirm compatible plugins and start observation?");
      const accepted = (value: string | boolean): boolean => value === true || (typeof value === "string" && ["y", "yes", "si", "sí"].includes(value.trim().toLocaleLowerCase("en-US")));
      if (!accepted(technologyAnswer) || !accepted(pluginAnswer)) {
        const data = { dry_run: false, confirmed: false, interactive: true, command: mutationName, preview };
        return { exit_code: 0, data, stdout: output(data, command.options.json) };
      }
      const selection = pluginSelectionFromPreview(preview);
      const result = dependencies.execute_admin ? await dependencies.execute_admin(command, preview) : await dependencies.client.call(adminCall[mutationName], { args: command.args, values: command.options.values, ...(command.options.proposal_id === undefined ? {} : { proposal_id: command.options.proposal_id }), ...(command.options.payload === undefined ? {} : { payload: command.options.payload }), selected_technology_ids: selection.selected_technology_ids, selected_plugin_ids: selection.selected_plugin_ids, confirmed: true, preview });
      const resultPayload = "outcome" in (result as object) ? (result as { readonly payload?: unknown; readonly error?: unknown }).payload ?? (result as { readonly error?: unknown }).error ?? result : result;
      const integrationAnswer = mutationName === "workspace-add" ? await dependencies.prompt("Configure Urdira in an agent now? Enter yes/all, or a comma-separated list (claude-code, codex, opencode, cursor, vscode/copilot, cline, roo, claude-desktop). Enter no to skip.") : undefined;
      const agent_integrations = integrationAnswer === undefined ? undefined : await configureInteractiveAgents(integrationAnswer, dependencies.home_directory, command.args[0]);
      const data = { dry_run: false, confirmed: true, interactive: true, command: mutationName, preview, result: resultPayload, ...(agent_integrations === undefined ? {} : { agent_integrations }) };
      return { exit_code: "outcome" in (result as object) && (result as { readonly outcome: string }).outcome !== "success" ? 1 : 0, data, stdout: output(data, command.options.json, semanticModelNotice(resultPayload)) };
    }
    if (!directCommand && !command.options.dry_run && !command.options.confirm) throw new CliError("cli:dry_run_required", `Administrative command ${command.name} requires either --dry-run to preview or --confirm to execute.`);
    if (!command.options.confirm && (!directCommand || command.options.dry_run)) { const data = { dry_run: true, confirmed: false, command: mutationName, preview }; return { exit_code: 0, data, stdout: output(data, command.options.json) }; }
    // A scripted `--confirm` run never visits the interactive branch above, so without this it
    // silently registered plugin-less workspaces: `workspace-add`
    // defaults to the same full preview-derived selection the interactive path would confirm,
    // unless the caller passes an explicit `--payload` with its own `selected_plugin_ids`/`selected_technology_ids`.
    const explicitSelection = mutationName === "workspace-add" && command.options.payload !== null && typeof command.options.payload === "object" ? command.options.payload as { readonly selected_technology_ids?: unknown; readonly selected_plugin_ids?: unknown } : undefined;
    const defaultSelection = mutationName === "workspace-add" ? pluginSelectionFromPreview(preview) : undefined;
    const selectionFields = defaultSelection === undefined ? {} : { selected_technology_ids: Array.isArray(explicitSelection?.selected_technology_ids) ? explicitSelection.selected_technology_ids.filter((value): value is string => typeof value === "string") : defaultSelection.selected_technology_ids, selected_plugin_ids: Array.isArray(explicitSelection?.selected_plugin_ids) ? explicitSelection.selected_plugin_ids.filter((value): value is string => typeof value === "string") : defaultSelection.selected_plugin_ids };
    const result = dependencies.execute_admin ? await dependencies.execute_admin(command, preview) : await dependencies.client.call(adminCall[mutationName], { args: command.args, values: command.options.values, ...(command.options.proposal_id === undefined ? {} : { proposal_id: command.options.proposal_id }), ...(command.options.payload === undefined ? {} : { payload: command.options.payload }), ...selectionFields, confirmed: command.options.confirm, preview });
    const resultPayload = "outcome" in (result as object) ? (result as { readonly payload?: unknown; readonly error?: unknown }).payload ?? (result as { readonly error?: unknown }).error ?? result : result;
    const data = { dry_run: false, confirmed: true, command: mutationName, preview, result: resultPayload };
    return { exit_code: "outcome" in (result as object) && (result as { readonly outcome: string }).outcome !== "success" ? 1 : 0, data, stdout: output(data, command.options.json, semanticModelNotice(resultPayload)) };
  }
  const call = command.name === "status" ? "core:status" : command.name === "index" ? "core:index_status" : "core:query";
  const data = await dependencies.client.call(call, command.options.payload ?? { args: command.args, values: command.options.values });
  return { exit_code: data.outcome === "success" ? 0 : 1, data: data.payload ?? data.error ?? data, stdout: output(data.payload ?? data.error ?? data, command.options.json) };
}
