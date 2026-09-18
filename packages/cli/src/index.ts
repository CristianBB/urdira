import { AGENT_CLIENTS, agentStatus, installAgent, normalizeAgentClient, runAgentHook, uninstallAgent, type AgentClient } from "./agent-integration.js";
export * from "./agent-integration.js";

export type CliCommandName = "status" | "query" | "index" | "start" | "stop" | "restart" | "workspace-list" | "workspace-show" | "workspace-footprint" | "workspace-add" | "workspace-remove" | "workspace-purge" | "workspace-configure" | "workspace-orphans" | "workspace-orphans-purge" | "codebase-list" | "codebase-create" | "codebase-rename" | "codebase-assign" | "codebase-unassign" | "codebase-remove" | "config-set" | "repair" | "gc" | "reindex" | "index-pack-export" | "agent-status" | "agent-install" | "agent-uninstall" | "agent-hook";
// `index-pack-export` (docs/decisions/23-index-pack.md) never mutates
// `workspace_registry` or any published generation -- it only writes a pack
// file to local disk -- but it is routed through the MUTATING_COMMANDS
// dispatch anyway rather than READ_ONLY_COMMANDS: it needs two positional
// args plus `--out`, which READ_ONLY_COMMANDS' hardcoded no-positional-args
// rule (`status`/`index`) does not accommodate, and MUTATING_COMMANDS'
// preview/confirm dance is a harmless formality for a genuinely idempotent,
// non-destructive export. Index pack IMPORT has no separate verb: it rides
// `workspace-add --index-pack <path>` (see that option below), since import
// is only ever valid on a genuinely fresh, never-scanned workspace -- which
// `workspace-add` is the only command that creates.
// `workspace-orphans` (plan §6, Frente H) is a plain query command, exactly
// like `workspace-list`/`workspace-show`: it always re-sweeps the data root
// before answering rather than reading a cached value, but it deletes
// nothing and never mutates the registry, so it must NOT sit in
// `MUTATING_COMMANDS` -- that list's `--dry-run`/`--confirm` gate is for
// commands whose default direct-call behavior is "reject without one of
// those flags" (see the two `directCommand` exceptions below, both daemon
// lifecycle verbs). `workspace-orphans-purge` IS genuinely destructive and
// follows the ordinary `--dry-run`/`--confirm` gate every other destructive
// command here does.
export const MUTATING_COMMANDS = ["start", "stop", "restart", "workspace-add", "workspace-remove", "workspace-purge", "workspace-configure", "workspace-orphans-purge", "codebase-create", "codebase-rename", "codebase-assign", "codebase-unassign", "codebase-remove", "config-set", "repair", "gc", "reindex", "index-pack-export"] as const satisfies ReadonlyArray<CliCommandName>;
const READ_ONLY_COMMANDS = ["status", "query", "index", "workspace-list", "workspace-show", "workspace-footprint", "workspace-orphans", "codebase-list", "agent-status"] as const satisfies ReadonlyArray<CliCommandName>;
const ALL_COMMANDS = new Set<CliCommandName>([...READ_ONLY_COMMANDS, ...MUTATING_COMMANDS, "agent-install", "agent-uninstall", "agent-hook"]);

export interface CliCommandDescriptor {
  readonly api_version: 1;
  readonly command: CliCommandName | "mcp" | "web";
  readonly label: string;
  readonly category: "query" | "workspace" | "codebase" | "daemon" | "agent" | "maintenance" | "service";
  readonly execution: "read_only" | "administrative" | "service_active";
  readonly confirmation: "none" | "proposal" | "destructive";
  readonly cancellable: boolean;
  readonly arguments: readonly { readonly name: string; readonly required: boolean; readonly description: string }[];
  readonly options: readonly string[];
  readonly input_schema: Readonly<Record<string, unknown>>;
}

const descriptor = (command: CliCommandDescriptor["command"], label: string, category: CliCommandDescriptor["category"], execution: CliCommandDescriptor["execution"], confirmation: CliCommandDescriptor["confirmation"], args: CliCommandDescriptor["arguments"] = [], options: readonly string[] = [], choices: Readonly<Record<string, readonly string[]>> = {}): CliCommandDescriptor => ({
  api_version: 1, command, label, category, execution, confirmation, cancellable: false, arguments: args, options,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      args: { type: "array", prefixItems: args.map((entry) => ({ type: "string", description: entry.description })), minItems: args.filter((entry) => entry.required).length, maxItems: args.length },
      options: { type: "object", additionalProperties: false, properties: Object.fromEntries(options.map((name) => [name, choices[name] === undefined ? { type: ["string", "boolean", "number", "object"] } : { type: "string", enum: choices[name] }])) },
    },
    required: ["args", "options"],
  },
});
const arg = (name: string, description: string, required = true): CliCommandDescriptor["arguments"][number] => ({ name, required, description });

