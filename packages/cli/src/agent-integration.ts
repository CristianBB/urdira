// @ts-nocheck -- this module is an adapter boundary over evolving host hook schemas.
import { appendFile, mkdir, mkdtemp, readFile, writeFile, rename, copyFile, unlink, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, patch as patchToml } from "@decimalturn/toml-patch";

/** Clients that can be configured by the CLI. The first five expose a native
 * pre-tool hook; the remaining clients are configured through their supported
 * local MCP settings file. */
export type AgentClient = "claude-code" | "codex" | "opencode" | "cursor" | "vscode" | "cline" | "roo" | "claude-desktop";
export type AgentSearchOperation = "grep" | "glob" | "semantic";
type AgentHookOperation = AgentSearchOperation | "context";
export type AgentFallbackReason = "unregistered_workspace" | "stale_index" | "unsupported_input" | "scope_mismatch" | "timeout" | "output_overflow" | "semantic_difference" | "bridge_error";
export interface AgentSearchRequest { readonly client: AgentClient; readonly operation: AgentSearchOperation; readonly working_directory: string; readonly native_arguments: Readonly<Record<string, unknown>>; readonly host_output_limit: number; }
export interface AgentSearchDecision { readonly decision: "serve" | "fallback"; readonly fallback_reason?: AgentFallbackReason; readonly output?: string; readonly replacement_command?: string; readonly raw?: unknown; readonly diagnostic_code?: string; }
export interface DiscoveryDigestView { readonly workspace_id: string; readonly snapshot_id?: string; readonly freshness: "current" | "stale" | "unknown"; readonly completeness: "complete" | "incomplete" | "unknown"; readonly findings: ReadonlyArray<string>; readonly evidence_locations: ReadonlyArray<string>; readonly follow_up_hints: ReadonlyArray<string>; readonly incomplete_work: ReadonlyArray<string>; readonly truncated: boolean; readonly semantic_coverage?: string; readonly native_fallback?: AgentFallbackReason; }
export interface DiscoveryChildContext {
  /** Runs the lookup in an isolated child-agent context. Only the returned
   * digest is allowed to cross back to the parent. */
  readonly run: <T>(operation: (client: AgentBridgeClient) => Promise<T>) => Promise<T>;
}
export interface AgentBridgeClient { readonly call: (call: string, payload: unknown) => Promise<{ readonly outcome: string; readonly payload?: unknown; readonly error?: unknown }>; }

const MANAGED = "urdira-managed-agent-integration-v1";
export const URDIRA_HOOK_SERVED_MARKER = "[urdira hook served]";
export const URDIRA_AGENT_HOOK_AUDIT_ENV = "URDIRA_AGENT_HOOK_AUDIT_LOG";
const CODEX_GLOBAL_START = `<!-- ${MANAGED}:global-instructions -->`;
const CODEX_GLOBAL_END = `<!-- /${MANAGED}:global-instructions -->`;
const CODEX_RETRIEVAL_RULE = " An empty result is valid evidence, not missing coverage. Use another Urdira operation for a named missing detail and copy continuations literally. Shell source reads are valid for focused verification, generated or unindexed state, and identified gaps. Avoid re-reading unchanged source already supplied by Urdira. Before a repository test script, inspect its exact-file selector; compile first when it reads generated output. To preserve model context, redirect noisy successful build output to a temporary log and print only a one-line success; on failure, print a bounded diagnostic tail. In zsh validation wrappers, use an explicit command separator and a task-specific exit variable such as `test_exit_code`; do not use the reserved zsh parameter `status`. Tests, builds, edits and Git remain native host operations.";
export const AGENT_CLIENTS: readonly AgentClient[] = ["claude-code", "codex", "opencode", "cursor", "vscode", "cline", "roo", "claude-desktop"];

const CODEX_EXPLORER_INSTRUCTIONS = `Start repository discovery with Urdira using the explicitly scoped MCP tools. Before declaring Urdira unavailable, call the visible urdira_index_status tool with the exact workspace_root. Decide availability from that tool response only; never infer it from package, dependency, or runtime state. If the tool fails, preserve its exact error and use the permitted native fallback. When coverage is complete and freshness is current, accept the response as sufficient evidence; do not repeat that discovery with shell. If the task needs remaining results, continue pagination with the returned opaque request. Do not exhaust unrelated results before starting work. A continuation_ref is self-contained: copy it literally without scope or budget; a portable cursor retains its original scope. Use shell retrieval only after an appropriate Urdira operation demonstrates a capability or coverage failure; use native operations when the task requires editing, testing, building, or git. Urdira is read-only and never replaces those task actions. Keep every source-reading request scoped to the workspace and preserve the reported completeness and provenance in your handoff.` + CODEX_RETRIEVAL_RULE;
const CODEX_GLOBAL_INSTRUCTIONS = `Begin repository discovery and source reading with Urdira. A "[Urdira prompt context already loaded]" block counts as that first action: work from its source before requesting missing details. Treat its supplied test sources as the default focused test locations. Inspect every listed production snippet for callers and public wiring during the first implementation pass. Do not consume MORE or search alternative files until you can name a concrete missing fact that blocks the edit or its focused validation. Copy a needed MORE object literally into "urdira query --payload <json> --json"; the CLI preserves its original scope, budget, snapshot, and cursor. Without a loaded block, obtain the exact workspace scope with "urdira index --json" before issuing an explicitly scoped query. Reuse supplied paths and snippets.` + CODEX_RETRIEVAL_RULE;

const PROMPT_CONTEXT = `Urdira should supply the main repository context before broad native discovery. Start with an explicitly scoped Urdira status/context call, work from the returned definitions, relations, tests and source, and follow or narrow continuations only when the task needs more. Shell source reads are valid for focused verification, generated or unindexed state, and identified missing details; avoid re-reading unchanged source already supplied by Urdira.`;
const PROMPT_CONTEXT_CONTINUATION = `[Urdira follow-up context checked]\nNo new repository seed resolved from this follow-up prompt. Reuse the repository context already present in this conversation and inspect the current diff or run the requested validation directly. Reuse recorded validation: do not repeat a successful build or test when no relevant edit followed it. Do not repeat status, context, or source discovery unless the follow-up names a missing repository detail.`;
export const PROMPT_CONTEXT_DEFAULT_MAX_CHARACTERS = 40_000;
export const PROMPT_CONTEXT_DEFAULT_MAX_ITEMS = 50;
export const CODEX_PROMPT_HOOK_TIMEOUT_SECONDS = 30;
// Match the public query ceiling so Codex does not silently spill a client-selected
// prompt page before it reaches the model. The hook query still controls its actual
// size through response_budget; this is only the host transport ceiling.
const CODEX_PROMPT_ADDITIONAL_CONTEXT_LIMIT = 10_000_000;
const CODEX_HOOK_OUTPUT_STALE_MS = 5 * 60_000;
const PROMPT_CONTEXT_CACHE_TTL_MS = 24 * 60 * 60_000;

export function normalizeAgentClient(value: string | undefined): AgentClient | "all" {
  if (value === "all") return "all";
  if (AGENT_CLIENTS.includes(value as AgentClient)) return value as AgentClient;
  throw new Error(`Unknown agent client: ${value ?? ""}`);
}

function record(value: unknown): Readonly<Record<string, unknown>> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function limitValue(value: unknown, fallback = 12000): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback; }

function withoutManagedHooks(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  const managed = (entry: unknown): boolean => stringValue(record(entry).command)?.includes(MANAGED) === true;
  return entries.flatMap((entry) => {
    const group = record(entry);
    if (!Array.isArray(group.hooks)) return managed(entry) ? [] : [entry];
    const hooks = group.hooks.filter((hook) => !managed(hook));
    if (hooks.length === group.hooks.length) return [entry];
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });
}

function extractToolInput(payload: unknown): Readonly<Record<string, unknown>> {
  const root = record(payload);
  return record(root.tool_input ?? root.arguments ?? root.input ?? payload);
}

function hasUnquotedShellControl(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote !== undefined) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/[|;&<>`$()\n\r]/u.test(character)) return true;
  }
  return quote !== undefined;
}

function extractTrailingHeadProjection(command: string): { readonly command: string; readonly line_limit?: number } | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let pipeIndex = -1;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote !== undefined) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "|") {
      if (pipeIndex !== -1 || command[index + 1] === "|") return undefined;
      pipeIndex = index;
      continue;
    }
    if (/[;&<>`$()\n\r]/u.test(character)) return undefined;
  }
  if (quote !== undefined) return undefined;
  if (pipeIndex === -1) return { command };
  const projection = command.slice(pipeIndex + 1).trim();
  const match = /^head\s+(?:-n\s+)?-(\d+)$|^head\s+-n\s+(\d+)$/u.exec(projection);
  const rawLimit = match?.[1] ?? match?.[2];
  if (rawLimit === undefined) return undefined;
  const lineLimit = Number(rawLimit);
  if (!Number.isSafeInteger(lineLimit) || lineLimit <= 0) return undefined;
  return { command: command.slice(0, pipeIndex).trim(), line_limit: lineLimit };
}

function removeTrailingStderrDiscard(command: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote !== undefined) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character !== "2" || index > 0 && !/\s/u.test(command[index - 1]!)) continue;
    const redirect = /^2>\s*\/dev\/null/u.exec(command.slice(index));
    if (redirect === null) continue;
    const suffix = command.slice(index + redirect[0].length);
    if (!/^\s*(?:$|\|\s*head\s+(?:(?:-n\s+)?-\d+|-n\s+\d+)\s*$)/u.test(suffix)) continue;
    return `${command.slice(0, index).trimEnd()}${suffix}`;
  }
  return command;
}

