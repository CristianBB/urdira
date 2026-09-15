import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent-context replay", () => {
  it("uses hook audit sidecars without replaying them as agent transcripts", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-replay-hook-audit-"));
    const run = join(root, "playwright-affected-tests-deterministic-urdira-typescript-1");
    const transcript = `${run}.jsonl`;
    const audit = `${run}.hook-audit.jsonl`;
    const output = join(root, "replay.json");
    writeFileSync(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } })}\n`);
    writeFileSync(audit, `${JSON.stringify({ client: "codex", decision: "fallback", fallback_reason: "unsupported_input" })}\n`);
    writeFileSync(`${run}.json`, `${JSON.stringify({
      run_id: "playwright-affected-tests-deterministic-urdira-typescript-1",
      repository_id: "playwright",
      task_id: "affected-tests-deterministic",
      arm: "urdira-typescript",
      hook_audit_path: audit,
    })}\n`);

    execFileSync(process.execPath, ["release/benchmarks/replay-agent-context.mjs", "--output", output, root], { cwd: process.cwd() });
    const replay = JSON.parse(readFileSync(output, "utf8")) as {
      runs: Array<{ metrics: { observed_tool_usage: { urdira_hook_calls: number; urdira_hook_fallback_calls: number } } }>;
    };
    expect(replay.runs).toHaveLength(1);
    expect(replay.runs[0]?.metrics.observed_tool_usage).toMatchObject({
      urdira_hook_calls: 1,
      urdira_hook_fallback_calls: 1,
    });
  });

  it("ignores a bare hook-audit JSONL file", () => {
    const root = mkdtempSync(join(tmpdir(), "urdira-replay-bare-hook-audit-"));
    const transcript = join(root, "run.jsonl");
    const output = join(root, "replay.json");
    writeFileSync(transcript, `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } })}\n`);
    writeFileSync(join(root, "hook-audit.jsonl"), `${JSON.stringify({ client: "codex", decision: "fallback" })}\n`);
    writeFileSync(join(root, "run.json"), `${JSON.stringify({ arm: "baseline" })}\n`);

    execFileSync(process.execPath, ["release/benchmarks/replay-agent-context.mjs", "--output", output, root], { cwd: process.cwd() });
    const replay = JSON.parse(readFileSync(output, "utf8")) as { runs: Array<{ raw: { transcript: string } }> };
    expect(replay.runs).toHaveLength(1);
    expect(replay.runs[0]?.raw.transcript).toBe(transcript);
  });
});