/** Authoritative, closed command catalog consumed by both the terminal parser and the local web UI. */
export const CLI_COMMAND_CATALOG: readonly CliCommandDescriptor[] = [
  descriptor("status", "Status", "query", "read_only", "none", [], ["json", "debug-timing"]), descriptor("index", "Index status", "query", "read_only", "none", [], ["workspace", "json", "debug-timing"]), descriptor("query", "Query", "query", "read_only", "none", [], ["payload", "workspace", "json", "debug-timing"]),
  descriptor("workspace-list", "List workspaces", "workspace", "read_only", "none", [], ["json", "debug-timing"]), descriptor("workspace-show", "Show workspace", "workspace", "read_only", "none", [arg("workspace", "Workspace identifier")], ["json", "debug-timing"]), descriptor("workspace-footprint", "Measure workspace storage", "workspace", "read_only", "none", [arg("workspace", "Optional workspace identifier", false)], ["json", "debug-timing"]), descriptor("workspace-add", "Add workspace", "workspace", "administrative", "proposal", [arg("path", "Workspace directory")], ["path", "payload", "proposal-id", "index-pack", "dry-run", "confirm", "json", "debug-timing"]), descriptor("workspace-configure", "Configure workspace", "workspace", "administrative", "proposal", [arg("workspace", "Workspace identifier")], ["payload", "proposal-id", "dry-run", "confirm", "json", "debug-timing"]), descriptor("workspace-remove", "Remove workspace", "workspace", "administrative", "destructive", [arg("workspace", "Workspace identifier")], ["dry-run", "confirm", "json", "debug-timing"]), descriptor("workspace-purge", "Purge workspace", "workspace", "administrative", "destructive", [arg("workspace", "Removed workspace identifier")], ["payload", "dry-run", "confirm", "json", "debug-timing"]), descriptor("workspace-orphans", "List orphaned workspace data", "workspace", "read_only", "none", [], ["json", "debug-timing"]), descriptor("workspace-orphans-purge", "Purge orphaned workspace data", "workspace", "administrative", "destructive", [], ["all", "dry-run", "confirm", "json", "debug-timing"]),
  descriptor("codebase-list", "List codebases", "codebase", "read_only", "none", [], ["json", "debug-timing"]), descriptor("codebase-create", "Create codebase", "codebase", "administrative", "proposal", [arg("display_name", "Project display name")], ["vcs-identity", "dry-run", "confirm", "json", "debug-timing"]), descriptor("codebase-rename", "Rename project", "codebase", "administrative", "proposal", [arg("codebase", "Codebase identifier"), arg("display_name", "New project display name")], ["dry-run", "confirm", "json", "debug-timing"]), descriptor("codebase-assign", "Assign workspace", "codebase", "administrative", "proposal", [arg("workspace", "Workspace identifier"), arg("codebase", "Codebase identifier")], ["dry-run", "confirm", "json", "debug-timing"]), descriptor("codebase-unassign", "Unassign workspace", "codebase", "administrative", "proposal", [arg("workspace", "Workspace identifier")], ["dry-run", "confirm", "json", "debug-timing"]), descriptor("codebase-remove", "Remove codebase", "codebase", "administrative", "destructive", [arg("codebase", "Codebase identifier")], ["dry-run", "confirm", "json", "debug-timing"]),
  descriptor("start", "Start daemon", "daemon", "administrative", "none", [], ["dry-run", "json", "debug-timing"]), descriptor("stop", "Stop daemon", "daemon", "administrative", "none", [], ["dry-run", "json", "debug-timing"]), descriptor("restart", "Restart daemon", "daemon", "administrative", "none", [], ["dry-run", "json", "debug-timing"]), descriptor("mcp", "MCP service", "service", "service_active", "none"), descriptor("web", "Web service", "service", "service_active", "none"),
  descriptor("config-set", "Set configuration", "maintenance", "administrative", "proposal", [arg("workspace", "Workspace identifier", false)], ["workspace", "value", "payload", "proposal-id", "dry-run", "confirm", "json", "debug-timing"]), descriptor("repair", "Repair", "maintenance", "administrative", "proposal", [arg("workspace", "Workspace identifier", false)], ["workspace", "payload", "dry-run", "confirm", "json", "debug-timing"]), descriptor("gc", "Collect garbage", "maintenance", "administrative", "proposal", [], ["payload", "dry-run", "confirm", "json", "debug-timing"]), descriptor("reindex", "Reindex", "maintenance", "administrative", "proposal", [arg("workspace", "Workspace identifier", false)], ["workspace", "dry-run", "confirm", "json", "debug-timing"]), descriptor("index-pack-export", "Export index pack", "maintenance", "administrative", "proposal", [arg("workspace", "Workspace identifier"), arg("out", "Output file", false)], ["workspace", "out", "require-git-clean", "timeout", "dry-run", "confirm", "json", "debug-timing"]),
  descriptor("agent-status", "Agent status", "agent", "read_only", "none", [], ["client", "workspace", "json", "debug-timing"], { client: ["all", ...AGENT_CLIENTS] }), descriptor("agent-install", "Install agent integration", "agent", "administrative", "proposal", [], ["client", "workspace", "scope", "dry-run", "confirm", "json", "debug-timing"], { client: ["all", ...AGENT_CLIENTS], scope: ["user"] }), descriptor("agent-uninstall", "Uninstall agent integration", "agent", "administrative", "proposal", [], ["client", "workspace", "scope", "dry-run", "confirm", "json", "debug-timing"], { client: ["all", ...AGENT_CLIENTS], scope: ["user"] }), descriptor("agent-hook", "Agent hook", "agent", "read_only", "none", [], ["client", "payload", "json", "debug-timing"], { client: AGENT_CLIENTS }),
] as const;

