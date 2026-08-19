// @ts-nocheck -- this module is an adapter boundary over three evolving host hook schemas.
import { mkdir, readFile, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentClient = "claude-code" | "codex" | "opencode";
export type AgentSearchOperation = "grep" | "glob";
export type AgentFallbackReason = "unregistered_workspace" | "stale_index" | "unsupported_input" | "scope_mismatch" | "timeout" | "output_overflow" | "semantic_difference" | "bridge_error";
export interface AgentSearchRequest { readonly client: AgentClient; readonly operation: AgentSearchOperation; readonly working_directory: string; readonly native_arguments: Readonly<Record<string, unknown>>; readonly host_output_limit: number; }
export interface AgentSearchDecision { readonly decision: "serve" | "fallback"; readonly fallback_reason?: AgentFallbackReason; readonly output?: string; readonly raw?: unknown; }
export interface DiscoveryDigestView { readonly workspace_id: string; readonly snapshot_id?: string; readonly freshness: "current" | "stale" | "unknown"; readonly completeness: "complete" | "incomplete" | "unknown"; readonly findings: ReadonlyArray<string>; readonly evidence_locations: ReadonlyArray<string>; readonly follow_up_hints: ReadonlyArray<string>; readonly incomplete_work: ReadonlyArray<string>; readonly truncated: boolean; readonly semantic_coverage?: string; readonly native_fallback?: AgentFallbackReason; }
export interface DiscoveryChildContext {
  /** Runs the lookup in an isolated child-agent context. Only the returned
   * digest is allowed to cross back to the parent. */
  readonly run: <T>(operation: (client: AgentBridgeClient) => Promise<T>) => Promise<T>;
}
export interface AgentBridgeClient { readonly call: (call: string, payload: unknown) => Promise<{ readonly outcome: string; readonly payload?: unknown; readonly error?: unknown }>; }

const MANAGED = "urdira-managed-agent-integration-v1";
const CLIENTS: readonly AgentClient[] = ["claude-code", "codex", "opencode"];

export function normalizeAgentClient(value: string | undefined): AgentClient | "all" {
  if (value === "all") return "all";
  if (CLIENTS.includes(value as AgentClient)) return value as AgentClient;
  throw new Error(`Unknown agent client: ${value ?? ""}`);
}

function record(value: unknown): Readonly<Record<string, unknown>> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function limitValue(value: unknown, fallback = 12000): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback; }

function extractToolInput(payload: unknown): Readonly<Record<string, unknown>> {
  const root = record(payload);
  return record(root.tool_input ?? root.arguments ?? root.input ?? payload);
}

