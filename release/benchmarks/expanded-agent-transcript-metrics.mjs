/* global Buffer */
import { resolve } from "node:path";
const SHELL_SOURCE_READ = /(?:^|[\s;&|('"])(?:rg|grep|find|cat|bat|less|more|nl|strings|xxd|od)(?=\s)|(?:^|[\s;&|('"])ls\s+-|git\s+ls-files|sed\s+-n|(?<![|]\s)(?:head|tail|awk)\s+|(?:python3?\s+-c|node\s+-e).*(?:open\(|readFileSync\(|readFile\()/mu;
const isShellSourceReadCommand = (command) => {
  const text = String(command);
  // Diff/status review is a permitted post-edit operation. A pager/filter
  // such as `sed -n` in a git diff pipeline must not be mistaken for a source
  // discovery read; standalone sed remains covered by SHELL_SOURCE_READ.
  const withoutDiffReview = text.replace(/\bgit\s+diff\b[^;&\n]*\|\s*sed\s+-n\b[^;&\n]*/gu, "");
  return SHELL_SOURCE_READ.test(withoutDiffReview);
};
// Reads of the isolated Codex skill/configuration tree are host setup work,
// not repository discovery. Keep them in total command_execution counts while
// excluding their output from repository context measurements.
const isHostInstructionReadCommand = (command) => /(?:\/\.codex\/(?:skills|AGENTS\.md)(?:\/|\b))/u.test(String(command));
const TEST_COMMAND = /(?:^|[\s'"])(?:cargo\s+(?:nextest\s+run|test)|go\s+test|pytest|python3?\s+-m\s+pytest|vitest|jest|mocha|ava|node\s+(?:--test|[^\s]+\s+test)|pnpm\s+(?:exec\s+)?(?:vitest|test)|npm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?(?:test|test-node)|bun\s+test)(?:[\s;'"&|]|$)/iu;
const PATH_TEST_COMMAND = /(?:^|[;\n&|]|-lc\s+['"])\s*(?:\.?\/)?(?:[^\s/'"]+\/)+(?:vitest|jest|mocha|ava|pytest)(?:[\s;'"&|]|$)/iu;
const TYPECHECK_COMMAND = /(?:^|\s)(?:tsc(?:\s|$)|pnpm\s+(?:exec\s+)?(?:tsc|typecheck)(?:\s|$)|npm\s+run\s+typecheck(?:\s|$))/iu;
const LINT_COMMAND = /(?:^|\s)(?:eslint(?:\s|$)|pnpm\s+(?:exec\s+)?lint(?:\s|$)|npm\s+run\s+lint(?:\s|$))/iu;
const URDIRA_HOOK_SERVED_MARKER = "[urdira hook served]";

const hookServedText = (item) => {
  if (item?.type !== "error" || typeof item.message !== "string") return null;
  const marker = item.message.indexOf(URDIRA_HOOK_SERVED_MARKER);
  if (marker < 0) return null;
  const output = item.message.slice(marker + URDIRA_HOOK_SERVED_MARKER.length);
  return output.startsWith("\n") ? output.slice(1) : output;
};

const URDIRA_DISCOVERY_OPERATIONS = new Set([
  "core:analyze_impact", "core:discover_definitions", "core:expand_relations",
  "core:find_artifacts", "core:find_paths", "core:find_records",
  "core:find_references", "core:find_related_tests", "core:get_outline",
  "core:inspect_architecture", "core:resolve_symbol", "core:search_text",
]);
const URDIRA_SOURCE_OPERATION = "core:get_source";
const URDIRA_RECIPES = new Set([
  "core:compare_workspaces", "core:definition_to_instances", "core:explain_architecture_slice",
  "core:find_relevant_tests", "core:locate_implementation", "core:prepare_new_feature",
  "core:prepare_symbol_change", "core:resolve_and_find_references", "core:semantic_to_callers",
  "core:trace_behavior", "core:understand_change_impact",
]);

const queryExpression = (item) => item?.arguments?.request?.query?.expression
  ?? item?.arguments?.request?.expression
  ?? item?.arguments?.query?.expression
  ?? item?.arguments?.expression;

const pipelineShape = (expression) => {
  if (expression?.expression_type === "recipe") {
    const recipeId = expression.recipe_id ?? expression.recipe?.recipe_id;
    return typeof recipeId === "string" && URDIRA_RECIPES.has(recipeId)
      ? { valid: true, kind: "recipe", has_dependency: true, has_discovery_source_dependency: true, reason: null }
      : { valid: false, kind: "recipe", has_dependency: false, has_discovery_source_dependency: false, reason: "unknown_or_missing_recipe" };
  }
  if (expression?.expression_type !== "pipeline") {
    return { valid: false, kind: expression?.expression_type ?? "unknown", has_dependency: false, has_discovery_source_dependency: false, reason: "operation_or_unknown_expression" };
  }
  if (!Array.isArray(expression.stages) || expression.stages.length < 2) {
    return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "missing_two_or_more_stages" };
  }
  const stages = expression.stages;
  const ids = stages.map((stage) => stage?.stage_id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "invalid_or_duplicate_stage_id" };
  }
  const discoveryStages = new Set(stages.filter((stage) => URDIRA_DISCOVERY_OPERATIONS.has(stage?.operation)).map((stage) => stage.stage_id));
  const sourceStages = new Set(stages.filter((stage) => stage?.operation === URDIRA_SOURCE_OPERATION).map((stage) => stage.stage_id));
  let hasDependency = false;
  let hasDiscoverySourceDependency = false;
  for (let index = 0; index < stages.length; index += 1) {
    const bindings = stages[index]?.bindings;
    if (bindings === undefined) continue;
    if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
      return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "invalid_bindings" };
    }
    for (const binding of Object.values(bindings)) {
      if (binding === null || typeof binding !== "object" || Array.isArray(binding)
        || typeof binding.stage_id !== "string" || typeof binding.output !== "string") {
        return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "invalid_binding_reference" };
      }
      const upstream = ids.indexOf(binding.stage_id);
      if (upstream < 0 || upstream >= index) {
        return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "binding_must_reference_earlier_stage" };
      }
      hasDependency = true;
      if (sourceStages.has(ids[index]) && discoveryStages.has(binding.stage_id)) hasDiscoverySourceDependency = true;
    }
  }
  const needsDiscoverySource = discoveryStages.size > 0 && sourceStages.size > 0;
  if (!hasDependency) return { valid: false, kind: "pipeline", has_dependency: false, has_discovery_source_dependency: false, reason: "no_data_dependency" };
  if (needsDiscoverySource && !hasDiscoverySourceDependency) return { valid: false, kind: "pipeline", has_dependency: true, has_discovery_source_dependency: false, reason: "source_not_bound_to_discovery" };
  return { valid: true, kind: "pipeline", has_dependency: true, has_discovery_source_dependency: hasDiscoverySourceDependency, reason: null };
};