export class CliError extends Error {
  constructor(readonly code: "cli:command_invalid" | "cli:option_invalid" | "cli:payload_invalid" | "cli:dry_run_required" | "cli:confirmation_required", message: string) { super(`${code}: ${message}`); this.name = "CliError"; }
}
export interface CliOptions { readonly json: boolean; readonly dry_run: boolean; readonly confirm: boolean; readonly debug_timing: boolean; readonly payload?: unknown; readonly proposal_id?: string; readonly values: Readonly<Record<string, string>>; }
export interface CliCommand { readonly name: CliCommandName; readonly args: ReadonlyArray<string>; readonly options: CliOptions; }
export interface CliDaemonClient { readonly call: (call: string, payload: unknown) => Promise<{ readonly outcome: string; readonly payload?: unknown; readonly error?: unknown }>; }
export interface CliDependencies { readonly client: CliDaemonClient; readonly preview_admin?: (command: CliCommand) => Promise<unknown>; readonly execute_admin?: (command: CliCommand, preview: unknown) => Promise<unknown>; readonly prompt?: (question: string) => Promise<string | boolean>; readonly read_stdin?: () => Promise<string>; readonly home_directory?: string; readonly agent_launcher?: readonly string[]; }
export interface CliResult { readonly exit_code: number; readonly data: unknown; readonly stdout: string; }

const OPTION_NAMES = new Set(["json", "dry-run", "confirm", "debug-timing", "payload", "proposal-id", "workspace", "workspace-root", "path", "value", "vcs-identity", "engine-build-id", "client", "scope", "index-pack", "out", "require-git-clean", "all", "timeout"]);
// --debug-timing is a process/runtime diagnostic switch, not part of any
// request payload. It is therefore accepted uniformly on read-only commands
// as well as lifecycle/admin commands; the app entrypoint consumes it before
// creating a daemon or client.
const READ_ONLY_OPTIONS: Readonly<Record<(typeof READ_ONLY_COMMANDS)[number], ReadonlySet<string>>> = { status: new Set(["json", "debug-timing"]), query: new Set(["json", "payload", "workspace", "debug-timing"]), index: new Set(["json", "workspace", "debug-timing"]), "workspace-list": new Set(["json", "debug-timing"]), "workspace-show": new Set(["json", "debug-timing"]), "workspace-footprint": new Set(["json", "debug-timing"]), "workspace-orphans": new Set(["json", "debug-timing"]), "codebase-list": new Set(["json", "debug-timing"]), "agent-status": new Set(["json", "client", "workspace", "debug-timing"]) };
const INTERACTIVE_AGENT_CLIENTS: readonly AgentClient[] = AGENT_CLIENTS;
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
async function configureInteractiveAgents(answer: string | boolean, home: string | undefined, workspace: string | undefined, launcher?: readonly string[]): Promise<unknown> {
  const selection = interactiveAgentSelection(answer);
  const installed = await Promise.all(selection.native.map(async (client) => { try { return await installAgent(client, { dry_run: false, confirm: true, ...(launcher === undefined ? {} : { launcher }), ...(home === undefined ? {} : { home }), ...(workspace === undefined ? {} : { workspace }) }); } catch (error) { return { client, changed: false, error: error instanceof Error ? error.message : String(error) }; } }));
  return { installed, unknown: selection.unknown };
}
function parsePayload(value: string): unknown { try { return JSON.parse(value); } catch { throw new CliError("cli:payload_invalid", "--payload must contain valid JSON."); } }