interface CodexCommandSequence {
  readonly segments: readonly string[];
  readonly separators: readonly (";" | "&&")[];
}

function splitCodexCommandSequence(command: string): CodexCommandSequence | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  const segments: string[] = [];
  const separators: Array<";" | "&&"> = [];
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote !== undefined) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "\n" || character === "\r" || character === "`" || character === "$" && command[index + 1] === "(") return undefined;
    const separator = character === ";" ? ";" : character === "&" && command[index + 1] === "&" ? "&&" : undefined;
    if (separator === undefined) continue;
    const segment = command.slice(start, index).trim();
    if (segment.length === 0) return undefined;
    segments.push(segment);
    separators.push(separator);
    if (separator === "&&") index += 1;
    start = index + 1;
  }
  if (quote !== undefined || segments.length === 0) return undefined;
  const tail = command.slice(start).trim();
  if (tail.length === 0) return undefined;
  segments.push(tail);
  return { segments, separators };
}

function parseSimpleCodexSourceCommand(command: string): { readonly operation: "source"; readonly args: Readonly<Record<string, unknown>> } | undefined {
  const sourceCommand = command.replace(/\s+2>\s*\/dev\/null\s*$/u, "").trim();
  if (hasUnquotedShellControl(sourceCommand)) return undefined;
  const match = /^sed\s+-n\s+(?:'([0-9]+)(?:,([0-9]+))?p'|"([0-9]+)(?:,([0-9]+))?p"|([0-9]+)(?:,([0-9]+))?p)\s+(.+)$/u.exec(sourceCommand);
  if (match === null) return undefined;
  const startLine = Number(match[1] ?? match[3] ?? match[5]);
  const endLine = Number(match[2] ?? match[4] ?? match[6] ?? startLine);
  let path = match[7]!.trim();
  if (path.length >= 2 && ((path.startsWith("'") && path.endsWith("'")) || (path.startsWith('"') && path.endsWith('"')))) path = path.slice(1, -1);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || !safeGlob(path) || path.startsWith("-")) return undefined;
  return { operation: "source", args: { path, start_line: startLine, end_line: endLine } };
}

function parseSimpleCodexSearchCommand(command: string): { readonly operation: AgentSearchOperation; readonly args: Readonly<Record<string, unknown>> } | undefined {
  // Codex's Bash adapter is deliberately narrower than a shell parser. Any
  // pipeline, substitution, redirection, command separator, or newline is
  // native-fallback territory. The sole exception is an explicit numeric
  // trailing `head`, which is a result projection rather than a second
  // repository operation.
  if (!command) return undefined;
  // Discarding stderr does not alter repository-search results. Codex commonly
  // appends this projection to tolerate optional paths, so remove only this
  // exact final redirection before applying the deliberately narrow parser.
  const searchCommand = removeTrailingStderrDiscard(command);
  const projected = extractTrailingHeadProjection(searchCommand);
  if (projected === undefined || hasUnquotedShellControl(projected.command)) return undefined;
  const tokens = projected.command.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|[^\s]+/g)?.map((token) => token.length >= 2 && ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) ? token.slice(1, -1) : token) ?? [];
  const tool = tokens.shift();
  if (tool === "rg" || tool === "grep") {
    let pattern: string | undefined; const paths: string[] = []; let caseSensitive = true; let word = false; let syntax: "literal" | "regex" = "regex"; let glob: string | undefined;
    const unsupported = new Set(["-A", "-B", "-C", "--context", "--only-matching", "-o", "-c", "--count", "-l", "-L", "--files-with-matches", "--files-without-match", "-z", "--null-data"]);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (unsupported.has(token) || token.startsWith("--context=")) return undefined;
      if (token === "-i" || token === "--ignore-case") { caseSensitive = false; continue; }
      if (token === "-w" || token === "--word-regexp") { word = true; continue; }
      if (token === "-F" || token === "--fixed-strings") { syntax = "literal"; continue; }
      if (token === "-r" || token === "-R" || token === "--recursive") continue;
      if (token === "-n" || token === "--line-number") continue;
      if (token === "-g" || token === "--glob" || token === "--include") {
        glob = tokens[++index];
        // StructuralFilter.paths is an inclusion-only union. Treating an rg
        // exclusion as one of those positive paths turns a valid native
        // search into a misleading complete empty Urdira result.
        if (glob === undefined || glob.startsWith("!")) return undefined;
        continue;
      }
      if (token.startsWith("--glob=") || token.startsWith("--include=")) {
        glob = token.slice(token.indexOf("=") + 1);
        if (glob.length === 0 || glob.startsWith("!")) return undefined;
        continue;
      }
      if (token === "-e" || token === "--regexp") { pattern = tokens[++index]; if (pattern === undefined) return undefined; continue; }
      if (token.startsWith("-")) return undefined;
      if (pattern === undefined) pattern = token; else paths.push(token);
    }
    return pattern === undefined ? undefined : { operation: "grep", args: { pattern, syntax, case_sensitive: caseSensitive, word, ...(paths.length === 0 ? {} : { paths }), ...(glob === undefined ? {} : { glob }), ...(projected.line_limit === undefined ? {} : { line_limit: projected.line_limit }) } };
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

function queryFreshnessIsUsable(value: string | undefined): boolean {
  return value === undefined || value === "current" || value === "equivalent";
}

async function workspaceFor(client: AgentBridgeClient, cwd: string): Promise<{ readonly workspace_id: string; readonly snapshot_id?: string } | undefined> {
  const response = await client.call("core:index_status", { api_version: 3, workspace_root: cwd });
  if (response.outcome !== "success") return undefined;
  const workspaces = Array.isArray(record(response.payload).workspaces) ? record(response.payload).workspaces as readonly unknown[] : [];
  const first = record(workspaces[0]);
  const workspaceId = stringValue(first.workspace_id);
  return workspaceId === undefined ? undefined : { workspace_id: workspaceId, ...(stringValue(first.current_snapshot_id) === undefined ? {} : { snapshot_id: stringValue(first.current_snapshot_id) }) };
}

function promptHookSessionId(root: Readonly<Record<string, unknown>>): string | undefined {
  return stringValue(root.session_id) ?? stringValue(root.sessionId) ?? stringValue(root.transcript_path) ?? stringValue(root.thread_id) ?? stringValue(root.conversation_id);
}

function promptContextCachePath(root: Readonly<Record<string, unknown>>, workspaceId: string): string | undefined {
  const sessionId = promptHookSessionId(root);
  if (sessionId === undefined) return undefined;
  const cacheRoot = stringValue(process.env.URDIRA_PROMPT_CONTEXT_CACHE_DIR) ?? join(tmpdir(), "urdira-prompt-context-cache");
  const key = createHash("sha256").update(`${sessionId}\0${workspaceId}`).digest("hex");
  return join(cacheRoot, `${key}.json`);
}

function promptFingerprint(prompt: string): { readonly hash: string; readonly primary_identifier?: string } {
  return {
    hash: createHash("sha256").update(prompt).digest("hex"),
    ...(promptPrimaryIdentifier(prompt) === undefined ? {} : { primary_identifier: promptPrimaryIdentifier(prompt) }),
  };
}

function promptExplicitlyRequestsMissingDetail(prompt: string): boolean {
  return /\?|\b(?:need|missing|find|locate|show|tell|where|which|what|trace|inspect|read|open|lookup|look\s+up|additional|specific|detail)\b/iu.test(prompt);
}

function promptIsFollowUpWithoutMissingDetail(prompt: string): boolean {
  return /^(?:continue|proceed|keep|finish|complete|now|apply|implement|run|validate|check|review)\b/iu.test(prompt.trim()) && !promptExplicitlyRequestsMissingDetail(prompt);
}

async function promptContextAlreadyLoaded(root: Readonly<Record<string, unknown>>, workspace: { readonly workspace_id: string; readonly snapshot_id?: string }, prompt: string): Promise<boolean> {
  if (workspace.snapshot_id === undefined) return false;
  const path = promptContextCachePath(root, workspace.workspace_id);
  if (path === undefined) return false;
  try {
    const entry = record(JSON.parse(await readFile(path, "utf8")));
    const recordedAt = typeof entry.recorded_at === "number" ? entry.recorded_at : 0;
    if (recordedAt <= 0 || Date.now() - recordedAt > PROMPT_CONTEXT_CACHE_TTL_MS) { await unlink(path).catch(() => undefined); return false; }
    const fingerprint = promptFingerprint(prompt);
    return entry.snapshot_id === workspace.snapshot_id && (
      entry.prompt_hash === fingerprint.hash
      || fingerprint.primary_identifier === undefined
      || promptIsFollowUpWithoutMissingDetail(prompt)
    );
  } catch { return false; }
}