function parseSimpleCodexSearchCommand(command: string): { readonly operation: AgentSearchOperation; readonly args: Readonly<Record<string, unknown>> } | undefined {
  // Codex's Bash adapter is deliberately narrower than a shell parser. Any
  // pipeline, substitution, redirection, command separator, or newline is
  // native-fallback territory; Urdira must never reinterpret compound shell
  // semantics.
  if (!command || /[|;&<>`$()\n\r]/.test(command)) return undefined;
  const tokens = command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s]+/g)?.map((token) => token.length >= 2 && ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) ? token.slice(1, -1) : token) ?? [];
  const tool = tokens.shift();
  if (tool === "rg" || tool === "grep") {
    let pattern: string | undefined; let path: string | undefined; let caseSensitive = true; let word = false; let syntax: "literal" | "regex" = "regex"; let glob: string | undefined;
    const unsupported = new Set(["-A", "-B", "-C", "--context", "--only-matching", "-o", "-c", "--count", "-l", "-L", "--files-with-matches", "--files-without-match", "-z", "--null-data"]);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (unsupported.has(token) || token.startsWith("--context=")) return undefined;
      if (token === "-i" || token === "--ignore-case") { caseSensitive = false; continue; }
      if (token === "-w" || token === "--word-regexp") { word = true; continue; }
      if (token === "-F" || token === "--fixed-strings") { syntax = "literal"; continue; }
      if (token === "-n" || token === "--line-number") continue;
      if (token === "-g" || token === "--glob" || token === "--include") { glob = tokens[++index]; if (glob === undefined) return undefined; continue; }
      if (token === "-e" || token === "--regexp") { pattern = tokens[++index]; if (pattern === undefined) return undefined; continue; }
      if (token.startsWith("-")) return undefined;
      if (pattern === undefined) pattern = token; else if (path === undefined) path = token; else return undefined;
    }
    return pattern === undefined ? undefined : { operation: "grep", args: { pattern, syntax, case_sensitive: caseSensitive, word, ...(path === undefined ? {} : { path }), ...(glob === undefined ? {} : { glob }) } };
  }
  if (tool === "find" && tokens.length >= 4) {
    const root = tokens.shift();
    if (tokens.shift() !== "-type" || tokens.shift() !== "f" || tokens.shift() !== "-name" || tokens.length !== 1 || root === undefined) return undefined;
    return { operation: "glob", args: { path: root, pattern: tokens[0] } };
  }
  return undefined;
}

function safeGlob(value: string): boolean { return !/[|;&<>`$()\n\r]/.test(value) && value.length <= 512; }
function safePattern(value: string, syntax: unknown): boolean {
  if (syntax !== "safe_regex" && syntax !== "literal" && syntax !== undefined) return false;
  if (value.length > 1024 || /\(\?[:=!<]|\\[1-9]/.test(value)) return false;
  try { if (syntax === "safe_regex") new RegExp(value); } catch { return false; }
  return true;
}

async function workspaceFor(client: AgentBridgeClient, cwd: string): Promise<{ readonly workspace_id: string; readonly snapshot_id?: string } | undefined> {
  const response = await client.call("core:index_status", { api_version: 1, workspace_root: cwd });
  if (response.outcome !== "success") return undefined;
  const workspaces = Array.isArray(record(response.payload).workspaces) ? record(response.payload).workspaces as readonly unknown[] : [];
  const first = record(workspaces[0]);
  const workspaceId = stringValue(first.workspace_id);
  return workspaceId === undefined ? undefined : { workspace_id: workspaceId, ...(stringValue(first.current_snapshot_id) === undefined ? {} : { snapshot_id: stringValue(first.current_snapshot_id) }) };
}

function operationRequest(workspace: { readonly workspace_id: string }, request: AgentSearchRequest, args: Readonly<Record<string, unknown>>): unknown {
  const filter: Record<string, unknown> = {};
  const path = stringValue(args["path"]) ?? stringValue(args["cwd"]);
  const glob = stringValue(args["glob"]) ?? (request.operation === "glob" ? stringValue(args["pattern"]) : undefined);
  if (path !== undefined && request.operation === "grep") filter.paths = [path];
  if (glob !== undefined) filter.paths = [glob];
  if (request.operation === "glob") return {
    api_version: 1,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: { filter } },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "require_complete", evidence: { mode: "none" }, diagnostics: { mode: "none" }, snippets: { mode: "none" }, registry: { mode: "none" }, response_budget: { max_items: limitValue(request.host_output_limit, 1000), max_characters: request.host_output_limit } },
  };
  const pattern = stringValue(args.pattern) ?? "";
  const syntax = args.syntax === "regex" || args.multiline === true ? "safe_regex" : "literal";
  return {
    api_version: 1,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern, syntax, case_sensitive: args.case_sensitive !== false, word_mode: args.word === true ? "identifier" : "substring", filter, result_projection: "match" } },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "require_complete", evidence: { mode: "none" }, diagnostics: { mode: "none" }, snippets: { mode: "none" }, registry: { mode: "none" }, response_budget: { max_items: limitValue(request.host_output_limit, 1000), max_characters: request.host_output_limit } },
  };
}

function renderQueryPayload(payload: unknown, operation: AgentSearchOperation, maxCharacters: number): string | undefined {
  const root = record(payload);
  const streams = record(root.streams);
  const stream = Array.isArray(streams.matches) ? streams.matches : Array.isArray(streams.artifacts) ? streams.artifacts : [];
  const lines: string[] = [];
  for (const value of stream) {
    const item = record(value); const subject = record(item.subject); const body = record(item.body);
    const path = stringValue(body.path) ?? stringValue(subject.path) ?? stringValue(item.path);
    if (operation === "glob") { if (path !== undefined) lines.push(path); continue; }
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const firstEvidence = record(evidence[0]);
    const line = typeof firstEvidence.line === "number" ? firstEvidence.line : typeof item.line === "number" ? item.line : undefined;
    const text = stringValue(item.text) ?? stringValue(body.text) ?? "";
    if (path !== undefined) lines.push(`${path}${line === undefined ? "" : `:${line}`}${text.length === 0 ? "" : `:${text}`}`);
  }
  const output = lines.join("\n");
  return output.length <= maxCharacters ? output : undefined;
}