export function parseCliArgs(argv: ReadonlyArray<string>): CliCommand {
  let [rawName, ...tokens] = argv;
  if (rawName === "workspace" && tokens[0] === "orphans") {
    // Two-level subcommand (`workspace orphans` / `workspace orphans
    // purge`), unlike every other `workspace <action>` verb below which is
    // exactly one token -- consume one extra token only when it is "purge".
    rawName = tokens[1] === "purge" ? "workspace-orphans-purge" : "workspace-orphans";
    tokens = tokens.slice(tokens[1] === "purge" ? 2 : 1);
  } else if (rawName === "workspace" || rawName === "codebase" || rawName === "config" || rawName === "daemon") {
    const action = tokens[0];
    const normalized = rawName === "workspace" && (action === "list" || action === "show" || action === "footprint" || action === "add" || action === "remove" || action === "purge" || action === "configure") ? `workspace-${action}` : rawName === "codebase" && (action === "list" || action === "create" || action === "rename" || action === "assign" || action === "unassign" || action === "remove") ? `codebase-${action}` : rawName === "config" && action === "set" ? "config-set" : rawName === "daemon" && (action === "start" || action === "stop" || action === "restart") ? action : undefined;
    if (normalized) { rawName = normalized; tokens = tokens.slice(1); }
  }
  if (rawName === "agent") {
    const action = tokens[0];
    const normalized = action === "status" ? "agent-status" : action === "install" ? "agent-install" : action === "uninstall" ? "agent-uninstall" : action === "hook" ? "agent-hook" : undefined;
    if (normalized) { rawName = normalized; tokens = tokens.slice(1); }
  }
  if (!rawName || !ALL_COMMANDS.has(rawName as CliCommandName)) throw new CliError("cli:command_invalid", `Command ${rawName ?? ""} is not registered.`);
  const args: string[] = []; const values: Record<string, string> = {}; let json = false; let dryRun = false; let confirm = false; let debugTiming = false; let payload: unknown; let proposalId: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) { args.push(token); continue; }
    const withoutPrefix = token.slice(2); const equals = withoutPrefix.indexOf("="); const name = equals >= 0 ? withoutPrefix.slice(0, equals) : withoutPrefix; const inline = equals >= 0 ? withoutPrefix.slice(equals + 1) : undefined;
    if (!OPTION_NAMES.has(name)) throw new CliError("cli:option_invalid", `Option --${name} is not registered.`);
    if ((READ_ONLY_COMMANDS as readonly string[]).includes(rawName) && !READ_ONLY_OPTIONS[rawName as (typeof READ_ONLY_COMMANDS)[number]].has(name)) throw new CliError("cli:option_invalid", `Option --${name} is not valid for ${rawName}.`);
    if (name === "json") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--json does not take a value."); json = true; continue; }
    if (name === "dry-run") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--dry-run does not take a value."); dryRun = true; continue; }
    if (name === "confirm") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--confirm does not take a value."); confirm = true; continue; }
    if (name === "debug-timing") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--debug-timing does not take a value."); debugTiming = true; continue; }
    // `--all` (`workspace orphans purge --all`, plan §6 Frente H): a bare
    // boolean flag exactly like the four above, not a value-taking option
    // like `--require-git-clean` -- recorded in `values` (rather than a
    // dedicated `CliOptions` field, since only this one command reads it)
    // so `core:workspace_orphans_purge`'s daemon handler sees it the same
    // way it sees every other free-form `--name value` option.
    if (name === "all") { if (inline !== undefined) throw new CliError("cli:option_invalid", "--all does not take a value."); values["all"] = "true"; continue; }
    const value = inline ?? tokens[++index]; if (value === undefined || value.startsWith("--")) throw new CliError("cli:option_invalid", `Option --${name} requires a value.`);
    if (name === "payload") payload = parsePayload(value); else if (name === "proposal-id") proposalId = value; else values[name] = value;
  }
  if ((rawName === "status" || rawName === "index") && args.length > 0) throw new CliError("cli:command_invalid", `${rawName} does not accept positional arguments.`);
  return { name: rawName as CliCommandName, args, options: { json, dry_run: dryRun, confirm, debug_timing: debugTiming, ...(payload === undefined ? {} : { payload }), ...(proposalId === undefined ? {} : { proposal_id: proposalId }), values } };
}