async function rememberPromptContext(root: Readonly<Record<string, unknown>>, workspace: { readonly workspace_id: string; readonly snapshot_id?: string }, prompt: string): Promise<void> {
  if (workspace.snapshot_id === undefined) return;
  const path = promptContextCachePath(root, workspace.workspace_id);
  if (path === undefined) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    const fingerprint = promptFingerprint(prompt);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ recorded_at: Date.now(), snapshot_id: workspace.snapshot_id, prompt_hash: fingerprint.hash, primary_identifier: fingerprint.primary_identifier })}\n`, { mode: 0o600 });
    await rename(temporary, path);
    const entries = await readdir(dirname(path), { withFileTypes: true });
    const stale = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== path.slice(path.lastIndexOf("/") + 1)).map(async (entry) => {
      const candidate = join(dirname(path), entry.name);
      const details = await stat(candidate).catch(() => undefined);
      return details !== undefined && Date.now() - details.mtimeMs > PROMPT_CONTEXT_CACHE_TTL_MS ? candidate : undefined;
    }));
    await Promise.all(stale.filter((candidate): candidate is string => candidate !== undefined).map((candidate) => unlink(candidate).catch(() => undefined)));
  } catch { /* Prompt-context reuse is an optimization; a cache failure must not affect correctness. */ }
}

function operationRequest(workspace: { readonly workspace_id: string }, request: AgentSearchRequest, args: Readonly<Record<string, unknown>>): unknown {
  const filter: Record<string, unknown> = {};
  const options = {
    freshness: "current", wait_timeout_ms: 0, coverage_requirement: "require_complete",
    evidence: { evidence: "none", evidence_chain_depth: 0 },
    diagnostics: { diagnostics: "none", diagnostic_detail: false },
    snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 },
    registry: { registry: "none", include_payload_schemas: false },
    response_budget: { max_items: limitValue(request.host_output_limit, 1000), max_characters: request.host_output_limit },
  };
  const explicitPaths = Array.isArray(args["paths"]) ? args["paths"].flatMap((value) => stringValue(value) ?? []) : [];
  const path = stringValue(args["path"]) ?? stringValue(args["cwd"]);
  const glob = stringValue(args["glob"]) ?? (request.operation === "glob" ? stringValue(args["pattern"]) : undefined);
  if (request.operation === "grep" && explicitPaths.length > 0) filter.paths = explicitPaths;
  else if (path !== undefined && request.operation === "grep") filter.paths = [path];
  if (glob !== undefined) filter.paths = [glob];
  if (request.operation === "semantic") return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:search_semantic", arguments: { query_text: stringValue(args.query_text) ?? stringValue(args.query) ?? stringValue(args.pattern) ?? "", query_class: args.query_class === "identifier" || args.query_class === "source_code" || args.query_class === "mixed" ? args.query_class : "natural_text", filter } },
    options,
  };
  if (request.operation === "glob") return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:find_artifacts", arguments: { filter } },
    options,
  };
  const pattern = stringValue(args.pattern) ?? "";
  const syntax = args.syntax === "regex" || args.multiline === true ? "safe_regex" : "literal";
  return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:search_text", arguments: { pattern, syntax, case_sensitive: args.case_sensitive !== false, word_mode: args.word === true ? "identifier" : "substring", filter, result_projection: "match" } },
    options,
  };
}

function queryPayloadItems(payload: JsonRecord, operation: AgentSearchOperation): { readonly items: readonly unknown[]; readonly hasNext: boolean; readonly nextCursor?: string; readonly reportedItems?: number } {
  const resultSet = operation === "glob" ? "artifacts" : operation === "semantic" ? "candidates" : "matches";
  const selected = record(record(payload.streams)[resultSet]);
  if (Array.isArray(record(payload.streams)[resultSet]) || Array.isArray(selected.items)) {
    const value = record(payload.streams)[resultSet];
    return { items: Array.isArray(value) ? value : selected.items as readonly unknown[], hasNext: selected.has_next === true, ...(stringValue(selected.next_cursor) === undefined ? {} : { nextCursor: stringValue(selected.next_cursor) }) };
  }
  const sets = Array.isArray(payload.result_sets) ? payload.result_sets.map(record).filter((entry) => entry.result_set === resultSet) : [];
  const pages = sets.flatMap((entry) => [record(entry.confirmed), record(entry.possible)]);
  return {
    items: pages.flatMap((page) => Array.isArray(page.result_bundles) ? page.result_bundles : []),
    hasNext: pages.some((page) => page.has_next === true),
    ...((pages.map((page) => stringValue(page.next_cursor)).find((cursor) => cursor !== undefined)) === undefined ? {} : { nextCursor: pages.map((page) => stringValue(page.next_cursor)).find((cursor) => cursor !== undefined) }),
    ...(typeof payload.returned_items === "number" ? { reportedItems: payload.returned_items } : {}),
  };
}

function renderQueryPayload(payload: unknown, operation: AgentSearchOperation, maxCharacters: number, lineLimit?: number, continuation?: string): string | undefined {
  const root = record(payload);
  const selected = queryPayloadItems(root, operation);
  const lines: string[] = [];
  const projectedMatchLines: string[] = [];
  for (const value of selected.items) {
    const wrapper = record(value);
    const bundle = record(wrapper.value ?? value);
    const item = Object.keys(record(bundle.primary_result)).length > 0 ? record(bundle.primary_result) : bundle;
    const nestedRecord = record(item.record);
    const subject = record(item.subject);
    const body = Object.keys(record(item.body)).length > 0 ? record(item.body) : record(nestedRecord.payload);
    const path = stringValue(body.path) ?? stringValue(subject.path) ?? stringValue(item.path);
    if (operation === "glob" || operation === "semantic") { if (path !== undefined) lines.push(path); continue; }
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const firstEvidence = record(evidence[0]);
    const sourceSpan = record(item.source_span);
    const lineValue = firstEvidence.line ?? item.line ?? sourceSpan.start_line;
    const line = typeof lineValue === "number" ? lineValue : typeof lineValue === "string" && /^\d+$/u.test(lineValue) ? Number(lineValue) : undefined;
    const snippets = Array.isArray(bundle.optional_source_snippets) ? bundle.optional_source_snippets : [];
    const text = stringValue(item.text) ?? stringValue(body.text) ?? stringValue(record(snippets[0]).text) ?? "";
    if (path !== undefined) {
      const identity = `${path}${line === undefined ? "" : `:${line}`}`;
      lines.push(`${identity}${text.length === 0 ? "" : `:${text}`}`);
      projectedMatchLines.push(`${identity}${text.length === 0 ? "" : `:[source line ${text.length} characters; retrieve exact source through Urdira]`}`);
    }
  }
  const projectedLines = lines.slice(0, lineLimit);
  const compactProjectedLines = projectedMatchLines.slice(0, lineLimit);
  const projectionSatisfied = lineLimit !== undefined && lines.length >= lineLimit;
  if (selected.hasNext && !projectionSatisfied && continuation === undefined) return undefined;
  const continuationLine = selected.hasNext && !projectionSatisfied ? `MORE: ${continuation}` : undefined;
  const output = [...projectedLines, ...(continuationLine === undefined ? [] : [continuationLine])].join("\n");
  if ((selected.reportedItems ?? selected.items.length) > 0 && lines.length === 0) return undefined;
  if (output.length <= maxCharacters) return output;
  if (operation !== "grep") return undefined;
  const compactOutput = [...compactProjectedLines, ...(continuationLine === undefined ? [] : [continuationLine])].join("\n");
  return compactOutput.length <= maxCharacters ? compactOutput : undefined;
}

export async function translateAgentSearch(request: AgentSearchRequest, client: AgentBridgeClient): Promise<AgentSearchDecision> {
  const args = request.native_arguments;
  if (!request.working_directory || !Number.isSafeInteger(request.host_output_limit) || request.host_output_limit <= 0) return { decision: "fallback", fallback_reason: "unsupported_input" };
  if (request.operation === "glob") {
    const pattern = stringValue(args.glob) ?? stringValue(args.pattern);
    if (pattern === undefined || !safeGlob(pattern) || args.absolute === true) return { decision: "fallback", fallback_reason: "unsupported_input" };
  } else if (request.operation === "semantic") {
    const query = stringValue(args.query_text) ?? stringValue(args.query) ?? stringValue(args.pattern);
    const queryClass = args.query_class;
    if (query === undefined || query.length > 1024 || (queryClass !== undefined && queryClass !== "natural_text" && queryClass !== "identifier" && queryClass !== "source_code" && queryClass !== "mixed")) return { decision: "fallback", fallback_reason: "unsupported_input" };
  } else {
    const pattern = stringValue(args.pattern);
    if (pattern === undefined || !safePattern(pattern, args.syntax === "regex" ? "safe_regex" : "literal") || args.multiline === true && args.syntax !== "regex") return { decision: "fallback", fallback_reason: "unsupported_input" };
    if (args.count === true || args.only_matching === true || args.context !== undefined) return { decision: "fallback", fallback_reason: "unsupported_input" };
  }
  const lineLimit = args.line_limit;
  if (lineLimit !== undefined && (!Number.isSafeInteger(lineLimit) || (lineLimit as number) <= 0)) return { decision: "fallback", fallback_reason: "unsupported_input" };
  const workspace = await workspaceFor(client, request.working_directory);
  if (workspace === undefined) return { decision: "fallback", fallback_reason: "unregistered_workspace" };
  const queryRequest = operationRequest(workspace, request, args);
  const response = await client.call("core:query", queryRequest);
  if (response.outcome !== "success") return { decision: "fallback", fallback_reason: response.error !== undefined ? "stale_index" : "bridge_error" };
  const root = record(response.payload);
  const freshness = stringValue(root.freshness_status) ?? stringValue(record(root.index_freshness).status);
  if (!queryFreshnessIsUsable(freshness)) return { decision: "fallback", fallback_reason: "stale_index" };
  const completeness = stringValue(record(root.completeness).overall_status) ?? stringValue(root.completeness_status);
  if (completeness !== undefined && completeness !== "complete") return { decision: "fallback", fallback_reason: "stale_index" };
  const selected = queryPayloadItems(root, request.operation);
  const query = record(queryRequest);
  const continuation = selected.nextCursor === undefined ? undefined : JSON.stringify({
    request_type: "continuation",
    continuation: {
      api_version: 3,
      scope: query.scope,
      cursor: selected.nextCursor,
      response_budget: record(query.options).response_budget,
    },
  });
  const output = renderQueryPayload(response.payload, request.operation, request.host_output_limit, lineLimit as number | undefined, continuation);
  const explicitlyTruncated = root.truncated === true || record(root.page).truncated === true || record(root.truncation).truncated === true;
  if (explicitlyTruncated && !selected.hasNext) return { decision: "fallback", fallback_reason: "output_overflow" };
  if (output === undefined) return { decision: "fallback", fallback_reason: "output_overflow" };
  return { decision: "serve", output, raw: response.payload };
}

async function translateCodexSourceRead(workingDirectory: string, args: Readonly<Record<string, unknown>>, hostOutputLimit: number, client: AgentBridgeClient): Promise<AgentSearchDecision> {
  const path = stringValue(args.path);
  const startLine = args.start_line;
  const endLine = args.end_line;
  if (!workingDirectory || path === undefined || !safeGlob(path) || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || (startLine as number) < 1 || (endLine as number) < (startLine as number) || !Number.isSafeInteger(hostOutputLimit) || hostOutputLimit <= 0) return { decision: "fallback", fallback_reason: "unsupported_input" };
  const workspace = await workspaceFor(client, workingDirectory);
  if (workspace === undefined) return { decision: "fallback", fallback_reason: "unregistered_workspace" };
  const hydrationBudget = Math.max(hostOutputLimit, (endLine as number) * 256);
  const queryRequest = {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspace.workspace_id },
    expression: { expression_type: "operation", operation: "core:get_source", arguments: {
      subjects: [{ subject_type: "artifact", path }],
      source: { mode: "body", max_characters_per_snippet: hydrationBudget, max_total_characters: hydrationBudget, context_lines: 0 },
    } },
    options: {
      freshness: "current", wait_timeout_ms: 0, coverage_requirement: "require_complete",
      evidence: { evidence: "none", evidence_chain_depth: 0 }, diagnostics: { diagnostics: "none", diagnostic_detail: false },
      snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none", include_payload_schemas: false },
      response_budget: { max_items: 1, max_characters: hydrationBudget },
    },
  };
  const response = await client.call("core:query", queryRequest);
  if (response.outcome !== "success") return { decision: "fallback", fallback_reason: response.error !== undefined ? "stale_index" : "bridge_error" };
  const root = record(response.payload);
  const freshness = stringValue(root.freshness_status) ?? stringValue(record(root.index_freshness).status);
  const completeness = stringValue(record(root.completeness).overall_status) ?? stringValue(root.completeness_status);
  if (!queryFreshnessIsUsable(freshness) || completeness !== undefined && completeness !== "complete") return { decision: "fallback", fallback_reason: "stale_index" };
  const stream = record(record(root.streams).sources);
  const items = Array.isArray(stream.items) ? stream.items : [];
  if (items.length !== 1 || stream.has_next === true) return { decision: "fallback", fallback_reason: "output_overflow" };
  const bundle = record(record(items[0]).value ?? items[0]);
  const snippets = Array.isArray(bundle.optional_source_snippets) ? bundle.optional_source_snippets.map(record) : [];
  if (snippets.length !== 1) return { decision: "fallback", fallback_reason: "output_overflow" };
  const snippet = snippets[0]!;
  const text = stringValue(snippet.text);
  const snippetStartLine = Number(stringValue(record(snippet.span).start_line) ?? "1");
  if (text === undefined || !Number.isSafeInteger(snippetStartLine)) return { decision: "fallback", fallback_reason: "output_overflow" };
  const lines = text.split("\n");
  const relativeStart = (startLine as number) - snippetStartLine;
  const relativeEnd = (endLine as number) - snippetStartLine + 1;
  if (relativeStart < 0 || relativeEnd > lines.length || snippet.truncated === true && relativeEnd >= lines.length) return { decision: "fallback", fallback_reason: "output_overflow" };
  const output = lines.slice(relativeStart, relativeEnd).join("\n");
  return output.length <= hostOutputLimit ? { decision: "serve", output, raw: response.payload } : { decision: "fallback", fallback_reason: "output_overflow" };
}

export function renderHookResponse(client: AgentClient, decision: AgentSearchDecision): unknown {
  const servedOutput = `${URDIRA_HOOK_SERVED_MARKER}\n${decision.output ?? ""}`;
  if (client === "opencode") return decision.decision === "serve" ? { output: servedOutput } : { fallback: true, reason: decision.fallback_reason };
  if (client === "cursor") return decision.decision === "serve" ? { permission: "deny", user_message: servedOutput, agent_message: servedOutput } : { permission: "allow" };
  if (client === "codex" && decision.decision === "serve") {
    if (decision.replacement_command !== undefined) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: decision.replacement_command } } };
    const quoted = `'${servedOutput.replaceAll("'", `'"'"'`)}'`;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: `printf '%s\\n' ${quoted}` } } };
  }
  if (decision.decision === "serve") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: servedOutput } };
  if (client === "codex") return {};
  // Claude Code's current PreToolUse contract treats allow as a transparent
  // pass-through; do not inject a fallback explanation into the model's
  // normal tool transcript.
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

