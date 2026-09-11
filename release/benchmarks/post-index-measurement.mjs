#!/usr/bin/env node
/* global URL, structuredClone */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OPS = ["core:resolve_symbol", "core:find_records", "core:search_text", "core:compare_workspaces"];
const operationKey = (operation) => String(operation).replace(/^core:/u, "");
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const nullMetric = () => ({ calls: 0, successes: 0, failures: 0, pages: 0, latency_ms: { count: 0, total: null, average: null, p95: null }, completeness: [], cap_applied: null, bytes: { snippets: null, hydration: null, evidence: null, registry: null } });
const compactTextObject = (text) => {
  const lines = String(text).split("\n");
  const coverage = lines.find((line) => /^coverage:\s+(?:\S+)/u.test(line))?.match(/^coverage:\s+(\S+)/u)?.[1] ?? null;
  const truncated = lines.some((line) => /^TRUNCATED:/u.test(line));
  const hasMore = lines.some((line) => /^(?:MORE(?:\s|:)|[\w.]+:\s+\S)/u.test(line));
  return {
    ...(coverage === null ? {} : { completeness: coverage }),
    ...(truncated ? { cap: { applied: true, truncated: true } } : {}),
    ...(hasMore ? { pagination: { has_next: true } } : {}),
  };
};
const resultObject = (item) => {
  const result = item?.result ?? item?.response;
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (result?.structured_content && typeof result.structured_content === "object") return result.structured_content;
  const texts = Array.isArray(result?.content) ? result.content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")) : [];
  for (const text of texts) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object") return parsed; } catch { /* compact text is parsed below */ } }
  for (const text of texts) {
    const parsed = compactTextObject(text);
    if (Object.keys(parsed).length > 0) return parsed;
  }
  return {};
};
const query = (item) => item?.arguments?.query ?? item?.arguments?.request?.query ?? item?.arguments?.request ?? item?.arguments ?? {};
const expression = (item) => query(item)?.expression ?? query(item)?.query?.expression;
const operationOf = (item) => {
  const current = expression(item);
  const operation = current?.operation ?? item?.operation ?? null;
  if (operation === "core:compare") return "core:compare_workspaces";
  if (current?.expression_type === "recipe" && (current.recipe_id === "core:compare_workspaces" || current.recipe_id === "compare_workspaces")) return "core:compare_workspaces";
  if (current?.expression_type === "pipeline" && Array.isArray(current.stages) && current.stages.some((stage) => stage?.operation === "core:compare")) return "core:compare_workspaces";
  return operation;
};
const cursorCall = (item) => Boolean(query(item)?.continuation?.cursor ?? query(item)?.cursor);
const timestamp = (event) => Date.parse(event?.timestamp ?? "");
const latency = (started, completed) => {
  if (Number.isFinite(completed?.duration_ms)) return Number(completed.duration_ms);
  const a = timestamp(started), b = timestamp(completed); return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
};
const percentile = (values, p) => { const a = values.filter((v) => v !== null).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] : null; };
const addBytes = (target, bytes) => { for (const key of Object.keys(target)) { const value = finite(bytes?.[key]); if (value !== null) target[key] = (target[key] ?? 0) + value; } };
const extractCompleteness = (value) => typeof value?.completeness === "string" ? value.completeness : null;

export { compactTextObject, operationOf, resultObject };

export function buildPostMeasurementPlan({ corpus, repositoryIds, sample = 1 } = {}) {
  const repositories = Array.isArray(corpus?.repositories) ? corpus.repositories : [];
  const ids = repositoryIds?.length ? repositoryIds : repositories.map((repo) => repo.id);
  const selected = ids.map((id) => repositories.find((repo) => repo.id === id)).filter(Boolean);
  if (selected.length !== ids.length) throw new Error(`Unknown repository id in directed sample: ${ids.find((id) => !repositories.some((repo) => repo.id === id))}`);
  return {
    schema_version: 1, sample, repositories: selected.map(({ id, repository, commit }) => ({ id, repository, commit })),
    environment: { readiness: "structural", semantic_index: false, semantic_materialization: false, semantic_sidecar: false, reconciliation_sweep_interval_ms: 0, production_mcp_instructions: true, mcp_instructions: "production", pipeline_required: false, extra_prompt: false },
    operations: [
      { operation: "core:resolve_symbol", variants: ["context", "qualified", "kind"], latency: true },
      { operation: "core:find_records", paginated: true, caps_and_completeness: true, latency: true },
      { operation: "core:search_text", paginated: true, caps_and_completeness: true, latency: true },
      { operation: "core:compare_workspaces", latency: true, caps_and_completeness: true },
    ],
    accounting: { bytes: ["snippets", "hydration", "evidence", "registry"], adoption: ["mcp_before_shell", "shell_after_mcp", "zero_mcp"], missing_is: null },
  };
}