export async function translateAgentSearch(request: AgentSearchRequest, client: AgentBridgeClient): Promise<AgentSearchDecision> {
  const args = request.native_arguments;
  if (!request.working_directory || !Number.isSafeInteger(request.host_output_limit) || request.host_output_limit <= 0) return { decision: "fallback", fallback_reason: "unsupported_input" };
  if (request.operation === "glob") {
    const pattern = stringValue(args.glob) ?? stringValue(args.pattern);
    if (pattern === undefined || !safeGlob(pattern) || args.absolute === true) return { decision: "fallback", fallback_reason: "unsupported_input" };
  } else {
    const pattern = stringValue(args.pattern);
    if (pattern === undefined || !safePattern(pattern, args.syntax === "regex" ? "safe_regex" : "literal") || args.multiline === true && args.syntax !== "regex") return { decision: "fallback", fallback_reason: "unsupported_input" };
    if (args.count === true || args.only_matching === true || args.context !== undefined) return { decision: "fallback", fallback_reason: "unsupported_input" };
  }
  const workspace = await workspaceFor(client, request.working_directory);
  if (workspace === undefined) return { decision: "fallback", fallback_reason: "unregistered_workspace" };
  const response = await client.call("core:query", operationRequest(workspace, request, args));
  if (response.outcome !== "success") return { decision: "fallback", fallback_reason: response.error !== undefined ? "stale_index" : "bridge_error" };
  const root = record(response.payload);
  const freshness = stringValue(root.freshness_status) ?? stringValue(record(root.index_freshness).status);
  if (freshness !== undefined && freshness !== "current") return { decision: "fallback", fallback_reason: "stale_index" };
  const completeness = stringValue(record(root.completeness).overall_status) ?? stringValue(root.completeness_status);
  if (completeness !== undefined && completeness !== "complete") return { decision: "fallback", fallback_reason: "stale_index" };
  if (root.truncated === true || record(root.page).truncated === true) return { decision: "fallback", fallback_reason: "output_overflow" };
  const output = renderQueryPayload(response.payload, request.operation, request.host_output_limit);
  if (output === undefined) return { decision: "fallback", fallback_reason: "output_overflow" };
  return { decision: "serve", output, raw: response.payload };
}

export function renderHookResponse(client: AgentClient, decision: AgentSearchDecision): unknown {
  if (client === "opencode") return decision.decision === "serve" ? { output: decision.output ?? "" } : { fallback: true, reason: decision.fallback_reason };
  if (decision.decision === "serve") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.output ?? "" } };
  // Claude Code's current PreToolUse contract treats allow as a transparent
  // pass-through; do not inject a fallback explanation into the model's
  // normal tool transcript.
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

export async function runAgentHook(payload: unknown, client: AgentBridgeClient, forcedClient?: AgentClient): Promise<unknown> {
  const root = record(payload); const clientName = forcedClient ?? normalizeAgentClient(stringValue(root.client) ?? stringValue(root.client_name));
  if (clientName === "all") throw new Error("agent hook requires one client");
  const operationName = (stringValue(root.tool_name) ?? stringValue(root.name) ?? stringValue(root.operation) ?? "").toLowerCase();
  let operation: AgentSearchOperation = operationName.includes("glob") ? "glob" : "grep";
  let nativeArguments = extractToolInput(payload);
  if (clientName === "codex" && operationName.includes("bash")) {
    const parsed = parseSimpleCodexSearchCommand(stringValue(nativeArguments.command) ?? stringValue(root.command) ?? "");
    if (parsed === undefined) return renderHookResponse(clientName, { decision: "fallback", fallback_reason: "unsupported_input" });
    operation = parsed.operation; nativeArguments = parsed.args;
  }
  const request: AgentSearchRequest = { client: clientName, operation, working_directory: stringValue(root.cwd) ?? stringValue(root.working_directory) ?? process.cwd(), native_arguments: nativeArguments, host_output_limit: limitValue(root.max_output ?? root.output_limit) };
  return renderHookResponse(clientName, await translateAgentSearch(request, client));
}

function jsonFile(value: unknown): Readonly<Record<string, unknown>> { return record(value); }
async function readJson(path: string): Promise<Readonly<Record<string, unknown>>> { try { return jsonFile(JSON.parse(await readFile(path, "utf8"))); } catch { return {}; } }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, path); }
async function backupJson(path: string): Promise<void> { try { await copyFile(path, `${path}.urdira-backup`); } catch { /* a new configuration has nothing to back up */ } }
async function removeManagedFile(path: string, dryRun: boolean): Promise<void> { try { if (!(await readFile(path, "utf8")).includes(MANAGED)) return; if (!dryRun) await unlink(path); } catch { /* absent */ } }
function managedCommand(client: AgentClient): string { return `urdira agent hook --client ${client}`; }