/** Keep served source out of Codex's rewritten command. Codex records both the
 * rewritten command and its stdout in model context, so an inline printf
 * duplicates every byte. A private temporary file leaves the command compact
 * while preserving the exact native tool output and the Urdira marker. */
async function codexServedOutputCommand(output: string): Promise<string> {
  const temporaryRoot = tmpdir();
  try {
    const entries = await readdir(temporaryRoot, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("urdira-hook-output-"))
      .map(async (entry) => {
        const directory = join(temporaryRoot, entry.name);
        try {
          if (Date.now() - (await stat(directory)).mtimeMs >= CODEX_HOOK_OUTPUT_STALE_MS) await rm(directory, { recursive: true, force: true });
        } catch { /* another hook or host cleanup may already have removed it */ }
      }));
  } catch { /* temporary-directory maintenance must not block served output */ }
  const directory = await mkdtemp(join(tmpdir(), "urdira-hook-output-"));
  const path = join(directory, "result.txt");
  await writeFile(path, output, { mode: 0o600 });
  return `cat -- ${shellQuote(path)}`;
}

async function auditAgentHook(root: Readonly<Record<string, unknown>>, client: AgentClient, operation: AgentHookOperation, decision: AgentSearchDecision): Promise<void> {
  const path = process.env[URDIRA_AGENT_HOOK_AUDIT_ENV];
  if (path === undefined || path.length === 0) return;
  const entry = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    client,
    hook_event_name: stringValue(root.hook_event_name) ?? "PreToolUse",
    tool_name: stringValue(root.tool_name) ?? stringValue(root.name) ?? stringValue(root.operation) ?? "unknown",
    tool_use_id: stringValue(root.tool_use_id) ?? null,
    operation,
    decision: decision.decision,
    fallback_reason: decision.fallback_reason ?? null,
    diagnostic_code: decision.diagnostic_code ?? null,
    output_characters: decision.output?.length ?? 0,
  };
  try { await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 }); } catch { /* measurement must never change hook behavior */ }
}

