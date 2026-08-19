#!/usr/bin/env node
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Usage: analyze-agent-matched.mjs <transcript.jsonl>");
const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const completed = events.filter((event) => event.type === "item.completed");
const count = (type) => completed.filter((event) => event.item?.type === type).length;
const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {});
const input = usage.reduce((sum, item) => sum + Number(item.input_tokens ?? 0), 0);
const cachedInput = usage.reduce((sum, item) => sum + Number(item.cached_input_tokens ?? 0), 0);
const output = usage.reduce((sum, item) => sum + Number(item.output_tokens ?? 0), 0);
const reasoning = usage.reduce((sum, item) => sum + Number(item.reasoning_output_tokens ?? 0), 0);
// These are transparent planning rates, not provider billing. Override them
// when a benchmark report has a current model price card.
const inputRate = Number(process.env.BENCH_INPUT_USD_PER_MILLION ?? 2);
const outputRate = Number(process.env.BENCH_OUTPUT_USD_PER_MILLION ?? 8);
const reasoningRate = Number(process.env.BENCH_REASONING_USD_PER_MILLION ?? 8);
const started = events.find((event) => event.type === "thread.started")?.timestamp;
const result = {
  transcript: path,
  outer_turns: events.filter((event) => event.type === "turn.completed").length,
  observable_agent_iterations: count("agent_message"),
  command_actions: count("command_execution"),
  mcp_calls: count("mcp_tool_call"),
  file_change_batches: count("file_change"),
  input_tokens: input,
  cached_input_tokens: cachedInput,
  uncached_input_tokens: Math.max(0, input - cachedInput),
  output_tokens: output,
  reasoning_tokens: reasoning,
  total_tokens: input + output + reasoning,
  estimated_cost_usd: (input * inputRate + output * outputRate + reasoning * reasoningRate) / 1_000_000,
  estimated_cost_rates_usd_per_million: { input: inputRate, output: outputRate, reasoning: reasoningRate },
  first_thread_timestamp: started ?? null,
};
console.log(JSON.stringify(result, null, 2));