export interface AgentInstallResult { readonly client: AgentClient; readonly changed: boolean; readonly files: ReadonlyArray<string>; readonly conflicts: ReadonlyArray<string>; readonly dry_run: boolean; }

export async function installAgent(client: AgentClient, options: { readonly dry_run: boolean; readonly confirm: boolean; readonly home?: string }): Promise<AgentInstallResult> {
  const root = options.home ?? homedir(); const files: string[] = []; const conflicts: string[] = [];
  if (client === "claude-code") {
    const path = join(root, ".claude", "settings.json"); const settings = await readJson(path); const hooks = record(settings.hooks); const pre = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Glob)$", hooks: [{ type: "command", command: `${managedCommand(client)} # ${MANAGED}` }] });
    const next = { ...settings, hooks: { ...hooks, PreToolUse: pre } }; files.push(path); const agentPath = join(root, ".claude", "agents", "urdira-discovery.md"); files.push(agentPath); if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, next); await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `<!-- ${MANAGED} -->\nname: urdira-discovery\ndescription: Read-only multi-query repository discovery; return only a bounded digest.\n`, { mode: 0o600 }); }
  } else if (client === "codex") {
    const path = join(root, ".codex", "hooks.json"); const settings = await readJson(path); const hooks = record(settings.hooks); const pre = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Glob|Bash)$", hooks: [{ type: "command", command: `${managedCommand(client)} # ${MANAGED}`, timeout: 30 }] });
    files.push(path); const agentPath = join(root, ".codex", "agents", "urdira_explorer.toml"); files.push(agentPath); const skillPath = join(root, ".codex", "skills", "urdira-discovery", "SKILL.md"); files.push(skillPath);
    if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre } }); await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `# ${MANAGED}\nname = "urdira_explorer"\ndescription = "Read-only bounded repository discovery via Urdira."\n`, { mode: 0o600 }); await mkdir(dirname(skillPath), { recursive: true }); await writeFile(skillPath, `<!-- ${MANAGED} -->\nDelegate multi-step repository discovery to the urdira_explorer agent and return only its bounded digest.\n`, { mode: 0o600 }); }
  } else {
    const toolDir = join(root, ".config", "opencode", "tools"); const agentPath = join(root, ".config", "opencode", "agents", "urdira-discovery.md");
    for (const operation of ["grep", "glob"] as const) { const path = join(toolDir, `${operation}.ts`); files.push(path); try { const existing = await readFile(path, "utf8"); if (!existing.includes(MANAGED)) conflicts.push(path); } catch { /* new file */ } if (!options.dry_run && conflicts.length === 0) { await mkdir(toolDir, { recursive: true }); await writeFile(path, `// ${MANAGED}\nimport { tool } from "@opencode-ai/plugin";\nexport default tool({ description: "Urdira ${operation}", args: { pattern: tool.schema.string() }, async execute(args) { const payload = JSON.stringify({ operation: "${operation}", ...args }); const proc = Bun.spawn(["urdira", "agent", "hook", "--client", "opencode", "--payload", payload], { stdout: "pipe" }); return await new Response(proc.stdout).text(); } });\n`, { mode: 0o600 }); } }
    files.push(agentPath); if (!options.dry_run && conflicts.length === 0) { await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `<!-- ${MANAGED} -->\nUse Urdira discovery for read-heavy repository exploration and return only a bounded digest.\n`, { mode: 0o600 }); }
  }
  return { client, changed: !options.dry_run && conflicts.length === 0, files, conflicts, dry_run: options.dry_run };
}

export async function uninstallAgent(client: AgentClient, options: { readonly dry_run: boolean; readonly confirm: boolean; readonly home?: string }): Promise<AgentInstallResult> {
  const root = options.home ?? homedir(); const files = client === "claude-code" ? [join(root, ".claude", "settings.json"), join(root, ".claude", "agents", "urdira-discovery.md")] : client === "codex" ? [join(root, ".codex", "hooks.json"), join(root, ".codex", "agents", "urdira_explorer.toml"), join(root, ".codex", "skills", "urdira-discovery", "SKILL.md")] : [join(root, ".config", "opencode", "tools", "grep.ts"), join(root, ".config", "opencode", "tools", "glob.ts"), join(root, ".config", "opencode", "agents", "urdira-discovery.md")];
  if (!options.dry_run && !options.confirm) throw new Error("--confirm is required to uninstall agent hooks");
  for (const path of files) { if (client === "claude-code" || client === "codex") { const settings = await readJson(path); const hooks = record(settings.hooks); const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((entry) => !JSON.stringify(entry).includes(MANAGED)) : []; if (path.endsWith("settings.json") || path.endsWith("hooks.json")) { if (!options.dry_run) { await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre } }); } } else await removeManagedFile(path, options.dry_run); } else await removeManagedFile(path, options.dry_run); }
  return { client, changed: !options.dry_run, files, conflicts: [], dry_run: options.dry_run };
}