/** Collect observational metrics for the Urdira query shape the agent selected. */
export function analyzeUrdiraPipelineContract(events) {
  const completed = events.filter((event) => event?.type === "item.completed");
  const calls = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    if (item?.type !== "mcp_tool_call" || String(item.server).toLowerCase() !== "urdira" || item.tool !== "urdira_query") return [];
    const shape = pipelineShape(queryExpression(item));
    return [{ event_index: eventIndex, ...shape, status: item.status, accepted: item.status === "completed" && shape.valid }];
  });
  const valid = calls.filter((call) => call.accepted);
  const edits = completed.map((event, index) => /apply_patch|file_change|write_file|git\s+apply|editor_action/iu.test(JSON.stringify(event)) ? index : -1).filter((index) => index >= 0);
  const firstEdit = edits.at(0);
  const compositionCalls = calls.filter((call) => call.kind === "pipeline" || call.kind === "recipe");
  const malformedCompositionCalls = compositionCalls.filter((call) => !call.valid);
  const beforeFirstEdit = firstEdit === undefined ? valid.length > 0 : valid.some((call) => call.event_index < firstEdit);
  return {
    composition_shape_valid: compositionCalls.length === 0 ? null : malformedCompositionCalls.length === 0,
    query_calls: calls.length,
    direct_operation_calls: calls.filter((call) => call.kind === "operation").length,
    pipeline_calls: calls.filter((call) => call.kind === "pipeline").length,
    recipe_calls: calls.filter((call) => call.kind === "recipe").length,
    composition_calls: compositionCalls.length,
    valid_composition_calls: valid.length,
    valid_dependency_calls: valid.filter((call) => call.has_dependency).length,
    valid_discovery_source_calls: valid.filter((call) => call.has_discovery_source_dependency).length,
    malformed_composition_calls: malformedCompositionCalls.length,
    malformed_reasons: [...new Set(malformedCompositionCalls.map((call) => call.reason))],
    composition_before_first_edit: beforeFirstEdit,
    composition_after_edit_calls: firstEdit === undefined ? 0 : valid.filter((call) => call.event_index > firstEdit).length,
    calls,
  };
}