function promptContextBudget(): number {
  const configured = Number(process.env["URDIRA_AGENT_PROMPT_CONTEXT_MAX_CHARACTERS"] ?? PROMPT_CONTEXT_DEFAULT_MAX_CHARACTERS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : PROMPT_CONTEXT_DEFAULT_MAX_CHARACTERS;
}

function promptContextItemBudget(): number {
  const configured = Number(process.env["URDIRA_AGENT_PROMPT_CONTEXT_MAX_ITEMS"] ?? PROMPT_CONTEXT_DEFAULT_MAX_ITEMS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : PROMPT_CONTEXT_DEFAULT_MAX_ITEMS;
}

function promptPrimaryIdentifier(prompt: string): string | undefined {
  // Hook prompts can contain benchmark manifests, transcript paths, commit
  // metadata, and the actual task in the same string. A path component is not
  // a source symbol: remove path-shaped spans before ranking code candidates
  // so an incidental directory such as `BenchmarkResults` cannot become the
  // structural seed. This stays syntax-based and applies equally to absolute,
  // home-relative, and Windows-style paths without naming a repository.
  const promptWithoutPaths = prompt.replace(/(?:[A-Za-z]:[\\/]|~\/|\/)[^\s"'`()<>]+/gu, (path) => " ".repeat(path.length));
  const tokens = promptWithoutPaths.match(/[$_\p{L}][$_\p{L}\p{N}]*/gu) ?? [];
  // Repeated candidates are explicit task anchors in natural-language hook
  // prompts, while language or framework names often occur only as context.
  // Rank by occurrence first, then specificity (length), retaining source
  // order as the deterministic tie-breaker. This avoids a fixed repository or
  // language stop-word list and still keeps short one-off identifiers usable.
  const firstOccurrence = new Map<string, number>();
  const occurrences = new Map<string, number>();
  tokens.forEach((token, index) => {
    firstOccurrence.set(token, firstOccurrence.get(token) ?? index);
    occurrences.set(token, (occurrences.get(token) ?? 0) + 1);
  });
  const codeShaped = [...occurrences.keys()]
    .filter((token) => token.includes("_") || token.includes("$") || /[\p{Ll}\p{N}][\p{Lu}]/u.test(token))
    .sort((left, right) => (occurrences.get(right)! - occurrences.get(left)!) || (right.length - left.length) || (firstOccurrence.get(left)! - firstOccurrence.get(right)!))[0];
  if (codeShaped !== undefined) return codeShaped;
  return tokens.slice(1).find((token) => /^\p{Lu}[\p{L}\p{N}]*$/u.test(token));
}

function promptContextQuery(workspaceId: string, prompt: string, maxCharacters: number, maxItems: number): unknown {
  const primaryIdentifier = promptPrimaryIdentifier(prompt);
  return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation: "core:build_context", arguments: {
      task: prompt,
      ...(primaryIdentifier === undefined ? {} : { seeds: [{ subject_type: "symbol", name: primaryIdentifier }] }),
      // Resolve the implementation and its indexed test evidence in the first
      // packet. The engine filters lexical candidates to test artifacts before
      // source hydration, keeping this complete facet inside the hook window.
      facets: ["definitions", "tests", "implementations", "callers", "contracts"],
    } },
    options: {
      freshness: "current", wait_timeout_ms: 20_000, coverage_requirement: "require_complete",
      evidence: { evidence: "summary", evidence_chain_depth: 1 },
      diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
      snippets: { mode: "relevant", max_characters_per_snippet: Math.min(12_000, maxCharacters), max_total_characters: maxCharacters, context_lines: 12 },
      registry: { registry: "none", include_payload_schemas: false },
      response_budget: { max_items: maxItems, max_characters: maxCharacters },
    },
  };
}

function promptContextSourceFallbackQuery(workspaceId: string, prompt: string, maxCharacters: number, maxItems: number): unknown {
  const pattern = promptPrimaryIdentifier(prompt) ?? prompt.slice(0, 1024);
  return {
    api_version: 3,
    scope: { scope_type: "single_workspace", workspace_id: workspaceId },
    expression: { expression_type: "operation", operation: "core:search_text", arguments: {
      pattern, syntax: "literal", case_sensitive: false, word_mode: "substring", filter: {}, result_projection: "match",
    } },
    options: {
      freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported",
      evidence: { evidence: "summary", evidence_chain_depth: 1 },
      diagnostics: { diagnostics: "relevant", diagnostic_detail: false },
      snippets: { mode: "relevant", max_characters_per_snippet: Math.min(12_000, maxCharacters), max_total_characters: maxCharacters, context_lines: 12 },
      registry: { registry: "none", include_payload_schemas: false },
      response_budget: { max_items: maxItems, max_characters: maxCharacters },
    },
  };
}

function renderPromptSourceFallback(payload: unknown, workspaceId: string, maxCharacters: number, maxItems: number, diagnosticCode: string): string | undefined {
  const root = record(payload);
  const selected = queryPayloadItems(root, "grep");
  const scope = { scope_type: "single_workspace", workspace_id: workspaceId };
  const continuation = selected.nextCursor === undefined ? undefined : JSON.stringify({ request_type: "continuation", continuation: { api_version: 3, scope, cursor: selected.nextCursor, response_budget: { max_items: maxItems, max_characters: maxCharacters } } });
  const results = renderQueryPayload(payload, "grep", maxCharacters, undefined, continuation);
  if (results === undefined) return undefined;
  const freshness = stringValue(root.freshness_status) ?? stringValue(record(root.index_freshness).status) ?? "unknown";
  const coverage = stringValue(record(root.completeness).overall_status) ?? stringValue(root.completeness_status) ?? "unknown";
  const rendered = [
    "[Urdira prompt context partial]",
    `diagnostic=${diagnosticCode} source-safe fallback`,
    "The requested context facets are not ready at this structural frontier. These indexed matches are sufficient to begin the first edit; use Urdira for a named missing source detail.",
    `query_scope=${JSON.stringify(scope)}`,
    `freshness=${freshness} coverage=partial diagnostic_source=${diagnosticCode} source_search_coverage=${coverage} page=${selected.hasNext ? "incomplete" : "complete"}`,
    ...(selected.hasNext ? ["MORE is a self-contained continuation. Copy the complete MORE JSON object literally into `urdira query --payload <json> --json`; never reconstruct, abbreviate, or edit its cursor, scope, snapshot, or response budget."] : []),
    "SOURCE SEARCH RESULTS",
    results,
  ].join("\n");
  return rendered.length <= maxCharacters ? rendered : undefined;
}

function renderPromptContext(payload: unknown, workspaceId: string, maxCharacters: number, maxItems: number, clientName: AgentClient): string | undefined {
  const root = record(payload);
  const streams = record(root.streams);
  const promptStream = (value: unknown): JsonRecord => Array.isArray(value) ? { items: value } : record(value);
  const streamPages = [
    { classification: "confirmed", stream: promptStream(streams.context) },
    { classification: "possible", stream: promptStream(streams["context\0possible"]) },
  ] as const;
  const items = streamPages.flatMap(({ classification, stream }) => {
    const values = Array.isArray(stream.items) ? stream.items : [];
    return values.map((value) => ({ classification, value }));
  });
  if (items.length === 0) return undefined;
  type PromptSource = { id: string; path: string; artifactId?: string; artifactVersionId?: string; startByte?: string; endByte?: string; startLine?: string; endLine?: string; text: string };
  const sources: PromptSource[] = [];
  const mergeOverlappingSource = (existing: PromptSource, candidate: Omit<PromptSource, "id">): boolean => {
    if (existing.path !== candidate.path || existing.artifactId !== candidate.artifactId || existing.artifactVersionId !== candidate.artifactVersionId) return false;
    const existingStart = Number(existing.startByte); const existingEnd = Number(existing.endByte);
    const candidateStart = Number(candidate.startByte); const candidateEnd = Number(candidate.endByte);
    if (![existingStart, existingEnd, candidateStart, candidateEnd].every(Number.isSafeInteger) || existingStart > candidateEnd || candidateStart > existingEnd) return false;
    const existingBytes = Buffer.from(existing.text); const candidateBytes = Buffer.from(candidate.text);
    if (existingBytes.length !== existingEnd - existingStart || candidateBytes.length !== candidateEnd - candidateStart) return false;
    const overlapStart = Math.max(existingStart, candidateStart); const overlapEnd = Math.min(existingEnd, candidateEnd);
    if (!existingBytes.subarray(overlapStart - existingStart, overlapEnd - existingStart).equals(candidateBytes.subarray(overlapStart - candidateStart, overlapEnd - candidateStart))) return false;
    const unionStart = Math.min(existingStart, candidateStart); const unionEnd = Math.max(existingEnd, candidateEnd);
    const union = Buffer.alloc(unionEnd - unionStart);
    existingBytes.copy(union, existingStart - unionStart);
    candidateBytes.copy(union, candidateStart - unionStart);
    const lineValues = [existing.startLine, existing.endLine, candidate.startLine, candidate.endLine].map(Number).filter(Number.isSafeInteger);
    Object.assign(existing, {
      startByte: String(unionStart), endByte: String(unionEnd), text: union.toString(),
      ...(lineValues.length === 0 ? {} : { startLine: String(Math.min(...lineValues)), endLine: String(Math.max(...lineValues)) }),
    });
    return true;
  };
  const sourceIds = new Map<string, string>();
  const resultLines: string[] = [];
  for (const { classification, value } of items) {
    const entry = record(value);
    const bundle = record(entry.value ?? value);
    const primary = record(bundle.primary_result);
    const nestedRecord = record(primary.record);
    const body = Object.keys(record(primary.body)).length > 0 ? record(primary.body) : record(nestedRecord.payload);
    const subject = record(primary.subject);
    const path = stringValue(body.path) ?? stringValue(subject.path) ?? stringValue(primary.path) ?? "<indexed subject>";
    const name = stringValue(body.name) ?? stringValue(body.qualified_name) ?? stringValue(subject.name);
    const matchedSymbol = stringValue(body.matched_symbol);
    const recordId = stringValue(primary.record_id) ?? stringValue(nestedRecord.record_id);
    const relation = record(primary.relation);
    const relationKind = stringValue(relation.relation_kind) ?? stringValue(body.relation_kind);
    const snippets = Array.isArray(bundle.optional_source_snippets) ? bundle.optional_source_snippets.map(record) : [];
    const refs: string[] = [];
    for (const snippet of snippets) {
      const text = stringValue(snippet.text);
      if (text === undefined) continue;
      const span = record(snippet.span);
      const artifactId = stringValue(snippet.artifact_id) ?? stringValue(span.artifact_id) ?? stringValue(primary.owner_artifact_id);
      const artifactVersionId = stringValue(snippet.artifact_version_id) ?? stringValue(span.artifact_version_id) ?? stringValue(primary.owner_artifact_version_id);
      const startByte = stringValue(snippet.start_byte) ?? stringValue(span.start_byte);
      const endByte = stringValue(snippet.end_byte) ?? stringValue(span.end_byte);
      const startLine = stringValue(snippet.start_line) ?? stringValue(span.start_line);
      const endLine = stringValue(snippet.end_line) ?? stringValue(span.end_line);
      const key = JSON.stringify([path, artifactId, artifactVersionId, startByte, endByte, text]);
      let sourceId = sourceIds.get(key);
      if (sourceId === undefined) {
        const start = startByte === undefined ? undefined : Number(startByte);
        const end = endByte === undefined ? undefined : Number(endByte);
        const containing = sources.find((source) => source.path === path && source.artifactId === artifactId && source.artifactVersionId === artifactVersionId
          && start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end)
          && Number(source.startByte) <= start && Number(source.endByte) >= end && source.text.includes(text));
        if (containing !== undefined) sourceId = containing.id;
        const contained = sourceId === undefined ? sources.find((source) => source.path === path && source.artifactId === artifactId && source.artifactVersionId === artifactVersionId
          && start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end)
          && start <= Number(source.startByte) && end >= Number(source.endByte) && text.includes(source.text)) : undefined;
        if (contained !== undefined) {
          sourceId = contained.id;
          Object.assign(contained, { startByte, endByte, startLine, endLine, text });
        }
        if (sourceId === undefined) {
          const overlapping = sources.find((source) => mergeOverlappingSource(source, { path, artifactId, artifactVersionId, startByte, endByte, startLine, endLine, text }));
          if (overlapping !== undefined) sourceId = overlapping.id;
        }
        sourceId ??= `source:${sources.length + 1}`;
        sourceIds.set(key, sourceId);
        if (!sources.some((source) => source.id === sourceId)) sources.push({ id: sourceId, path, artifactId, artifactVersionId, startByte, endByte, startLine, endLine, text });
      }
      if (!refs.includes(sourceId)) refs.push(sourceId);
    }
    resultLines.push(`${classification === "possible" ? "[possible] " : ""}${path}${name === undefined ? "" : ` ${name}`}${recordId === undefined ? "" : ` record=${recordId}`}${matchedSymbol === undefined ? "" : ` matched_symbol=${matchedSymbol}`}${relationKind === undefined ? "" : ` relation=${relationKind}`}${refs.length === 0 ? "" : ` source_refs=${refs.join(",")}`}`);
  }
  const freshness = stringValue(root.freshness_status) ?? stringValue(record(root.index_freshness).status) ?? "unknown";
  const coverage = stringValue(record(root.completeness).overall_status) ?? stringValue(root.completeness_status) ?? "unknown";
  const continuations = streamPages.flatMap(({ stream }) => {
    const cursor = stringValue(stream.next_cursor);
    return stream.has_next === true && cursor !== undefined
      ? [JSON.stringify({ request_type: "continuation", continuation: { api_version: 3, scope: { scope_type: "single_workspace", workspace_id: workspaceId }, cursor, response_budget: { max_items: maxItems, max_characters: maxCharacters } } })]
      : [];
  });
  const hasNext = continuations.length > 0;
  const testPath = (path: string): boolean => /(?:^|\/)(?:tests?|test|spec|__tests__)(?:\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$/iu.test(path.replaceAll("\\", "/"));
  const testSources = sources.filter((source) => testPath(source.path)).map((source) => source.id);
  const productionSources = sources.filter((source) => !testPath(source.path)).map((source) => source.id);
  const sourceGuide = sources.length === 0 ? undefined
    : `SOURCE GUIDE production=${productionSources.length === 0 ? "none" : productionSources.join(",")} tests=${testSources.length === 0 ? "none" : testSources.join(",")}. Listed production snippets can include definitions, callers, and public wiring; inspect them before searching the repository.`;
  const rendered = [
    "[Urdira prompt context already loaded]",
    "ACTION READY: make the first edit from these snippets before repository inventory. Do not begin with git status, rg --files, package manifests, or another source read. If a listed caller must adopt the changed behavior, update it in this first pass rather than deferring public wiring to a follow-up.",
    "This hook counts as Urdira use. This is the starting packet for the listed sources: work from it before any MCP or shell discovery, and do not query a listed symbol or path again.",
    "Use the supplied test sources as the default focused test locations. Request another file only after naming the missing fact that blocks the edit or focused validation.",
    "Do not consume MORE before attempting the task from this packet. If page=incomplete, MORE retains every remaining result and can be passed literally to urdira query --payload <json> --json.",
    `query_scope={"scope_type":"single_workspace","workspace_id":${JSON.stringify(workspaceId)}}`,
    `freshness=${freshness} coverage=${coverage} page=${hasNext ? "incomplete" : "complete"}`,
    ...(sourceGuide === undefined ? [] : [sourceGuide]),
    ...(sources.length === 0 ? [] : ["WORKING SOURCES", ...sources.map((source) => {
      const lineLocation = source.startLine === undefined ? "" : `:${source.startLine}${source.endLine === undefined ? "" : `:${source.endLine}`}`;
      const identity = [source.artifactVersionId === undefined ? undefined : `artifact_version=${source.artifactVersionId}`, source.startByte === undefined || source.endByte === undefined ? undefined : `bytes=${source.startByte}-${source.endByte}`].filter((part) => part !== undefined).join(" ");
      return `${source.id} ${source.path}${lineLocation}${identity.length === 0 ? "" : ` ${identity}`}\n${source.text}`;
    })]),
    "RESULT INDEX",
    ...resultLines,
    ...continuations.map((continuation) => `MORE: ${continuation}`),
  ].join("\n");
  return rendered.length <= maxCharacters ? rendered : undefined;
}

async function promptHookContext(root: Readonly<Record<string, unknown>>, clientName: AgentClient, client: AgentBridgeClient): Promise<unknown> {
  const prompt = stringValue(root.prompt);
  const cwd = stringValue(root.cwd) ?? stringValue(root.working_directory);
  if (prompt === undefined || cwd === undefined) return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: PROMPT_CONTEXT } };
  const maxCharacters = promptContextBudget();
  const maxItems = promptContextItemBudget();
  const workspace = await workspaceFor(client, cwd);
  if (workspace === undefined) return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: PROMPT_CONTEXT } };
  if (await promptContextAlreadyLoaded(root, workspace, prompt)) {
    const decision: AgentSearchDecision = { decision: "serve", output: PROMPT_CONTEXT_CONTINUATION };
    await auditAgentHook(root, clientName, "context", decision);
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: PROMPT_CONTEXT_CONTINUATION } };
  }
  const response = await client.call("core:query", promptContextQuery(workspace.workspace_id, prompt, maxCharacters, maxItems));
  const errorCode = response.outcome === "success" ? undefined : stringValue(record(response.error).code);
  const selectorUnresolvable = errorCode === "core:selector_unresolvable";
  let context = response.outcome === "success" ? renderPromptContext(response.payload, workspace.workspace_id, maxCharacters, maxItems, clientName) : undefined;
  if (context === undefined && errorCode !== undefined) {
    const details = record(record(response.error).details);
    const safeFallbacks = Array.isArray(details.source_safe_fallback_operations) ? details.source_safe_fallback_operations : [];
    if (safeFallbacks.includes("core:search_text") || selectorUnresolvable) {
      const fallback = await client.call("core:query", promptContextSourceFallbackQuery(workspace.workspace_id, prompt, maxCharacters, maxItems));
      if (fallback.outcome === "success") context = renderPromptSourceFallback(fallback.payload, workspace.workspace_id, maxCharacters, maxItems, errorCode);
    }
  }
  if (context === undefined && selectorUnresolvable) context = PROMPT_CONTEXT_CONTINUATION;
  if (context !== undefined && response.outcome === "success") await rememberPromptContext(root, workspace, prompt);
  const decision: AgentSearchDecision = context === undefined
    ? { decision: "fallback", fallback_reason: response.outcome === "success" ? "output_overflow" : "bridge_error", ...(errorCode === undefined ? {} : { diagnostic_code: errorCode }) }
    : { decision: "serve", output: context, ...(errorCode === undefined ? {} : { diagnostic_code: errorCode }) };
  await auditAgentHook(root, clientName, "context", decision);
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context ?? PROMPT_CONTEXT } };
}