export function analyzePostMeasurement({ events = [], plan, hostMetrics = null } = {}) {
  const selectedPlan = plan ?? buildPostMeasurementPlan({ corpus: { repositories: [] }, repositoryIds: [] });
  const byId = new Map();
  events.filter((event) => event?.type === "item.started" && event.id).forEach((event) => byId.set(event.id, event));
  const operations = Object.fromEntries(OPS.map((op) => [operationKey(op), nullMetric()]));
  const durationsByOperation = Object.fromEntries(OPS.map((op) => [operationKey(op), []]));
  let lastPaginatedOperation = null;
  const failures = [];
  for (const event of events.filter((entry) => entry?.type === "item.completed")) {
    const item = event.item ?? event;
    if (item?.type !== "mcp_tool_call" || !["urdira_query", "urdira_context"].includes(item.tool)) continue;
    const operation = operationOf(item) ?? (cursorCall(item) ? lastPaginatedOperation : null);
    if (!OPS.includes(operation)) continue;
    const key = operationKey(operation), metric = operations[key], data = resultObject(item);
    if (operation === "core:find_records" || operation === "core:search_text") lastPaginatedOperation = operation;
    const duration = latency(byId.get(event.id), event);
    metric.calls += 1; metric.pages += operation === "core:find_records" || operation === "core:search_text" ? 1 : 0;
    if (item.status === "failed") { metric.failures += 1; failures.push({ operation, id: event.id ?? null, error: data.error ?? null }); }
    else metric.successes += 1;
    metric.completeness.push(extractCompleteness(data));
    const cap = data.cap ?? data.caps; if (cap && (cap.applied === true || cap.truncated === true)) metric.cap_applied = true;
    addBytes(metric.bytes, data.bytes);
    if (duration !== null) { metric.latency_ms.count += 1; metric.latency_ms.total = (metric.latency_ms.total ?? 0) + duration; durationsByOperation[key].push(duration); }
  }
  for (const metric of Object.values(operations)) {
    metric.latency_ms.average = metric.latency_ms.count ? metric.latency_ms.total / metric.latency_ms.count : null;
    metric.latency_ms.p95 = percentile(durationsByOperation[operationKey(Object.keys(operations).find((name) => operations[name] === metric) ?? "")], 0.95);
    for (const key of Object.keys(metric.bytes)) if (metric.bytes[key] === null) metric.bytes[key] = null;
    if (metric.cap_applied === null) metric.cap_applied = metric.calls ? false : null;
  }
  const mcpIndices = events.map((event, index) => event?.type === "item.completed" && event.item?.type === "mcp_tool_call" ? index : -1).filter((i) => i >= 0);
  const shellIndices = events.map((event, index) => event?.type === "item.completed" && event.item?.type === "command_execution" ? index : -1).filter((i) => i >= 0);
  const adoption = { mcp_before_shell: mcpIndices.length && shellIndices.length ? Math.min(...mcpIndices) < Math.min(...shellIndices) : null, shell_after_mcp: mcpIndices.length && shellIndices.length ? Math.max(...shellIndices) > Math.min(...mcpIndices) : null, zero_mcp: mcpIndices.length === 0 };
  const readiness = hostMetrics ? { structural_readiness_ms: finite(hostMetrics.structural_readiness_ms), semantic_index: hostMetrics.semantic_index ?? false, semantic_materialization: hostMetrics.semantic_materialization ?? false, semantic_sidecar: hostMetrics.semantic_sidecar_created ?? false } : null;
  return { schema_version: 1, repository_ids: selectedPlan.repositories.map((repo) => repo.id), readiness, operations, adoption, failures, limitations: ["latency p95 requires per-call duration samples in the supplied raw events", "byte fields are reported only when the production response identifies them", "no competitor is executed by this harness"] };
}

export function mergePostMeasurements(report, postReport) {
  const output = structuredClone(report);
  const normalize = (measurement) => {
    const value = measurement ? structuredClone(measurement) : {};
    value.operations ??= {};
    for (const operation of OPS) value.operations[operationKey(operation)] ??= null;
    value.readiness ??= null;
    value.adoption ??= null;
    value.failures ??= [];
    return value;
  };
  const entries = new Map((postReport?.runs ?? []).map((run) => [`${run.repository_id}/${run.task_id}/${run.arm}/${run.sample}`, normalize(run.post_measurement)]));
  output.runs = (output.runs ?? []).map((run) => ({ ...run, post_measurement: entries.get(`${run.repository_id}/${run.task_id}/${run.arm}/${run.sample}`) ?? null }));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2), get = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const corpus = JSON.parse(readFileSync(get("--corpus") ?? "release/benchmarks/expanded-typescript-agent-benchmark.json", "utf8"));
  const ids = (get("--repositories") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const plan = buildPostMeasurementPlan({ corpus, repositoryIds: ids.length ? ids : undefined, sample: Number(get("--sample") ?? 1) });
  const output = get("--output"); if (output) writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`); else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
