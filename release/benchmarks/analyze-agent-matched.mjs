#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { summarizeTokenUsage, withTokenCost } from "./benchmark-token-metrics.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: analyze-agent-matched.mjs <transcript.jsonl>");
const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const completed = events.filter((event) => event.type === "item.completed");
const count = (type) => completed.filter((event) => event.item?.type === type).length;
const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {});
const counterMode = process.env.BENCH_COUNTER_MODE ?? events.find((event) => event.counter_mode === "cumulative" || event.counter_mode === "per_turn")?.counter_mode;
// These are transparent planning rates, not provider billing. Override them
// when a benchmark report has a current model price card.
const inputRate = Number(process.env.BENCH_INPUT_USD_PER_MILLION ?? 2);
const cachedInputRate = Number(process.env.BENCH_CACHED_INPUT_USD_PER_MILLION ?? process.env.BENCH_INPUT_USD_PER_MILLION ?? 2);
const outputRate = Number(process.env.BENCH_OUTPUT_USD_PER_MILLION ?? 8);
const reasoningRate = Number(process.env.BENCH_REASONING_USD_PER_MILLION ?? 8);
const tokenMetrics = withTokenCost(summarizeTokenUsage(usage, { counterMode }), {
  input: inputRate,
  cached_input: cachedInputRate,
  output: outputRate,
  reasoning: reasoningRate,
});
const started = events.find((event) => event.type === "thread.started")?.timestamp;
const result = {
  transcript: path,
  outer_turns: events.filter((event) => event.type === "turn.completed").length,
  observable_agent_iterations: count("agent_message"),
  command_actions: count("command_execution"),
  mcp_calls: count("mcp_tool_call"),
  file_change_batches: count("file_change"),
  ...tokenMetrics,
  token_usage_semantics_evidence: tokenMetrics.counter_mode === "cumulative" || tokenMetrics.counter_mode === "per_turn"
    ? `explicit counter_mode=${tokenMetrics.counter_mode}`
    : "counter_mode absent; multi-turn aggregate is unknown and raw versus reasoning inclusion remains unknown",
  first_thread_timestamp: started ?? null,
};
console.log(JSON.stringify(result, null, 2));