export async function runAgentHook(payload: unknown, client: AgentBridgeClient, forcedClient?: AgentClient): Promise<unknown> {
  const root = record(payload); const clientName = forcedClient ?? normalizeAgentClient(stringValue(root.client) ?? stringValue(root.client_name));
  if (clientName === "all") throw new Error("agent hook requires one client");
  if ((clientName === "claude-code" || clientName === "codex") && stringValue(root.hook_event_name) === "UserPromptSubmit") {
    return promptHookContext(root, clientName, client);
  }
  const operationName = (stringValue(root.tool_name) ?? stringValue(root.name) ?? stringValue(root.operation) ?? "").toLowerCase();
  let operation: AgentHookOperation = operationName.includes("glob") ? "glob" : "grep";
  const finish = async (decision: AgentSearchDecision): Promise<unknown> => {
    await auditAgentHook(root, clientName, operation, decision);
    if (clientName === "codex" && decision.decision === "serve" && decision.replacement_command === undefined) {
      const served = `${URDIRA_HOOK_SERVED_MARKER}\n${decision.output ?? ""}`;
      return renderHookResponse(clientName, { ...decision, replacement_command: await codexServedOutputCommand(served) });
    }
    return renderHookResponse(clientName, decision);
  };
  let nativeArguments = extractToolInput(payload);
  if (clientName === "codex" && operationName.includes("bash")) {
    const command = stringValue(nativeArguments.command) ?? stringValue(root.command) ?? "";
    const parsed = parseSimpleCodexSearchCommand(command);
    const sourceRead = parsed === undefined ? parseSimpleCodexSourceCommand(command) : undefined;
    if (sourceRead !== undefined) {
      operation = "source";
      return finish(await translateCodexSourceRead(stringValue(root.cwd) ?? stringValue(root.working_directory) ?? "", sourceRead.args, limitValue(root.max_output ?? root.output_limit), client));
    } else if (parsed !== undefined) {
      operation = parsed.operation; nativeArguments = parsed.args;
    } else {
      const sequence = splitCodexCommandSequence(command);
      if (sequence === undefined) return finish({ decision: "fallback", fallback_reason: "unsupported_input" });
      const parsedSegments = sequence.segments.map((segment) => parseSimpleCodexSearchCommand(segment) ?? parseSimpleCodexSourceCommand(segment));
      const searchCount = parsedSegments.filter((entry) => entry !== undefined).length;
      if (searchCount === 0) return finish({ decision: "fallback", fallback_reason: "unsupported_input" });
      const hostOutputLimit = limitValue(root.max_output ?? root.output_limit);
      const perSearchLimit = Math.max(1, Math.floor(hostOutputLimit / searchCount));
      const replacements: string[] = [];
      const outputs: string[] = [];
      const fallbackReasons: AgentFallbackReason[] = [];
      for (let index = 0; index < sequence.segments.length; index += 1) {
        const segment = sequence.segments[index]!;
        const search = parsedSegments[index];
        if (search === undefined) { replacements.push(segment); continue; }
        operation = search.operation;
        const workingDirectory = stringValue(root.cwd) ?? stringValue(root.working_directory) ?? "";
        const decision = search.operation === "source"
          ? await translateCodexSourceRead(workingDirectory, search.args, perSearchLimit, client)
          : await translateAgentSearch({ client: clientName, operation: search.operation, working_directory: workingDirectory, native_arguments: search.args, host_output_limit: perSearchLimit }, client);
        if (decision.decision !== "serve") { fallbackReasons.push(decision.fallback_reason ?? "bridge_error"); replacements.push(segment); continue; }
        const served = `${URDIRA_HOOK_SERVED_MARKER}\n${decision.output ?? ""}`;
        replacements.push(await codexServedOutputCommand(served));
        outputs.push(decision.output ?? "");
      }
      return outputs.length === 0
        ? finish({ decision: "fallback", fallback_reason: fallbackReasons[0] ?? "unsupported_input" })
        : finish({ decision: "serve", output: outputs.join("\n"), replacement_command: replacements.map((replacement, index) => index === 0 ? replacement : `${sequence.separators[index - 1]} ${replacement}`).join(" ") });
    }
  }
  if (clientName === "cursor" || clientName === "vscode") {
    const nativeOperation = operationName.replace(/[^a-z]/g, "");
    if (nativeOperation === "codebase" || nativeOperation === "codesearch" || nativeOperation === "semanticsearch") operation = "semantic";
    else if (nativeOperation === "searchfiles" || nativeOperation === "listdirectory" || nativeOperation === "glob" || nativeOperation === "filesearch") operation = "glob";
    else if (nativeOperation !== "grep" && nativeOperation !== "glob" && nativeOperation !== "search") return finish({ decision: "fallback", fallback_reason: "unsupported_input" });
    const cursorArgs = { ...nativeArguments };
    if (cursorArgs.pattern === undefined) cursorArgs.pattern = cursorArgs.query ?? cursorArgs.search_term ?? cursorArgs.file_pattern;
    if (operation === "semantic" && cursorArgs.query_text === undefined) cursorArgs.query_text = cursorArgs.query ?? cursorArgs.search_term ?? cursorArgs.pattern;
    if (cursorArgs.path === undefined) cursorArgs.path = cursorArgs.directory ?? cursorArgs.folder;
    if (cursorArgs.glob === undefined) cursorArgs.glob = cursorArgs.include_pattern ?? cursorArgs.file_glob;
    if (cursorArgs.syntax === undefined && typeof cursorArgs.is_regex === "boolean") cursorArgs.syntax = cursorArgs.is_regex ? "regex" : "literal";
    if (cursorArgs.case_sensitive === undefined && typeof cursorArgs.caseSensitive === "boolean") cursorArgs.case_sensitive = cursorArgs.caseSensitive;
    nativeArguments = cursorArgs;
  }
  const request: AgentSearchRequest = { client: clientName, operation, working_directory: stringValue(root.cwd) ?? stringValue(root.working_directory) ?? "", native_arguments: nativeArguments, host_output_limit: limitValue(root.max_output ?? root.output_limit) };
  return finish(await translateAgentSearch(request, client));
}

