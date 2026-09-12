/* global Buffer */
const SHELL_SOURCE_READ = /(?:^|[\s;&|('"])(?:rg|grep|find|cat|bat|less|more|nl|strings|xxd|od)(?=\s)|(?:^|[\s;&|('"])ls\s+-|git\s+ls-files|sed\s+-n|(?<![|]\s)(?:head|tail|awk)\s+|(?:python3?\s+-c|node\s+-e).*(?:open\(|readFileSync\(|readFile\()/mu;
const isShellSourceReadCommand = (command) => {
  const text = String(command);
  // Diff/status review is a permitted post-edit operation. A pager/filter
  // such as `sed -n` in a git diff pipeline must not be mistaken for a source
  // discovery read; standalone sed remains covered by SHELL_SOURCE_READ.
  if (/\bgit\s+diff\b[\s\S]*\|\s*sed\s+-n\b/u.test(text)) return false;
  return SHELL_SOURCE_READ.test(text);
};
// Reads of the isolated Codex skill/configuration tree are host setup work,
// not repository discovery. Keep them in total command_execution counts while
// excluding their output from repository context measurements.
const isHostInstructionReadCommand = (command) => /(?:\/\.codex\/(?:skills|AGENTS\.md)(?:\/|\b))/u.test(String(command));
const TEST_COMMAND = /(?:^|\s)(?:cargo\s+(?:nextest\s+run|test)|go\s+test|pytest|python3?\s+-m\s+pytest|vitest|jest|mocha|ava|pnpm\s+(?:exec\s+)?(?:vitest|test)|npm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|bun\s+test)(?:\s|$)/iu;
const TYPECHECK_COMMAND = /(?:^|\s)(?:tsc(?:\s|$)|pnpm\s+(?:exec\s+)?(?:tsc|typecheck)(?:\s|$)|npm\s+run\s+typecheck(?:\s|$))/iu;
const LINT_COMMAND = /(?:^|\s)(?:eslint(?:\s|$)|pnpm\s+(?:exec\s+)?lint(?:\s|$)|npm\s+run\s+lint(?:\s|$))/iu;

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
  return "";
};

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
  const hookErrors = errors.filter((event) => /hook|trust|skill|integration/iu.test(String(event.item?.message ?? "")));
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

export function analyzeExpandedTranscript(events, arm, task) {
  const completed = events.filter((event) => event?.type === "item.completed");
  const codexActions = analyzeCodexActions(completed);
  const reads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    const configured = arm === "baseline"
      ? item?.type === "command_execution" && isShellSourceReadCommand(command) && !isHostInstructionReadCommand(command)
      : arm === "tgrep"
        ? configuredTgrepCall(item, arm)
        : configuredMcpCall(item, arm);
    if (!configured) return [];
    const response = itemText(item);
    return [{ event_index: eventIndex, request: item?.type === "command_execution" ? command : JSON.stringify(item?.arguments ?? {}), response, response_characters: response.length }];
  });
  const patterns = relevancePatterns(task);
  const edits = completed.map((event, index) => /apply_patch|file_change|write_file|git\s+apply|editor_action/iu.test(JSON.stringify(event)) ? index : -1).filter((index) => index >= 0);
  const hostInstructionReads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    if (!isHostInstructionReadCommand(command)) return [];
    const response = itemText(item);
    return [{ event_index: eventIndex, response_characters: response.length }];
  });
  const observedReads = completed.flatMap((event, eventIndex) => {
    const item = event.item;
    const command = item?.type === "command_execution" ? String(item.command ?? "") : "";
    const isMcpDiscovery = item?.type === "mcp_tool_call" && String(item.tool ?? "").toLowerCase() !== "urdira_index_status";
    const isHostInstructionRead = item?.type === "command_execution" && isHostInstructionReadCommand(command);
    const isShellDiscovery = item?.type === "command_execution" && isShellSourceReadCommand(command) && !isHostInstructionRead;
    const isTgrepDiscovery = item?.type === "command_execution" && /(?:^|[\s;&|('"`])tgrep(?:\s|$)/u.test(command);
    if (!isMcpDiscovery && !isShellDiscovery && !isTgrepDiscovery) return [];
    const response = itemText(item);
    return [{
      event_index: eventIndex,
      method: isMcpDiscovery ? "mcp" : isTgrepDiscovery ? "tgrep" : "shell",
      request: item?.type === "command_execution" ? command : JSON.stringify(item?.arguments ?? {}),
      response,
      response_characters: response.length,
      // Component accounting is intentionally protocol-only. Shell text can
      // mention these words without exposing a typed snippets/hydration/
      // evidence/registry payload.
      components: item?.type === "mcp_tool_call" ? componentMatches(item) : [],
      mcp_components: item?.type === "mcp_tool_call" ? classifyMcpResponseComponents(item) : null,
    }];
  });
  const observedDiscoveryIndices = observedReads.map((read) => read.event_index);
  const observedFirstEdit = edits.at(0);
  const discoveryIndices = reads.map((read) => read.event_index);
  const firstEdit = edits.at(0);
  const verificationAttempts = completed.flatMap((event) => {
    const item = event.item;
    if (item?.type !== "command_execution") return [];
    const command = String(item.command ?? "");
    const kind = TEST_COMMAND.test(command) ? "test" : TYPECHECK_COMMAND.test(command) ? "typecheck" : LINT_COMMAND.test(command) ? "lint" : null;
    if (kind === null) return [];
    const exitCode = commandExitCode(item);
    return [{ kind, command, exit_code: exitCode, passed: exitCode === null ? null : exitCode === 0, output_characters: itemText(item).length }];
  });
  const testAttempts = verificationAttempts.filter((attempt) => attempt.kind === "test");
  const methodReads = (method) => observedReads.filter((read) => read.method === method);
  const methodCharacters = (method) => {
    const readsForMethod = methodReads(method);
    return readsForMethod.length === 0 ? null : readsForMethod.reduce((sum, read) => sum + read.response_characters, 0);
  };
  const targetReads = patterns.length === 0 ? null : observedReads.filter((read) => patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`)));
  const componentCharacters = Object.fromEntries(DISCOVERY_COMPONENTS.map((component) => {
    const matching = observedReads.filter((read) => read.components.includes(component));
    return [component, matching.length === 0 ? null : matching.reduce((sum, read) => sum + read.response_characters, 0)];
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
    shell: methodCharacters("shell"),
    tgrep: methodCharacters("tgrep"),
  };
  return {
    ...codexActions,
    repository_read_calls: observedReads.length,
    configured_repository_read_calls: reads.length,
    assigned_tgrep_calls: arm === "tgrep" ? reads.length : 0,
    repository_context_characters: observedReads.reduce((sum, read) => sum + read.response_characters, 0),
    host_instruction_read_calls: hostInstructionReads.length,
    host_instruction_context_characters: hostInstructionReads.reduce((sum, read) => sum + read.response_characters, 0),
    tool_output_characters: outputCharactersByMethod.mcp,
    shell_output_characters: outputCharactersByMethod.shell,
    tgrep_output_characters: outputCharactersByMethod.tgrep,
    output_characters_by_method: outputCharactersByMethod,
    mcp_component_bytes: mcpComponentBytes,
    mcp_component_classification: mcpComponentClassification,
    target_attributed_characters: targetReads === null ? null : targetReads.reduce((sum, read) => sum + read.response_characters, 0),
    target_unattributed_characters: targetReads === null ? null : observedReads.filter((read) => !targetReads.includes(read)).reduce((sum, read) => sum + read.response_characters, 0),
    context_component_characters: componentCharacters,
    context_component_calls: componentCalls,
    context_calls_attributed_to_declared_targets: patterns.length === 0 ? null : observedReads.filter((read) => patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`))).length,
    context_calls_unattributed_to_declared_targets: patterns.length === 0 ? null : observedReads.filter((read) => !patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`))).length,
    context_characters_unattributed_to_declared_targets: patterns.length === 0 ? null : observedReads.filter((read) => !patterns.some((pattern) => pattern.test(`${read.request}\n${read.response}`))).reduce((sum, read) => sum + read.response_characters, 0),
    observed_discovery_calls: observedReads.length,
    observed_discovery_before_edit: observedDiscoveryIndices.length > 0 && (observedFirstEdit === undefined || observedDiscoveryIndices[0] < observedFirstEdit),
    observed_post_edit_discovery_calls: observedFirstEdit === undefined ? 0 : observedDiscoveryIndices.filter((index) => index > observedFirstEdit).length,
    observed_rediscovery_after_each_edit: edits.every((edit) => observedDiscoveryIndices.some((discovery) => discovery > edit)),
    observed_tool_usage: {
      mcp_calls: observedReads.filter((read) => read.method === "mcp").length,
      shell_calls: observedReads.filter((read) => read.method === "shell").length,
      tgrep_calls: observedReads.filter((read) => read.method === "tgrep").length,
      host_instruction_reads: hostInstructionReads.length,
    },
    discovery_adoption: {
      mcp_before_shell: mcpBeforeShell,
      shell_after_mcp: shellAfterMcp,
      zero_mcp: mcpIndices.length === 0,
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
