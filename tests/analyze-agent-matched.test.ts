import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("preserves unavailable counters and emits the cached input rate card", async () => {
  const root = await mkdtemp(join(tmpdir(), "urdira-analyze-usage-"));
  const transcript = join(root, "run.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 4 } })}\n`, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [resolve("release/benchmarks/analyze-agent-matched.mjs"), transcript]);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ cached_input_tokens: null, uncached_input_tokens: null, total_tokens: 114, estimated_cost_usd: null, estimated_cost_rates_usd_per_million: { input: 2, cached_input: 2, output: 8, reasoning: 8 } });
});

it("does not infer cumulative usage from monotonic per-turn counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "urdira-analyze-counter-mode-"));
  const transcript = join(root, "run.jsonl");
  const events = [1, 2, 3].flatMap((turn) => [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.completed", usage: { input_tokens: turn * 10, cached_input_tokens: turn * 5, output_tokens: turn * 2, reasoning_output_tokens: turn } },
  ]);
  await writeFile(transcript, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [resolve("release/benchmarks/analyze-agent-matched.mjs"), transcript]);
  expect(JSON.parse(stdout)).toMatchObject({ token_usage_semantics: "unknown", input_tokens: null, total_tokens: null, estimated_cost_usd: null });
});