function jsonFile(value: unknown): Readonly<Record<string, unknown>> { return record(value); }
async function readJson(path: string): Promise<Readonly<Record<string, unknown>>> { try { return jsonFile(JSON.parse(await readFile(path, "utf8"))); } catch { return {}; } }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, path); }
async function backupJson(path: string): Promise<void> { try { await copyFile(path, `${path}.urdira-backup`); } catch { /* a new configuration has nothing to back up */ } }
async function removeManagedFile(path: string, dryRun: boolean): Promise<void> { try { if (!(await readFile(path, "utf8")).includes(MANAGED)) return; if (!dryRun) await unlink(path); } catch { /* absent */ } }
function managedCommand(client: AgentClient, launcher: readonly string[]): string {
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  return `${launcher.map(quote).join(" ")} agent hook --client ${client}`;
}
function managedPromptCommand(client: AgentClient, launcher: readonly string[]): string { return managedCommand(client, launcher); }

function mcpServer(launcher: readonly string[]): Readonly<Record<string, unknown>> {
  return { command: launcher[0], args: [...launcher.slice(1), "mcp"], env: { URDIRA_MANAGED_AGENT_INTEGRATION: MANAGED } };
}
function mcpConfigPath(client: AgentClient, root: string): string | undefined {
  if (client === "cline") return join(root, ".cline", "data", "settings", "cline_mcp_settings.json");
  if (client === "roo") return join(root, ".roo", "mcp.json");
  if (client === "claude-desktop") {
    if (process.platform === "win32") return join(root, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    if (process.platform === "darwin") return join(root, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    return join(root, ".config", "Claude", "claude_desktop_config.json");
  }
  return undefined;
}
function configFiles(client: AgentClient, root: string): string[] {
  if (client === "claude-code") return [join(root, ".claude", "settings.json"), join(root, ".claude", "agents", "urdira-discovery.md")];
  if (client === "codex") return [join(root, ".codex", "config.toml"), join(root, ".codex", "hooks.json"), join(root, ".codex", "AGENTS.md"), join(root, ".codex", "agents", "urdira_explorer.toml"), join(root, ".codex", "skills", "urdira-discovery", "SKILL.md")];
  if (client === "cursor") return [join(root, ".cursor", "hooks.json")];
  if (client === "vscode") return [join(root, ".copilot", "hooks", "urdira.json")];
  if (client === "opencode") return [join(root, ".config", "opencode", "tools", "grep.ts"), join(root, ".config", "opencode", "tools", "glob.ts"), join(root, ".config", "opencode", "agents", "urdira-discovery.md")];
  const mcp = mcpConfigPath(client, root); return mcp === undefined ? [] : [mcp];
}

function withCodexGlobalInstructions(existing: string): string {
  const block = `${CODEX_GLOBAL_START}\n${CODEX_GLOBAL_INSTRUCTIONS}\n${CODEX_GLOBAL_END}`;
  const escapedStart = CODEX_GLOBAL_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = CODEX_GLOBAL_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managed = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "u");
  if (managed.test(existing)) return existing.replace(managed, `${block}\n`);
  return `${existing.replace(/\s*$/u, "")}${existing.trim().length === 0 ? "" : "\n\n"}${block}\n`;
}

function withoutCodexGlobalInstructions(existing: string): string {
  const escapedStart = CODEX_GLOBAL_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = CODEX_GLOBAL_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managed = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "u");
  return existing.replace(managed, "").replace(/^\n+|\n+$/g, "\n");
}