const adminCall: Readonly<Record<(typeof MUTATING_COMMANDS)[number], string>> = { start: "core:daemon_start", stop: "core:daemon_stop", restart: "core:daemon_restart", "workspace-add": "core:workspace_add", "workspace-remove": "core:workspace_remove", "workspace-purge": "core:workspace_purge", "workspace-configure": "core:workspace_configure", "workspace-orphans-purge": "core:workspace_orphans_purge", "codebase-create": "core:codebase_create", "codebase-rename": "core:codebase_rename", "codebase-assign": "core:codebase_assign", "codebase-unassign": "core:codebase_unassign", "codebase-remove": "core:codebase_remove", "config-set": "core:configuration_set", repair: "core:repair", gc: "core:garbage_collect", reindex: "core:reindex", "index-pack-export": "core:index_pack_export" };
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function padColumn(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatByteCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value;
  let unit: (typeof units)[number] = units[0];
  for (const candidate of units) {
    scaled /= 1024;
    unit = candidate;
    if (scaled < 1024 || candidate === units.at(-1)) break;
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${unit}`;
}

/** Human-readable summary; `--json` retains the exact byte counters and per-entry detail. */
function formatWorkspaceFootprintResult(resultPayload: unknown): string | undefined {
  const record = isPlainRecord(resultPayload) ? resultPayload : {};
  const workspaces = Array.isArray(record["workspaces"]) ? record["workspaces"].filter(isPlainRecord) : undefined;
  if (workspaces === undefined) return undefined;
  if (workspaces.length === 0) return "no workspaces registered";
  const headers = ["WORKSPACE", "SOURCE", "CATALOG", "STRUCTURAL", "LEXICAL", "SEMANTIC", "SIDECAR", "EXCLUSIVE", "CAS_REF", "RATIO"] as const;
  const rows = workspaces.map((workspace) => {
    const layers = isPlainRecord(workspace["layers"]) ? workspace["layers"] : {};
    const bytes = (layer: string): unknown => isPlainRecord(layers[layer]) ? layers[layer]!["allocated_bytes"] ?? layers[layer]!["logical_bytes"] : undefined;
    const id = typeof workspace["workspace_id"] === "string" ? workspace["workspace_id"] : "?";
    const root = typeof workspace["display_root"] === "string" ? workspace["display_root"] : undefined;
    const ratio = typeof workspace["exclusive_amplification_ratio"] === "number" ? `${workspace["exclusive_amplification_ratio"].toFixed(2)}x` : "-";
    const cas = isPlainRecord(workspace["referenced_cas"]) ? workspace["referenced_cas"] : {};
    return [
      root === undefined ? id : `${id} (${root})`,
      formatByteCount(workspace["indexed_source_bytes"]),
      formatByteCount(bytes("catalog")),
      formatByteCount(bytes("structural")),
      formatByteCount(bytes("lexical")),
      formatByteCount(bytes("semantic")),
      formatByteCount(bytes("scan_sidecar")),
      formatByteCount(workspace["exclusive_allocated_bytes"] ?? workspace["exclusive_logical_bytes"]),
      formatByteCount(cas["allocated_bytes"] ?? cas["logical_bytes"]),
      ratio,
    ];
  });
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)));
  const renderRow = (cells: readonly string[]): string => cells.map((cell, column) => padColumn(cell, widths[column]!)).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow), "CAS_REF is referenced shared storage and is not included in EXCLUSIVE."].join("\n");
}

/**
 * v4 (plan §6, Frente H): one `urdira workspace orphans[/purge]` row per
 * orphaned data set (`OrphanGroup`, `@urdira/daemon`'s `orphan-sweep.ts`),
 * `--json` bypasses this entirely (see the two call sites below) exactly
 * like `formatIndexStatusTable`.
 */
function formatOrphanTable(groups: unknown): string {
  const rows = Array.isArray(groups) ? groups.filter(isPlainRecord) : [];
  if (rows.length === 0) return "no orphaned workspace data found";
  const headers = ["SAFE_ID", "BYTES", "ENTRIES", "KIND"] as const;
  const tableRows = rows.map((group) => {
    const safeId = typeof group["safe_id"] === "string" ? group["safe_id"] : "?";
    const bytes = typeof group["total_bytes"] === "number" ? String(group["total_bytes"]) : "0";
    const entries = Array.isArray(group["entries"]) ? group["entries"].filter(isPlainRecord) : [];
    const kinds = [...new Set(entries.map((entry) => typeof entry["kind"] === "string" ? entry["kind"] : "unknown"))];
    return [safeId, bytes, String(entries.length), kinds.join(",")];
  });
  const widths = headers.map((header, column) => Math.max(header.length, ...tableRows.map((row) => row[column]!.length)));
  const renderRow = (cells: readonly string[]): string => cells.map((cell, column) => padColumn(cell, widths[column]!)).join("  ").trimEnd();
  return [renderRow(headers), ...tableRows.map(renderRow)].join("\n");
}

/**
 * Non-`--json` rendering for `workspace-show`; `undefined` when the payload
 * has no recognizable `workspace` object (the caller falls back to the raw
 * JSON payload, which already carries `status`/`last_scan_error`/
 * `last_scan_error_at` verbatim -- `workspaceAdministrativeView`,
 * `packages/daemon/src/runtime.ts`, spreads the raw `RegisteredWorkspace`).
 * This is purely a human-terminal summary line for a failed scan
 * (2026-09-08 P0 fix, `docs/evidence/2026-09-07-v4-vscode-campaign.md` §4.0):
 * a workspace stuck reporting `status: "indexing"` forever after a scan
 * failure used to be silent in this exact command's own text output.
 */
function formatWorkspaceShowResult(resultPayload: unknown): string | undefined {
  const record = isPlainRecord(resultPayload) ? resultPayload : {};
  const workspace = isPlainRecord(record["workspace"]) ? record["workspace"] : undefined;
  if (workspace === undefined) return undefined;
  const id = typeof workspace["workspace_id"] === "string" ? workspace["workspace_id"] : "?";
  const root = typeof workspace["display_root"] === "string" ? workspace["display_root"] : undefined;
  const status = typeof workspace["status"] === "string" ? workspace["status"] : "unknown";
  const lines = [`workspace: ${id}${root !== undefined ? ` (${root})` : ""}`, `status: ${status}`];
  if (typeof workspace["last_scan_error"] === "string") {
    const at = typeof workspace["last_scan_error_at"] === "string" ? ` at ${workspace["last_scan_error_at"]}` : "";
    lines.push(`last_scan_error: ${workspace["last_scan_error"]}${at}`);
  }
  return [lines.join("\n"), JSON.stringify(workspace)].join("\n");
}

/** Non-`--json` rendering for `workspace-orphans`/`workspace-orphans-purge`; `undefined` for every other command (the caller falls back to the raw JSON payload). */
function formatOrphanCommandResult(mutationName: string, resultPayload: unknown): string | undefined {
  const record = isPlainRecord(resultPayload) ? resultPayload : {};
  if (mutationName === "workspace-orphans") {
    const lines = [formatOrphanTable(record["orphans"])];
    if (Array.isArray(record["retained_stale"]) && record["retained_stale"].length > 0) lines.push(`retained_stale: ${record["retained_stale"].length} (never purged automatically -- see docs on outdated-database recovery)`);
    if (Array.isArray(record["in_progress"]) && record["in_progress"].length > 0) lines.push(`in_progress: ${record["in_progress"].length} (fork staging under an hour old)`);
    return lines.join("\n");
  }
  if (mutationName === "workspace-orphans-purge") {
    const purged = Array.isArray(record["purged"]) ? record["purged"] : [];
    const bytesFreed = typeof record["bytes_freed"] === "number" ? record["bytes_freed"] : 0;
    return [`purged ${purged.length} orphaned data set(s), freed ${bytesFreed} bytes`, formatOrphanTable(record["remaining"])].join("\n");
  }
  return undefined;
}

/**
 * P4-d: one `urdira index` row per workspace. Additive to a v3 workspace's
 * existing `structural_ready`/`semantic_ready` booleans (`storage_format`
 * is only ever "v3"/"v4" -- see `v4StatusFields`, `packages/daemon/src/
 * runtime.ts`) -- a v3 row's STRUCTURAL/LEXICAL/SEMANTIC cells read "ready"/
 * "not ready" exactly as they would have before this task, while a v4 row
 * shows the queryable/durable and completed generation pair plus a
 * "(lagging)" tag whenever the daemon's own `queryable`/`current` booleans
 * say a lane has not caught up to the latest scan yet.
 */
function indexStatusRow(workspace: Readonly<Record<string, unknown>>): { readonly workspace: string; readonly status: string; readonly format: string; readonly structural: string; readonly lexical: string; readonly semantic: string; readonly last_scan: string } {
  const id = typeof workspace["workspace_id"] === "string" ? workspace["workspace_id"] : "?";
  const root = typeof workspace["display_root"] === "string" ? workspace["display_root"] : undefined;
  const status = typeof workspace["workspace_status"] === "string" ? workspace["workspace_status"] : "unknown";
  const format = typeof workspace["storage_format"] === "string" ? workspace["storage_format"] : "v3";
  const structural = isPlainRecord(workspace["structural"]) ? workspace["structural"] : {};
  const lexical = isPlainRecord(workspace["lexical"]) ? workspace["lexical"] : {};
  const semantic = isPlainRecord(workspace["semantic"]) ? workspace["semantic"] : {};
  const isV4 = format === "v4";
  const structuralCell = isV4
    ? `q${structural["queryable_generation"] ?? "-"}/d${structural["durable_generation"] ?? "-"}${structural["queryable"] === true ? "" : " (lagging)"}`
    : workspace["structural_ready"] === true ? "ready" : "not ready";
  const lexicalCell = isV4
    ? `gen ${lexical["completed_generation"] ?? "-"} (${lexical["current"] === true ? "current" : "lagging"})`
    : workspace["structural_ready"] === true ? "ready" : "not ready";
  const semanticCell = isV4
    ? `gen ${semantic["completed_generation"] ?? "-"} (${semantic["current"] === true ? "current" : "lagging"})`
    : workspace["semantic_ready"] === true ? "ready" : "not ready";
  const lastScan = isPlainRecord(workspace["last_scan"]) ? workspace["last_scan"] : undefined;
  const timings = lastScan && isPlainRecord(lastScan["timings"]) ? lastScan["timings"] : undefined;
  const lastScanCell = lastScan === undefined
    ? "-"
    : `${lastScan["kind"]}${typeof lastScan["changed_paths"] === "number" ? ` (${lastScan["changed_paths"]} paths)` : ""}${typeof timings?.["total_ms"] === "number" ? `, ${timings["total_ms"]}ms` : ""}`;
  return { workspace: root !== undefined ? `${id} (${root})` : id, status, format, structural: structuralCell, lexical: lexicalCell, semantic: semanticCell, last_scan: lastScanCell };
}

/** Human-readable rendering of `core:index_status` for `urdira index` (non `--json` output); `--json` bypasses this entirely and prints the raw daemon payload verbatim (see the `index` dispatch below). */
function formatIndexStatusTable(payload: unknown): string {
  const record = isPlainRecord(payload) ? payload : {};
  const workspaces = Array.isArray(record["workspaces"]) ? record["workspaces"].filter(isPlainRecord) : [];
  if (workspaces.length === 0) return "no workspaces registered\nhint: run `urdira workspace add <path>` to register one.";
  const headers = ["WORKSPACE", "STATUS", "FORMAT", "STRUCTURAL", "LEXICAL", "SEMANTIC", "LAST_SCAN"] as const;
  const rows = workspaces.map(indexStatusRow).map((row) => [row.workspace, row.status, row.format, row.structural, row.lexical, row.semantic, row.last_scan]);
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)));
  const renderRow = (cells: readonly string[]): string => cells.map((cell, column) => padColumn(cell, widths[column]!)).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
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

function formatWorkspaceTechnologyProposal(preview: unknown): string {
  const record = preview !== null && typeof preview === "object" ? preview as { readonly technologies?: unknown } : {};
  const technologies = Array.isArray(record.technologies) ? record.technologies : [];
  if (technologies.length === 0) return "Detected technologies: none. The workspace will be registered without language plugins.";
  const lines = ["Detected technologies and compatible plugins:"];
  for (const value of technologies) {
    if (typeof value === "string") {
      lines.push(`  - ${value}`);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const technology = value as { readonly technology_id?: unknown; readonly kind?: unknown; readonly confidence?: unknown; readonly compatible_plugin_ids?: unknown; readonly evidence?: unknown; readonly evidence_count?: unknown; readonly evidence_complete?: unknown };
    const id = typeof technology.technology_id === "string" ? technology.technology_id : "unknown";
    const kind = typeof technology.kind === "string" ? `, ${technology.kind}` : "";
    const confidence = typeof technology.confidence === "number" ? `, confidence ${Math.round(technology.confidence * 100)}%` : "";
    lines.push(`  - ${id}${kind}${confidence}`);
    const plugins = Array.isArray(technology.compatible_plugin_ids) ? technology.compatible_plugin_ids.filter((item): item is string => typeof item === "string") : [];
    lines.push(`    compatible plugins: ${plugins.length > 0 ? plugins.join(", ") : "none"}`);
    const evidence = Array.isArray(technology.evidence) ? technology.evidence : [];
    for (const item of evidence) {
      if (item === null || typeof item !== "object") continue;
      const detail = item as { readonly path?: unknown; readonly rule?: unknown; readonly value?: unknown };
      if (typeof detail.path !== "string" || typeof detail.rule !== "string") continue;
      lines.push(`    detected from: ${detail.path} (${detail.rule}${typeof detail.value === "string" ? `: ${detail.value}` : ""})`);
    }
    const declaredEvidenceCount = technology.evidence_count;
    const evidenceCount = typeof declaredEvidenceCount === "number" && Number.isSafeInteger(declaredEvidenceCount) && declaredEvidenceCount >= evidence.length
      ? declaredEvidenceCount
      : evidence.length;
    const evidenceComplete = typeof technology.evidence_complete === "boolean"
      ? technology.evidence_complete
      : evidenceCount === evidence.length;
    if (!evidenceComplete || evidenceCount > evidence.length) {
      lines.push(`    showing ${evidence.length} of ${evidenceCount} deterministic evidence paths`);
    }
  }
  return lines.join("\n");
}

function formatWorkspacePluginProposal(preview: unknown): string {
  const record = preview !== null && typeof preview === "object" ? preview as { readonly technologies?: unknown } : {};
  const technologies = Array.isArray(record.technologies) ? record.technologies : [];
  const plugins = [...new Set(technologies.flatMap((value) => {
    if (value === null || typeof value !== "object") return [];
    const ids = (value as { readonly compatible_plugin_ids?: unknown }).compatible_plugin_ids;
    return Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : [];
  }))];
  if (plugins.length === 0) return "Compatible plugins: none. Observation will start without a structural language plugin.";
  return `Compatible plugins to activate: ${plugins.join(", ")}`;
}

function formatWorkspaceConfigurationTarget(command: CliCommand): string {
  const target = command.args[0] ?? command.options.values["workspace"] ?? command.options.values["path"] ?? "unknown";
  const payload = command.options.payload === undefined ? "" : `\nConfiguration payload: ${JSON.stringify(command.options.payload)}`;
  return `Workspace configuration target: ${target}.${payload}`;
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
    const clients: readonly AgentClient[] = requested === "all" ? AGENT_CLIENTS : [requested];
    if (command.name === "agent-status") {
      const data = await Promise.all(clients.map((client) => agentStatus(client, { ...(dependencies.home_directory === undefined ? {} : { home: dependencies.home_directory }), ...(command.options.values["workspace"] === undefined ? {} : { workspace: command.options.values["workspace"] }) })));
      const result = { clients: data };
      return { exit_code: 0, data: result, stdout: output(result, command.options.json) };
    }
    if (command.options.dry_run === command.options.confirm) throw new CliError("cli:dry_run_required", "Use exactly one of --dry-run or --confirm for agent installation changes.");
    const operation = command.name === "agent-install" ? installAgent : uninstallAgent;
    const data = await Promise.all(clients.map((client) => operation(client, { dry_run: command.options.dry_run, confirm: command.options.confirm, ...(dependencies.agent_launcher === undefined ? {} : { launcher: dependencies.agent_launcher }), ...(dependencies.home_directory === undefined ? {} : { home: dependencies.home_directory }), ...(command.options.values["workspace"] === undefined ? {} : { workspace: command.options.values["workspace"] }) })));
    return { exit_code: 0, data: { clients: data }, stdout: output({ clients: data }, command.options.json) };
  }
  if ((MUTATING_COMMANDS as readonly string[]).includes(command.name)) {
    const mutationName = command.name as (typeof MUTATING_COMMANDS)[number];
    // Starting and stopping the daemon are idempotent lifecycle requests.
    // The command itself is the user's intent; neither operation needs a
    // second --confirm acknowledgement. A dry-run remains available when a
    // caller explicitly wants the lifecycle proposal without executing it.
    const directCommand = mutationName === "start" || mutationName === "stop" || mutationName === "restart";
    if (mutationName === "workspace-add" && command.args.length === 0 && command.options.values["path"] === undefined && command.options.values["workspace_root"] === undefined) {
      throw new CliError("cli:command_invalid", "workspace add requires a workspace path.");
    }
    const preview = dependencies.preview_admin ? await dependencies.preview_admin(command) : { command: mutationName, call: adminCall[mutationName], args: command.args, values: command.options.values };
    if (!command.options.dry_run && !command.options.confirm && dependencies.prompt && (mutationName === "workspace-add" || mutationName === "workspace-configure")) {
      const accepted = (value: string | boolean): boolean => value === true || (typeof value === "string" && ["y", "yes", "si", "sí"].includes(value.trim().toLocaleLowerCase("en-US")));
      const technologyAnswer = mutationName === "workspace-add"
        ? await dependencies.prompt(`${formatWorkspaceTechnologyProposal(preview)}\n\nConfirm these technologies? [y/N]`)
        : await dependencies.prompt(`${formatWorkspaceConfigurationTarget(command)}\n\nNo technology detection is performed by workspace configure. Apply this configuration? [y/N]`);
      const pluginAnswer = mutationName === "workspace-add"
        ? await dependencies.prompt(`${formatWorkspacePluginProposal(preview)}\n\nActivate these plugins and start observation? [y/N]`)
        : "yes";
      if (!accepted(technologyAnswer) || !accepted(pluginAnswer)) {
        const data = { dry_run: false, confirmed: false, interactive: true, command: mutationName, preview };
        return { exit_code: 0, data, stdout: output(data, command.options.json) };
      }
      const selection = pluginSelectionFromPreview(preview);
      const result = dependencies.execute_admin ? await dependencies.execute_admin(command, preview) : await dependencies.client.call(adminCall[mutationName], { args: command.args, values: command.options.values, ...(command.options.proposal_id === undefined ? {} : { proposal_id: command.options.proposal_id }), ...(command.options.payload === undefined ? {} : { payload: command.options.payload }), selected_technology_ids: selection.selected_technology_ids, selected_plugin_ids: selection.selected_plugin_ids, confirmed: true, preview });
      const resultPayload = "outcome" in (result as object) ? (result as { readonly payload?: unknown; readonly error?: unknown }).payload ?? (result as { readonly error?: unknown }).error ?? result : result;
      const integrationAnswer = mutationName === "workspace-add" ? await dependencies.prompt("Configure Urdira in an agent now? Enter yes/all, or a comma-separated client list (claude-code, codex, opencode, cursor, vscode/copilot, cline, roo, claude-desktop). Enter no to skip. [yes/all/clients/no]") : undefined;
      const agent_integrations = integrationAnswer === undefined ? undefined : await configureInteractiveAgents(integrationAnswer, dependencies.home_directory, command.args[0], dependencies.agent_launcher);
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
    // `data` (returned to a scripted caller via `CliResult.data`) always
    // stays the full envelope above -- only `stdout`'s human-terminal
    // rendering swaps in the orphan table, exactly like `formatIndexStatusTable`
    // does for `urdira index` further below.
    const rendered = !command.options.json ? formatOrphanCommandResult(mutationName, resultPayload) ?? data : data;
    return { exit_code: "outcome" in (result as object) && (result as { readonly outcome: string }).outcome !== "success" ? 1 : 0, data, stdout: output(rendered, command.options.json, semanticModelNotice(resultPayload)) };
  }
  const suppliedPayload = command.options.payload ?? { args: command.args, values: command.options.values };
  const continuationEnvelope = command.name === "query" && isPlainRecord(suppliedPayload) && suppliedPayload["request_type"] === "continuation" && isPlainRecord(suppliedPayload["continuation"])
    ? suppliedPayload["continuation"]
    : undefined;
  const queryEnvelope = command.name === "query" && isPlainRecord(suppliedPayload) && suppliedPayload["request_type"] === "query" && isPlainRecord(suppliedPayload["query"])
    ? suppliedPayload["query"]
    : undefined;
  const call = command.name === "status" ? "core:status"
    : command.name === "index" ? "core:index_status"
      : command.name === "workspace-list" ? "core:workspace_admin_list"
        : command.name === "workspace-show" ? "core:workspace_admin_show"
          : command.name === "workspace-footprint" ? "core:workspace_footprint"
            : command.name === "workspace-orphans" ? "core:workspace_orphans_list"
              : command.name === "codebase-list" ? "core:codebase_list"
                : continuationEnvelope === undefined ? "core:query" : "core:query_continue";
  const data = await dependencies.client.call(call, continuationEnvelope ?? queryEnvelope ?? suppliedPayload);
  const resultPayload = data.payload ?? data.error ?? data;
  // `--json` always passes the raw payload through verbatim (per this
  // command's own descriptor and every other read-only command here); the
  // table rendering below is purely a human-terminal convenience for
  // `urdira index` and never changes `data` (what a scripted caller reading
  // `CliResult.data` sees), only `stdout`.
  const rendered = command.name === "index" && !command.options.json && data.outcome === "success" ? formatIndexStatusTable(resultPayload)
    : command.name === "workspace-orphans" && !command.options.json && data.outcome === "success" ? formatOrphanCommandResult("workspace-orphans", resultPayload) ?? resultPayload
      : command.name === "workspace-show" && !command.options.json && data.outcome === "success" ? formatWorkspaceShowResult(resultPayload) ?? resultPayload
        : command.name === "workspace-footprint" && !command.options.json && data.outcome === "success" ? formatWorkspaceFootprintResult(resultPayload) ?? resultPayload
          : resultPayload;
  return { exit_code: data.outcome === "success" ? 0 : 1, data: resultPayload, stdout: output(rendered, command.options.json) };
}