export async function agentStatus(client: AgentClient, options: { readonly home?: string } = {}): Promise<unknown> {
  const root = options.home ?? homedir(); const files = client === "claude-code" ? [join(root, ".claude", "settings.json"), join(root, ".claude", "agents", "urdira-discovery.md")] : client === "codex" ? [join(root, ".codex", "hooks.json"), join(root, ".codex", "agents", "urdira_explorer.toml")] : [join(root, ".config", "opencode", "tools", "grep.ts"), join(root, ".config", "opencode", "tools", "glob.ts")];
  const installed: string[] = []; for (const path of files) { try { if ((await readFile(path, "utf8")).includes(MANAGED)) installed.push(path); } catch { /* absent */ } }
  return { client, installed: installed.length > 0, files, managed_files: installed };
}

export async function runDiscoveryDigest(client: AgentBridgeClient, workspaceId: string, requests: ReadonlyArray<unknown>, limits: { readonly max_characters?: number; readonly max_findings?: number; readonly max_evidence?: number } = {}): Promise<DiscoveryDigestView> {
  const maxCharacters = limits.max_characters ?? 8000; const maxFindings = limits.max_findings ?? 8; const maxEvidence = limits.max_evidence ?? 12; const findings: string[] = []; const evidence: string[] = [];
  let freshness: DiscoveryDigestView["freshness"] = "unknown"; let completeness: DiscoveryDigestView["completeness"] = "unknown"; let snapshotId: string | undefined; let semanticCoverageValue: string | undefined;
  const incompleteWork: string[] = [];
  for (const request of requests) { const requestedCall = stringValue(record(request).call) ?? "core:query"; const response = await client.call(requestedCall, request); if (response.outcome !== "success") return { workspace_id: workspaceId, freshness, completeness: "incomplete", findings, evidence_locations: evidence, follow_up_hints: ["Retry with native Grep/Glob because the Urdira index is unavailable."], incomplete_work: [requestedCall], truncated: false, native_fallback: "bridge_error" }; const root = record(response.payload); const status = stringValue(root.freshness_status); if (status === "current" || status === "stale") freshness = status; snapshotId ??= stringValue(root.snapshot_id); const semanticCoverage = stringValue(root.semantic_coverage) ?? stringValue(record(root.semantic_materialization).coverage); const streams = record(root.streams); for (const value of Object.values(streams)) if (Array.isArray(value)) for (const item of value) { const line = JSON.stringify(item); if (line.length < 1200) findings.push(line); const match = /([\w./-]+:\d+)/.exec(line); if (match) evidence.push(match[1]!); } if (root.incomplete === true || root.truncated === true) incompleteWork.push(requestedCall); if (semanticCoverage !== undefined) semanticCoverageValue = semanticCoverage; }
  const uniqueFindings = [...new Set(findings)].slice(0, maxFindings); const uniqueEvidence = [...new Set(evidence)].slice(0, maxEvidence); let used = 0; const bounded: string[] = []; for (const finding of uniqueFindings) { if (used + finding.length + 1 > maxCharacters) break; bounded.push(finding); used += finding.length + 1; }
  return { workspace_id: workspaceId, ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }), freshness, completeness: bounded.length === uniqueFindings.length && incompleteWork.length === 0 ? "complete" : "incomplete", findings: bounded, evidence_locations: uniqueEvidence, follow_up_hints: bounded.length < uniqueFindings.length || incompleteWork.length > 0 ? ["Use a focused follow-up query for omitted findings."] : [], incomplete_work: [...new Set(incompleteWork)], truncated: bounded.length < uniqueFindings.length, ...(semanticCoverageValue === undefined ? {} : { semantic_coverage: semanticCoverageValue }) };
}

/** Executes multi-query discovery in a child context and returns only the
 * bounded digest to the caller. The callback is intentionally generic so each
 * supported client can bind its own subagent/child-agent mechanism without
 * expanding Urdira's public MCP surface. */
export async function runIsolatedDiscoveryDigest(child: DiscoveryChildContext, client: AgentBridgeClient, workspaceId: string, requests: ReadonlyArray<unknown>, limits: { readonly max_characters?: number; readonly max_findings?: number; readonly max_evidence?: number } = {}): Promise<DiscoveryDigestView> {
  return await child.run((isolatedClient) => runDiscoveryDigest(isolatedClient, workspaceId, requests, limits));
}