async function codexConfiguration(path: string, install: boolean): Promise<string> {
  let existing = "";
  try { existing = await readFile(path, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const config = parseToml(existing);
  const instructions = config.developer_instructions;
  if (instructions !== undefined && typeof instructions !== "string") throw new Error("Codex developer_instructions must be a string");
  if (!install && !instructions?.includes(CODEX_GLOBAL_START)) return existing;
  const next = install ? withCodexGlobalInstructions(instructions ?? "") : withoutCodexGlobalInstructions(instructions).trimEnd();
  if (next.length === 0) delete config.developer_instructions;
  else config.developer_instructions = next;
  return patchToml(existing, config);
}

export interface AgentInstallResult { readonly client: AgentClient; readonly changed: boolean; readonly files: ReadonlyArray<string>; readonly conflicts: ReadonlyArray<string>; readonly dry_run: boolean; }

export async function installAgent(client: AgentClient, options: { readonly dry_run: boolean; readonly confirm: boolean; readonly home?: string; readonly workspace?: string; readonly launcher?: readonly string[] }): Promise<AgentInstallResult> {
  const root = options.home ?? homedir(); const files: string[] = []; const conflicts: string[] = [];
  const launcher = options.launcher ?? ["urdira"];
  if (launcher.length === 0 || launcher.some((arg) => arg.length === 0 || /[\0\r\n]/u.test(arg))) throw new Error("Invalid agent launcher");
  if (client === "claude-code") {
    const path = join(root, ".claude", "settings.json"); const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.PreToolUse); const prompts = withoutManagedHooks(hooks.UserPromptSubmit);
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Glob)$", hooks: [{ type: "command", command: `${managedCommand(client, launcher)} # ${MANAGED}` }] });
    prompts.push({ hooks: [{ type: "command", command: `${managedPromptCommand(client, launcher)} # ${MANAGED}` }] });
    const next = { ...settings, hooks: { ...hooks, PreToolUse: pre, UserPromptSubmit: prompts } }; files.push(path); const agentPath = join(root, ".claude", "agents", "urdira-discovery.md"); files.push(agentPath); if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, next); await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `<!-- ${MANAGED} -->\nname: urdira-discovery\ndescription: Read-only multi-query repository discovery with Urdira as the primary context source.\n\n${PROMPT_CONTEXT}\n`, { mode: 0o600 }); }
  } else if (client === "codex") {
    const configPath = join(root, ".codex", "config.toml");
    const nextConfig = await codexConfiguration(configPath, true);
    files.push(configPath);
    const path = join(root, ".codex", "hooks.json"); const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.PreToolUse); const prompts = withoutManagedHooks(hooks.UserPromptSubmit);
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Glob|Bash)$", hooks: [{ type: "command", command: `${managedCommand(client, launcher)} # ${MANAGED}`, timeout: 30 }] });
    prompts.push({ hooks: [{
      type: "command",
      command: `${managedPromptCommand(client, launcher)} # ${MANAGED}`,
      timeout: CODEX_PROMPT_HOOK_TIMEOUT_SECONDS,
      additionalContextLimit: CODEX_PROMPT_ADDITIONAL_CONTEXT_LIMIT,
    }] });
    files.push(path); const globalPath = join(root, ".codex", "AGENTS.md"); files.push(globalPath); const agentPath = join(root, ".codex", "agents", "urdira_explorer.toml"); files.push(agentPath); const skillPath = join(root, ".codex", "skills", "urdira-discovery", "SKILL.md"); files.push(skillPath);
    let globalInstructions: string | undefined; try { globalInstructions = await readFile(globalPath, "utf8"); } catch { /* an absent user AGENTS.md needs no replacement */ }
    if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre, UserPromptSubmit: prompts } }); await backupJson(configPath); await writeFile(configPath, nextConfig, { mode: 0o600 }); if (globalInstructions !== undefined) { const cleaned = withoutCodexGlobalInstructions(globalInstructions); if (cleaned !== globalInstructions) await writeFile(globalPath, cleaned, { mode: 0o600 }); } await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `# ${MANAGED}\nname = "urdira_explorer"\ndescription = "Read-only bounded repository discovery via Urdira."\ndeveloper_instructions = """\n${CODEX_EXPLORER_INSTRUCTIONS}\n"""\n`, { mode: 0o600 }); await removeManagedFile(skillPath, false); }
  } else if (client === "cursor") {
    const path = join(root, ".cursor", "hooks.json"); const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.preToolUse);
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Search Files|Codebase)$", command: `${managedCommand(client, launcher)} # ${MANAGED}`, timeout: 30 });
    files.push(path);
    if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, { version: typeof settings.version === "number" ? settings.version : 1, ...settings, hooks: { ...hooks, preToolUse: pre } }); }
  } else if (client === "vscode") {
    const path = join(root, ".copilot", "hooks", "urdira.json");
    const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.PreToolUse);
    if (!pre.some((entry) => JSON.stringify(entry).includes(MANAGED))) pre.push({ matcher: "^(Grep|Search Files|Codebase|codebase_search|grep_search)$", type: "command", command: `${managedCommand(client, launcher)} # ${MANAGED}`, timeout: 30 });
    files.push(path);
    if (!options.dry_run) { if (!options.confirm) throw new Error("--confirm is required to install agent hooks"); await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre } }); }
  } else if (client === "opencode") {
    const toolDir = join(root, ".config", "opencode", "tools"); const agentPath = join(root, ".config", "opencode", "agents", "urdira-discovery.md");
    for (const operation of ["grep", "glob"] as const) { const path = join(toolDir, `${operation}.ts`); files.push(path); try { const existing = await readFile(path, "utf8"); if (!existing.includes(MANAGED)) conflicts.push(path); } catch { /* new file */ } if (!options.dry_run && conflicts.length === 0) { await mkdir(toolDir, { recursive: true }); await writeFile(path, `// ${MANAGED}\nimport { tool } from "@opencode-ai/plugin";\nexport default tool({ description: "Use Urdira for primary repository context: ${operation}", args: { pattern: tool.schema.string() }, async execute(args, context) { const payload = JSON.stringify({ operation: "${operation}", working_directory: context.directory, ...args }); const proc = Bun.spawn([${launcher.map((arg) => JSON.stringify(arg)).join(", ")}, "agent", "hook", "--client", "opencode", "--payload", payload], { stdout: "pipe" }); return await new Response(proc.stdout).text(); } });\n`, { mode: 0o600 }); } }
    files.push(agentPath); if (!options.dry_run && conflicts.length === 0) { await mkdir(dirname(agentPath), { recursive: true }); await writeFile(agentPath, `<!-- ${MANAGED} -->\nUse Urdira discovery for read-heavy repository exploration and return only a bounded digest.\n`, { mode: 0o600 }); }
  } else {
    const path = mcpConfigPath(client, client === "roo" && options.workspace !== undefined ? options.workspace : root);
    if (path === undefined) throw new Error(`No local MCP configuration path is defined for ${client}`);
    const settings = await readJson(path); const servers = record(settings.mcpServers); const existing = servers.urdira;
    if (existing !== undefined && !JSON.stringify(existing).includes(MANAGED)) conflicts.push(path);
    files.push(path);
    if (!options.dry_run && conflicts.length === 0) { if (!options.confirm) throw new Error("--confirm is required to install agent integrations"); await backupJson(path); await writeJson(path, { ...settings, mcpServers: { ...servers, urdira: mcpServer(launcher) } }); }
  }
  return { client, changed: !options.dry_run && conflicts.length === 0, files, conflicts, dry_run: options.dry_run };
}

export async function uninstallAgent(client: AgentClient, options: { readonly dry_run: boolean; readonly confirm: boolean; readonly home?: string; readonly workspace?: string }): Promise<AgentInstallResult> {
  const root = options.home ?? homedir(); const files = client === "roo" && options.workspace !== undefined ? [mcpConfigPath(client, options.workspace)!] : configFiles(client, root);
  if (!options.dry_run && !options.confirm) throw new Error("--confirm is required to uninstall agent hooks");
  for (const path of files) {
    if (client === "codex") {
      if (path.endsWith("/config.toml")) {
        const next = await codexConfiguration(path, false);
        if (!options.dry_run) { await mkdir(dirname(path), { recursive: true }); await backupJson(path); await writeFile(path, next, { mode: 0o600 }); }
      } else if (path.endsWith("/AGENTS.md")) {
        let existing = ""; try { existing = await readFile(path, "utf8"); } catch { continue; }
        if (!options.dry_run) { await writeFile(path, withoutCodexGlobalInstructions(existing), { mode: 0o600 }); }
      } else if (path.endsWith("/hooks.json")) {
        const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.PreToolUse); const prompts = withoutManagedHooks(hooks.UserPromptSubmit);
        if (!options.dry_run) { await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre, UserPromptSubmit: prompts } }); }
      } else await removeManagedFile(path, options.dry_run);
    } else if (client === "claude-code") {
      if (!path.endsWith("/settings.json")) {
        await removeManagedFile(path, options.dry_run);
        continue;
      }
      const settings = await readJson(path); const hooks = record(settings.hooks); const pre = withoutManagedHooks(hooks.PreToolUse); const prompts = withoutManagedHooks(hooks.UserPromptSubmit);
      if (!options.dry_run) { await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, PreToolUse: pre, UserPromptSubmit: prompts } }); }
    } else if (client === "cursor" || client === "vscode") {
      const settings = await readJson(path); const hooks = record(settings.hooks); const hookName = client === "cursor" ? "preToolUse" : "PreToolUse"; const pre = withoutManagedHooks(hooks[hookName]);
      if (!options.dry_run) { await backupJson(path); await writeJson(path, { ...settings, hooks: { ...hooks, [hookName]: pre } }); }
    } else if (client === "opencode") await removeManagedFile(path, options.dry_run);
    else {
      const settings = await readJson(path); const servers = record(settings.mcpServers); const existing = record(servers.urdira);
      if (JSON.stringify(existing).includes(MANAGED) && !options.dry_run) { await backupJson(path); const nextServers = { ...servers }; delete nextServers.urdira; await writeJson(path, { ...settings, mcpServers: nextServers }); }
    }
  }
  return { client, changed: !options.dry_run, files, conflicts: [], dry_run: options.dry_run };
}

export async function agentStatus(client: AgentClient, options: { readonly home?: string; readonly workspace?: string } = {}): Promise<unknown> {
  const root = options.home ?? homedir(); const files = client === "roo" && options.workspace !== undefined ? [mcpConfigPath(client, options.workspace)!] : configFiles(client, root);
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