const itemText = (item) => {
  if (item?.type === "mcp_tool_call") {
    if (typeof item.result === "string") return item.result;
    return (item.result?.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
  }
  if (item?.type === "command_execution") {
    return String(item.aggregated_output ?? item.output ?? item.stdout ?? "");
  }
  const hooked = hookServedText(item);
  if (hooked !== null) return hooked;
  return "";
};

const transportText = (item) => {
  if (item?.type === "mcp_tool_call") {
    if (typeof item.result === "string") return { text: item.result, characters: item.result.length };
    if (!Array.isArray(item.result?.content)) return { text: "", characters: null };
    const blocks = item.result.content.filter((part) => part?.type === "text");
    if (blocks.some((part) => typeof part.text !== "string")) return { text: "", characters: null };
    const text = blocks.map((part) => part.text).join("\n");
    return { text, characters: blocks.reduce((sum, part) => sum + part.text.length, 0) };
  }
  if (item?.type === "command_execution") {
    const key = ["aggregated_output", "output", "stdout"].find((candidate) => typeof item[candidate] === "string");
    return key === undefined ? { text: "", characters: null } : { text: String(item[key]), characters: String(item[key]).length };
  }
  const hooked = hookServedText(item);
  return hooked === null ? { text: "", characters: null } : { text: hooked, characters: hooked.length };
};

// This is transport text, not the host's full model context. Do not synthesize
// missing output or count structured MCP aliases alongside their text blocks.
const completedTextCharacters = (item) => {
  if (item.type === "mcp_tool_call") {
    if (typeof item.result === "string") return item.result.length;
    if (!Array.isArray(item.result?.content)) return null;
    const blocks = item.result.content.filter((part) => part?.type === "text");
    if (blocks.some((part) => typeof part.text !== "string")) return null;
    return blocks.reduce((sum, part) => sum + part.text.length, 0);
  }
  for (const key of ["aggregated_output", "output"]) {
    if (typeof item[key] === "string") return item[key].length;
  }
  const streams = [item.stdout, item.stderr].filter((value) => typeof value === "string");
  return streams.length === 0 ? null : streams.reduce((sum, value) => sum + value.length, 0);
};

const completedToolOutput = (completed, hookPayloadByEvent = new Map(), hookReplacementByEvent = new Map()) => {
  const outputs = completed.flatMap(({ item }, eventIndex) => {
    const hooked = hookServedText(item);
    if (item?.type !== "mcp_tool_call" && item?.type !== "command_execution" && hooked === null) return [];
    const replacement = hookReplacementByEvent.get(eventIndex);
    if (replacement !== undefined) {
      const rawCharacters = completedTextCharacters(item);
      const markerCharacters = replacement.count * (URDIRA_HOOK_SERVED_MARKER.length + 1);
      const shellCharacters = rawCharacters === null || replacement.characters === null
        ? null
        : Math.max(0, rawCharacters - replacement.characters - markerCharacters);
      return [
        { transport: "hook", tgrep: false, characters: replacement.characters },
        ...(shellCharacters === null || shellCharacters === 0 ? (shellCharacters === null ? [{ transport: "shell", tgrep: false, characters: null }] : []) : [{ transport: "shell", tgrep: false, characters: shellCharacters }]),
      ];
    }
    return [{
      transport: item.type === "mcp_tool_call" ? "mcp" : item.type === "command_execution" ? "shell" : "hook",
      tgrep: item.type === "command_execution" && /(?:^|[\s;&|('"`])tgrep(?:\s|$)/u.test(String(item.command ?? "")),
      characters: hooked === null ? completedTextCharacters(item) : (hookPayloadByEvent.has(eventIndex) ? hookPayloadByEvent.get(eventIndex) : hooked.length),
    }];
  });
  const summarize = (items) => {
    const missing = items.filter((item) => item.characters === null).length;
    const known = items.reduce((sum, item) => sum + (item.characters ?? 0), 0);
    return { calls: items.length, missing_output_calls: missing, known_characters: known, characters: items.length === 0 || missing > 0 ? null : known };
  };
  return {
    mcp: summarize(outputs.filter((item) => item.transport === "mcp")),
    hook: summarize(outputs.filter((item) => item.transport === "hook")),
    shell: summarize(outputs.filter((item) => item.transport === "shell")),
    tgrep: summarize(outputs.filter((item) => item.tgrep)),
    total_characters: summarize(outputs).characters,
    full_model_context_characters: null,
  };
};

const unwrapLoginShell = (command) => command.match(/^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh)\s+-lc\s+(['"])([\s\S]*)\1$/u)?.[2] ?? command;

const CODEX_ACTION_TYPES = new Set(["mcp_tool_call", "command_execution", "web_search", "file_change"]);
const CODEX_KNOWN_COMPLETED_TYPES = new Set([...CODEX_ACTION_TYPES, "agent_message", "error"]);
export const analyzeCodexActions = (completed) => {
  const actionCounts = {};
  for (const event of completed) {
    const type = event.item?.type;
    if (typeof type === "string") actionCounts[type] = (actionCounts[type] ?? 0) + 1;
  }
  const actionEvents = completed.filter((event) => CODEX_ACTION_TYPES.has(event.item?.type));
  const unknown = completed.filter((event) => {
    const type = event.item?.type;
    return typeof type === "string" && !CODEX_KNOWN_COMPLETED_TYPES.has(type);
  });
  const errors = completed.filter((event) => event.item?.type === "error");
  const hookErrors = errors.filter((event) => {
    const message = String(event.item?.message ?? "");
    return hookServedText(event.item) === null && /hook/iu.test(message) && /failed|error|blocked|rejected/iu.test(message) && !/bypass-hook-trust.*enabled/iu.test(message);
  });
  return {
    action_counts: actionCounts,
    web_search_calls: actionCounts.web_search ?? 0,
    file_change_actions: actionCounts.file_change ?? 0,
    first_action_type: actionEvents[0]?.item?.type ?? null,
    integration_warning_count: errors.length,
    hook_error_count: hookErrors.length,
    unclassified_action_count: unknown.length,
  };
};

const DISCOVERY_COMPONENTS = ["snippets", "hydration", "evidence", "registry"];
const MCP_COMPONENT_BYTE_FIELDS = ["tool_envelope", "model_visible_serialized", "source_text", "hydration", "records", "evidence", "registry"];
const utf8Bytes = (value) => Buffer.byteLength(String(value ?? ""), "utf8");
const mcpText = (item) => itemText(item);
const requestedComponent = (item, component) => {
  const encoded = JSON.stringify(item?.arguments ?? {}).toLowerCase();
  if (component === "snippets") return /"snippets"\s*:/u.test(encoded) && !/"mode"\s*:\s*"none"/u.test(encoded);
  if (component === "evidence") return /"evidence"\s*:/u.test(encoded);
  if (component === "registry") return /"registry"\s*:/u.test(encoded);
  return false;
};
const classifyMcpResponseComponents = (item) => {
  if (item?.type !== "mcp_tool_call") return null;
  const text = mcpText(item);
  const lines = text.split("\n");
  // Urdira's production MCP response is currently text content with result
  // headings and indented source bodies; structured_content is null in the
  // retained transcripts. Count only lines whose wire shape is identifiable.
  const source = lines.filter((line) => /^\s{4,}\S/u.test(line) && !/^\s*:\d+/u.test(line));
  const records = lines.filter((line) => /^(?:== .* ==|:?\S[^\n]*:\d+|[^\s].*\bcore:[a-z_]+)/u.test(line));
  const explicit = (component) => {
    const structured = item.result?.structuredContent ?? item.result?.structured_content;
    const value = structured?.bytes?.[component] ?? structured?.[`${component}_bytes`];
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const component = {
    tool_envelope: utf8Bytes(JSON.stringify({ server: item.server ?? null, tool: item.tool ?? null, arguments: item.arguments ?? null, status: item.status ?? null, error: item.error ?? null })),
    model_visible_serialized: utf8Bytes(text),
    source_text: source.length === 0 ? null : source.reduce((sum, line) => sum + utf8Bytes(`${line}\n`), 0),
    hydration: explicit("hydration"),
    records: records.length === 0 ? null : records.reduce((sum, line) => sum + utf8Bytes(`${line}\n`), 0),
    evidence: explicit("evidence"),
    registry: explicit("registry"),
  };
  // A requested component with no protocol marker is unavailable, not zero.
  for (const key of ["hydration", "evidence", "registry"]) {
    if (component[key] === null && requestedComponent(item, key)) component[key] = null;
  }
  return { ...component, classification: { source_text: source.length > 0 ? "indented_source_lines" : null, records: records.length > 0 ? "result_headers_and_record_lines" : null, structured_components: Object.fromEntries(["hydration", "evidence", "registry"].map((key) => [key, explicit(key) !== null])) } };
};
const componentMarkers = {
  snippets: /(?:source_)?snippets?\b|snippet_text/u,
  hydration: /hydr(?:at|ation)|hydrate\b/u,
  evidence: /\bevidence\b|diagnostic_detail|evidence_chain/u,
  registry: /\bregistry\b|payload_schema|registry_snapshot/u,
};
const componentMatches = (item) => {
  const encoded = JSON.stringify(item).toLowerCase();
  return DISCOVERY_COMPONENTS.filter((component) => componentMarkers[component].test(encoded));
};

const commandExitCode = (item) => {
  for (const candidate of [item?.exit_code, item?.exitCode, item?.status_code]) {
    const number = Number(candidate);
    if (Number.isSafeInteger(number)) return number;
  }
  return null;
};

const configuredMcpCall = (item, arm) => {
  if (item?.type !== "mcp_tool_call") return false;
  const server = String(item.server ?? "").toLowerCase();
  const tool = String(item.tool ?? "").toLowerCase();
  // Bootstrap status establishes scope/readiness but does not read
  // repository context. Keep it in total MCP calls while excluding it from
  // configured repository reads so Urdira and comparator context counts remain
  // comparable.
  if (arm === "urdira-typescript") return tool !== "urdira_index_status" && (server === "urdira" || tool.startsWith("urdira_"));
  if (arm === "codebase-memory") return server.includes("codebase-memory") || ["search_graph", "trace_path", "get_code_snippet", "get_architecture", "search_code", "query_graph"].includes(tool);
  if (arm === "codegraph") return server.includes("codegraph") || tool.startsWith("codegraph_") || ["callers", "callees", "impact"].includes(tool);
  return false;
};
const configuredTgrepCall = (item, arm) => arm === "tgrep"
  && item?.type === "command_execution"
  && /(?:^|[\s;&|('"`])tgrep(?:\s|$)/u.test(String(item.command ?? ""));

const relevancePatterns = (task) => (task?.required_patterns ?? []).flatMap(({ path, regex }) => {
  const pathParts = String(path).split("/").filter(Boolean);
  const file = pathParts.at(-1)?.replace(/\.[^.]+$/u, "");
  const patterns = [];
  try { patterns.push(new RegExp(regex, "iu")); } catch { /* invalid corpus patterns fail in the grader */ }
  if (file && file.length >= 4) patterns.push(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"));
  return patterns;
});

/** Observations only: absent evidence of use is never evidence of non-use. */
export function analyzeContextEfficiency(events, options = {}) {
  const pathKey = (path) => typeof options.workspace_root === "string" ? resolve(options.workspace_root, path) : path;
  const outputs = new Map();
  const artifactPositions = new Map();
  let sourceOrdinal = 0;
  const editedPaths = new Set(events.flatMap((event) => event?.type === "item.completed" && event.item?.type === "file_change" && Array.isArray(event.item.changes) ? event.item.changes.map((change) => change.path).filter((path) => typeof path === "string") : []));
  const offered = new Set();
  const consumed = new Set();
  const attempted = new Set();
  const records = new Set();
  let recordOccurrences = 0;
  let repeatedOutputCharacters = 0;
  let repeatedShellCharacters = 0;
  const sourceByMcp = new Set();
  const sourceLines = new Set();
  let observedSource = false;
  let sourceLineOverlap = 0;
  let firstMcpEventIndex;
  const shellSourceReads = { total_calls: 0, before_first_mcp_calls: 0, after_first_mcp_calls: 0, overlapping_calls: null, nonoverlapping_calls: null, unclassified_calls: 0 };
  const retainSource = (text) => {
    if (typeof text !== "string") return;
    observedSource = true;
    for (const line of text.split("\n")) if (line.trim().length > 0) sourceLines.add(line);
  };
  const observations = [];
  for (const [eventIndex, event] of events.entries()) {
    if (event?.type !== "item.completed") continue;
    const item = event.item;
    if (item?.type !== "mcp_tool_call" && item?.type !== "command_execution") continue;
    const text = itemText(item);
    const shell = item.type === "command_execution";
    if (shell && isHostInstructionReadCommand(item.command ?? "")) continue;
    if (shell && !isShellSourceReadCommand(item.command ?? "") && !/\btgrep\b/u.test(item.command ?? "")) continue;
    if (!shell && firstMcpEventIndex === undefined) firstMcpEventIndex = eventIndex;
    if (shell) {
      shellSourceReads.total_calls++;
      if (firstMcpEventIndex === undefined) shellSourceReads.before_first_mcp_calls++;
      else shellSourceReads.after_first_mcp_calls++;
      if (observedSource && transportText(item).characters !== null) {
        if (shellSourceReads.overlapping_calls === null) {
          shellSourceReads.overlapping_calls = 0;
          shellSourceReads.nonoverlapping_calls = 0;
        }
        let callOverlap = 0;
        for (const line of text.split("\n")) if (sourceLines.has(line)) callOverlap += line.length;
        sourceLineOverlap += callOverlap;
        if (callOverlap > 0) shellSourceReads.overlapping_calls++;
        else shellSourceReads.nonoverlapping_calls++;
      } else {
        shellSourceReads.unclassified_calls++;
      }
    }
    const request = JSON.stringify(item.arguments ?? {});
    for (const token of offered) if (request.includes(token)) {
      attempted.add(token);
      if (item.status !== "failed" && item.result?.isError !== true && item.error == null && !/"error"\s*:\s*\{/u.test(text)) consumed.add(token);
    }
    for (const match of text.matchAll(/^MORE(?: \([^\n]*\))?: (\{.*\})$/gmu)) {
      try { const value = JSON.parse(match[1]).continuation; const token = value?.continuation_ref ?? value?.cursor; if (typeof token === "string") offered.add(token); } catch { /* Preserve malformed envelopes as unmeasured. */ }
    }
    const repeated = text.length > 0 && outputs.has(text);
    if (repeated) repeatedOutputCharacters += text.length;
    if (shell && sourceByMcp.has(text) && text.length > 0) repeatedShellCharacters += text.length;
    if (text.length > 0) outputs.set(text, eventIndex);
    if (!shell) sourceByMcp.add(text);
    const countRecords = (value) => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const child of value) countRecords(child); return; }
      if (Array.isArray(value.optional_source_snippets)) for (const snippet of value.optional_source_snippets) retainSource(snippet?.text);
      if (value.primary_result && typeof value.primary_result === "object") {
        const primary = value.primary_result;
        const id = primary.record_id ?? primary.subject?.record_id;
        const path = primary.body?.path ?? primary.path;
        sourceOrdinal++;
        if (typeof path === "string" && !artifactPositions.has(pathKey(path))) artifactPositions.set(pathKey(path), { event_index: eventIndex, ordinal: sourceOrdinal });
        if (typeof id === "string") { recordOccurrences++; records.add(JSON.stringify([primary.owner_artifact_version_id ?? null, id])); }
        return;
      }
      for (const child of Object.values(value)) if (typeof child === "object") countRecords(child);
    };
    if (!shell) {
      let inSource = false;
      const snippetLines = [];
      for (const line of text.split("\n")) {
        if (/^source:\d+ \{/u.test(line)) { inSource = true; continue; }
        if (inSource && line.startsWith("    ")) snippetLines.push(line.slice(4));
        else inSource = false;
      }
      if (snippetLines.length > 0) retainSource(snippetLines.join("\n"));
      try { countRecords(JSON.parse(text)); } catch {
        for (const line of text.split("\n")) if (line.startsWith("details: ")) { try { countRecords(JSON.parse(line.slice(9))); } catch { /* Not a typed bundle. */ } }
      }
    }
    observations.push({ event_index: eventIndex, transport: shell ? "shell" : "mcp", characters: text.length, exact_output_repeated: repeated });
  }
  return {
    record_id_occurrences: recordOccurrences || null,
    unique_record_ids: recordOccurrences === 0 ? null : records.size,
    unique_record_ratio: recordOccurrences === 0 ? null : records.size / recordOccurrences,
    exact_repeated_output_characters: repeatedOutputCharacters,
    exact_shell_output_repeated_after_mcp_characters: repeatedShellCharacters,
    shell_source_line_overlap_characters: observedSource ? sourceLineOverlap : null,
    shell_source_reads: shellSourceReads,
    continuations_offered: offered.size,
    continuations_attempted: attempted.size,
    continuations_consumed: consumed.size,
    continuations_not_observed_consumed: offered.size - consumed.size,
    unused_hydration_characters: null,
    used_artifact_positions: editedPaths.size === 0 ? null : [...editedPaths].map((path) => ({ path, basis: "observed_file_change", first_typed_context_position: artifactPositions.get(pathKey(path)) ?? null })),
    relevant_results_per_thousand_characters: null,
    contributing_context_ratio: null,
    completeness_preserved: null,
    observations,
  };
}

export function analyzeExpandedTranscript(events, arm, task, options = {}) {
  const hookAudit = Array.isArray(options.hook_audit) ? options.hook_audit.filter((entry) => entry !== null && typeof entry === "object") : null;
  // UserPromptSubmit additionalContext is model-visible repository context but
  // has no transcript item of its own. Reconstruct only this transport from
  // the content-free audit sidecar. PreToolUse output remains represented by
  // the command/error transcript and must not be counted twice here.
  const auditedPromptReads = hookAudit === null ? [] : hookAudit.flatMap((entry, index) => {
    if (entry.hook_event_name !== "UserPromptSubmit" || entry.operation !== "context" || entry.decision !== "serve" || !Number.isFinite(entry.output_characters) || entry.output_characters < 0) return [];
    return [{ event_index: -hookAudit.length + index, method: "hook", urdira: true, invoked_tool: null, request: "[UserPromptSubmit]", response: "", response_characters: entry.output_characters, components: [], mcp_components: null }];
  });
  const completed = events.filter((event) => event?.type === "item.completed");
  const servedPreToolAudit = hookAudit === null ? [] : hookAudit.filter((entry) => entry.hook_event_name === "PreToolUse" && entry.decision === "serve");
  const hookReplacementByEvent = new Map();
  const hookPayloadByEvent = new Map();
  let servedPreToolIndex = 0;
  for (const [eventIndex, event] of completed.entries()) {
    const command = event.item?.type === "command_execution" ? String(event.item.command ?? "") : "";
    const replacementCount = [...command.matchAll(/urdira-hook-output-[^/'"\s]+\/result\.txt/gu)].length;
    const hookServed = hookServedText(event.item) !== null;
    if (hookAudit === null || (replacementCount === 0 && !hookServed)) continue;
    const entries = servedPreToolAudit.slice(servedPreToolIndex, servedPreToolIndex + Math.max(1, replacementCount));
    servedPreToolIndex += entries.length;
    if (replacementCount > 0) {
      hookReplacementByEvent.set(eventIndex, {
        count: replacementCount,
        characters: entries.length === replacementCount && entries.every((entry) => Number.isFinite(entry.output_characters) && entry.output_characters >= 0)
          ? entries.reduce((sum, entry) => sum + entry.output_characters, 0)
          : null,
      });
    } else {
      const entry = entries[0];
      hookPayloadByEvent.set(eventIndex, Number.isFinite(entry?.output_characters) && entry.output_characters >= 0 ? entry.output_characters : null);
    }
  }
  const auditedPreToolReads = [...hookReplacementByEvent].map(([event_index, assignment]) => ({
    event_index,
    method: "hook",
    urdira: true,
    invoked_tool: null,
    request: String(completed[event_index]?.item?.command ?? "[PreToolUse]"),
    response: "",
    response_characters: assignment.characters,
    components: [],
    mcp_components: null,
  }));
  const codexActions = analyzeCodexActions(completed);
  const transcriptReads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    const configured = arm === "baseline"
      ? item?.type === "command_execution" && isShellSourceReadCommand(command) && !isHostInstructionReadCommand(command)
      : arm === "tgrep"
        ? configuredTgrepCall(item, arm)
        : configuredMcpCall(item, arm) || (arm === "urdira-typescript" && hookServedText(item) !== null);
    if (!configured) return [];
    const response = itemText(item);
    const transport = transportText(item);
    return [{ event_index: eventIndex, request: item?.type === "command_execution" ? command : JSON.stringify(item?.arguments ?? {}), response, response_characters: transport.characters }];
  });
  const reads = [
    ...auditedPromptReads.map(({ event_index, request, response, response_characters }) => ({ event_index, request, response, response_characters })),
    ...auditedPreToolReads.map(({ event_index, request, response, response_characters }) => ({ event_index, request, response, response_characters })),
    ...transcriptReads,
  ];
  const patterns = relevancePatterns(task);
  const edits = completed.map((event, index) => /apply_patch|file_change|write_file|git\s+apply|editor_action/iu.test(JSON.stringify(event)) ? index : -1).filter((index) => index >= 0);
  const hostInstructionReads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    if (!isHostInstructionReadCommand(command)) return [];
    const transport = transportText(item);
    return [{ event_index: eventIndex, response_characters: transport.characters }];
  });
  const observedTranscriptReads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    const isMcpDiscovery = item?.type === "mcp_tool_call" && String(item.tool ?? "").toLowerCase() !== "urdira_index_status";
    const isHostInstructionRead = item?.type === "command_execution" && isHostInstructionReadCommand(command);
    const isShellDiscovery = item?.type === "command_execution" && isShellSourceReadCommand(command) && !isHostInstructionRead;
    const isTgrepDiscovery = item?.type === "command_execution" && /(?:^|[\s;&|('"`])tgrep(?:\s|$)/u.test(command);
    const isUrdiraHookDiscovery = hookServedText(item) !== null;
    const hookReplacement = hookReplacementByEvent.get(eventIndex);
    if (!isMcpDiscovery && !isShellDiscovery && !isTgrepDiscovery && !isUrdiraHookDiscovery && hookReplacement === undefined) return [];
    const response = itemText(item);
    const transport = transportText(item);
    if (hookReplacement !== undefined) {
      const markerCharacters = hookReplacement.count * (URDIRA_HOOK_SERVED_MARKER.length + 1);
      const shellCharacters = hookReplacement.characters === null || transport.characters === null
        ? null
        : Math.max(0, transport.characters - hookReplacement.characters - markerCharacters);
      return [
        {
          event_index: eventIndex, method: "hook", urdira: true, invoked_tool: null, request: command,
          response: "", response_characters: hookReplacement.characters, components: [], mcp_components: null,
        },
        ...(isShellDiscovery && (shellCharacters === null || shellCharacters > 0) ? [{
          event_index: eventIndex, method: "shell", urdira: false, invoked_tool: isTgrepDiscovery ? "tgrep" : null, request: command,
          response, response_characters: shellCharacters, components: [], mcp_components: null,
        }] : []),
      ];
    }
    return [{
      event_index: eventIndex,
      method: isMcpDiscovery ? "mcp" : isUrdiraHookDiscovery ? "hook" : "shell",
      urdira: isUrdiraHookDiscovery || (isMcpDiscovery && (String(item.server ?? "").toLowerCase() === "urdira" || String(item.tool ?? "").toLowerCase().startsWith("urdira_"))),
      invoked_tool: isTgrepDiscovery ? "tgrep" : null,
      request: item?.type === "command_execution" ? command : JSON.stringify(item?.arguments ?? {}),
      response,
      response_characters: hookPayloadByEvent.has(eventIndex) ? hookPayloadByEvent.get(eventIndex) : transport.characters,
      // Component accounting is intentionally protocol-only. Shell text can
      // mention these words without exposing a typed snippets/hydration/
      // evidence/registry payload.
      components: item?.type === "mcp_tool_call" ? componentMatches(item) : [],
      mcp_components: item?.type === "mcp_tool_call" ? classifyMcpResponseComponents(item) : null,
    }];
  });
  const observedReads = [...auditedPromptReads, ...observedTranscriptReads];
  const observedDiscoveryIndices = observedReads.map((read) => read.event_index);
  const observedFirstEdit = edits.at(0);
  const discoveryIndices = reads.map((read) => read.event_index);
  const firstEdit = edits.at(0);
  const attestedScriptCommands = new Set();
  const verificationAttempts = completed.flatMap((event) => {
    const item = event.item;
    if (item?.type !== "command_execution") return [];
    const command = String(item.command ?? "");
    const innerCommand = unwrapLoginShell(command);
    // Package scripts can have arbitrary names. Use the command echoed by
    // the package manager, not repository-specific script-name heuristics.
    const scriptTest = /(?:^|[\s'"])(?:npm|pnpm|yarn)\s/u.test(command)
      && itemText(item).split("\n").some((line) => /^>\s/u.test(line) && TEST_COMMAND.test(line.slice(2)));
    const priorScriptTest = [...attestedScriptCommands].some((known) => innerCommand === known || innerCommand.startsWith(`${known} && `));
    if (scriptTest && !/[;&|\n]/u.test(innerCommand)) attestedScriptCommands.add(innerCommand);
    const kind = TEST_COMMAND.test(command) || PATH_TEST_COMMAND.test(command) || scriptTest || priorScriptTest ? "test" : TYPECHECK_COMMAND.test(command) ? "typecheck" : LINT_COMMAND.test(command) ? "lint" : null;
    if (kind === null) return [];
    // A later command or pipeline can mask the test's exit. Retain uncertainty
    // instead of attributing the compound shell's success to the test.
    const shellExit = commandExitCode(item);
    const exitCode = /;|\||\n/u.test(command) || (shellExit !== 0 && /&&/u.test(innerCommand)) ? null : shellExit;
    return [{ kind, command, exit_code: exitCode, passed: exitCode === null ? null : exitCode === 0, output_characters: itemText(item).length }];
  });
  const testAttempts = verificationAttempts.filter((attempt) => attempt.kind === "test");
  const methodReads = (method) => observedReads.filter((read) => method === "tgrep" ? read.invoked_tool === "tgrep" : read.method === method);
  const characterSum = (readsToSum) => readsToSum.some((read) => read.response_characters === null)
    ? null
    : readsToSum.reduce((sum, read) => sum + read.response_characters, 0);
  const methodCharacters = (method) => {
    const readsForMethod = methodReads(method);
    return readsForMethod.length === 0 || readsForMethod.some((read) => read.response_characters === null)
      ? null
      : readsForMethod.reduce((sum, read) => sum + read.response_characters, 0);
  };
  const targetReads = patterns.length === 0 ? null : observedReads.filter((read) => patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`)));
  const componentCharacters = Object.fromEntries(DISCOVERY_COMPONENTS.map((component) => {
    const matching = observedReads.filter((read) => read.components.includes(component));
    return [component, matching.length === 0 ? null : characterSum(matching)];
  }));
  const componentCalls = Object.fromEntries(DISCOVERY_COMPONENTS.map((component) => {
    const matching = observedReads.filter((read) => read.components.includes(component));
    return [component, matching.length === 0 ? null : matching.length];
  }));
  const mcpIndices = observedReads.filter((read) => read.method === "mcp").map((read) => read.event_index);
  const shellIndices = observedReads.filter((read) => read.method === "shell").map((read) => read.event_index);
  const firstMcp = mcpIndices.at(0);
  const firstShell = shellIndices.at(0);
  const mcpBeforeShell = firstMcp === undefined || firstShell === undefined ? null : firstMcp < firstShell;
  const shellAfterMcp = firstMcp === undefined || firstShell === undefined ? null : shellIndices.some((index) => index > firstMcp);
  const mcpComponentReads = observedReads.filter((read) => read.method === "mcp" && read.mcp_components !== null);
  const mcpComponentBytes = Object.fromEntries(MCP_COMPONENT_BYTE_FIELDS.map((field) => {
    const values = mcpComponentReads.map((read) => read.mcp_components?.[field]).filter((value) => Number.isFinite(value));
    return [field, values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)];
  }));
  const mcpComponentClassification = Object.fromEntries(["source_text", "records", "hydration", "evidence", "registry"].map((field) => {
    const values = mcpComponentReads.map((read) => read.mcp_components?.classification?.[field]).filter(Boolean);
    return [field, values.length === 0 ? null : [...new Set(values)]];
  }));
  const outputCharactersByMethod = {
    mcp: methodCharacters("mcp"),
    hook: methodCharacters("hook"),
    shell: methodCharacters("shell"),
    tgrep: methodCharacters("tgrep"),
  };
  const firstRepositoryRead = observedReads.at(0);
  const readsBeforeFirstEdit = observedReads.filter((read) => firstEdit === undefined || read.event_index < firstEdit);
  const configuredEventIndices = new Set(reads.map((read) => read.event_index));
  const configuredReadsBeforeFirstEdit = readsBeforeFirstEdit.filter((read) => configuredEventIndices.has(read.event_index)
    && !(arm === "urdira-typescript" && read.method === "shell" && hookReplacementByEvent.has(read.event_index)));
  const configuredCharactersBeforeFirstEdit = characterSum(configuredReadsBeforeFirstEdit);
  const totalCharactersBeforeFirstEdit = characterSum(readsBeforeFirstEdit);
  const firstConfigured = reads.at(0)?.event_index;
  const hookIndices = observedReads.filter((read) => read.method === "hook").map((read) => read.event_index);
  const directUrdiraMcpCalls = observedReads.filter((read) => read.urdira && read.method === "mcp").length;
  const auditedHookCalls = hookAudit === null ? hookIndices.length : hookAudit.length;
  const urdiraEffectiveCalls = directUrdiraMcpCalls + auditedHookCalls;
  return {
    ...codexActions,
    completed_tool_output: completedToolOutput(completed, hookPayloadByEvent, hookReplacementByEvent),
    context_efficiency: analyzeContextEfficiency(events, options),
    context_lead: {
      first_repository_discovery_transport: firstRepositoryRead?.method ?? null,
      first_repository_discovery_source: firstRepositoryRead === undefined ? null : firstRepositoryRead.urdira ? "urdira" : firstRepositoryRead.method === "mcp" ? "other_mcp" : "shell",
      configured_before_shell: firstConfigured === undefined ? null : firstShell === undefined ? true : firstConfigured < firstShell,
      configured_calls_before_first_edit: configuredReadsBeforeFirstEdit.length,
      configured_characters_before_first_edit: configuredCharactersBeforeFirstEdit,
      mcp_calls_before_first_edit: readsBeforeFirstEdit.filter((read) => read.method === "mcp").length,
      hook_calls_before_first_edit: readsBeforeFirstEdit.filter((read) => read.method === "hook").length,
      shell_source_calls_before_first_edit: readsBeforeFirstEdit.filter((read) => read.method === "shell").length,
      mcp_characters_before_first_edit: characterSum(readsBeforeFirstEdit.filter((read) => read.method === "mcp")),
      hook_characters_before_first_edit: characterSum(readsBeforeFirstEdit.filter((read) => read.method === "hook")),
      shell_source_characters_before_first_edit: characterSum(readsBeforeFirstEdit.filter((read) => read.method === "shell")),
      configured_character_share_before_first_edit: totalCharactersBeforeFirstEdit === null || totalCharactersBeforeFirstEdit === 0 || configuredCharactersBeforeFirstEdit === null ? null : configuredCharactersBeforeFirstEdit / totalCharactersBeforeFirstEdit,
    },
    repository_read_calls: observedReads.length,
    configured_repository_read_calls: reads.length,
    assigned_tgrep_calls: arm === "tgrep" ? reads.length : 0,
    repository_context_characters: observedReads.length === 0 || observedReads.some((read) => read.response_characters === null)
      ? null
      : observedReads.reduce((sum, read) => sum + read.response_characters, 0),
    host_instruction_read_calls: hostInstructionReads.length,
    host_instruction_context_characters: hostInstructionReads.length === 0 || hostInstructionReads.some((read) => read.response_characters === null)
      ? null
      : hostInstructionReads.reduce((sum, read) => sum + read.response_characters, 0),
    tool_output_characters: outputCharactersByMethod.mcp,
    hook_output_characters: outputCharactersByMethod.hook,
    shell_output_characters: outputCharactersByMethod.shell,
    tgrep_output_characters: outputCharactersByMethod.tgrep,
    output_characters_by_method: outputCharactersByMethod,
    mcp_component_bytes: mcpComponentBytes,
    mcp_component_classification: mcpComponentClassification,
    target_attributed_characters: targetReads === null ? null : characterSum(targetReads),
    target_unattributed_characters: targetReads === null ? null : characterSum(observedReads.filter((read) => !targetReads.includes(read))),
    context_component_characters: componentCharacters,
    context_component_calls: componentCalls,
    context_calls_attributed_to_declared_targets: patterns.length === 0 ? null : observedReads.filter((read) => patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`))).length,
    context_calls_unattributed_to_declared_targets: patterns.length === 0 ? null : observedReads.filter((read) => !patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`))).length,
    context_characters_unattributed_to_declared_targets: patterns.length === 0 ? null : characterSum(observedReads.filter((read) => !patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`)))),
    observed_discovery_calls: observedReads.length,
    observed_discovery_before_edit: observedDiscoveryIndices.length > 0 && (observedFirstEdit === undefined || observedDiscoveryIndices[0] < observedFirstEdit),
    observed_post_edit_discovery_calls: observedFirstEdit === undefined ? 0 : observedDiscoveryIndices.filter((index) => index > observedFirstEdit).length,
    observed_rediscovery_after_each_edit: edits.every((edit) => observedDiscoveryIndices.some((discovery) => discovery > edit)),
    observed_tool_usage: {
      mcp_calls: observedReads.filter((read) => read.method === "mcp").length,
      urdira_hook_calls: auditedHookCalls,
      urdira_hook_served_calls: hookAudit === null ? hookIndices.length : hookAudit.filter((entry) => entry.decision === "serve").length,
      urdira_hook_fallback_calls: hookAudit === null ? null : hookAudit.filter((entry) => entry.decision === "fallback").length,
      urdira_hook_fallback_reasons: hookAudit === null ? null : Object.fromEntries([...new Set(hookAudit.map((entry) => entry.fallback_reason).filter((reason) => typeof reason === "string"))].sort().map((reason) => [reason, hookAudit.filter((entry) => entry.fallback_reason === reason).length])),
      urdira_effective_calls: urdiraEffectiveCalls,
      shell_calls: observedReads.filter((read) => read.method === "shell").length,
      tgrep_calls: observedReads.filter((read) => read.invoked_tool === "tgrep").length,
      host_instruction_reads: hostInstructionReads.length,
    },
    discovery_adoption: {
      mcp_before_shell: mcpBeforeShell,
      shell_after_mcp: shellAfterMcp,
      zero_mcp: mcpIndices.length === 0,
      zero_urdira_effective_use: urdiraEffectiveCalls === 0,
      mcp_calls: mcpIndices.length,
      shell_calls: shellIndices.length,
    },
    assigned_discovery_before_edit: discoveryIndices.length > 0 && (firstEdit === undefined || discoveryIndices[0] < firstEdit),
    assigned_rediscovery_after_each_edit: edits.every((edit) => discoveryIndices.some((discovery) => discovery > edit)),
    verification_attempts: verificationAttempts,
    test_attempts: testAttempts.length,
    test_passes: testAttempts.filter((attempt) => attempt.passed === true).length,
    test_failures: testAttempts.filter((attempt) => attempt.passed === false).length,
    test_results_unknown: testAttempts.filter((attempt) => attempt.passed === null).length,
  };
}

export { SHELL_SOURCE_READ, isShellSourceReadCommand, classifyMcpResponseComponents };
