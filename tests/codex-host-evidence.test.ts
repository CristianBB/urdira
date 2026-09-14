import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { it } from "vitest";
import { retainCodexHostSessions } from "../release/benchmarks/codex-host-evidence.mjs";

it("retains raw sessions and distinct hook rejections without copying authentication", () => {
  const root = `/tmp/urdira-host-evidence-${process.pid}`;
  try {
    mkdirSync(root + "/home/.codex/sessions/one", { recursive: true });
    writeFileSync(root + "/home/.codex/auth.json", "not-session-evidence");
    const event = { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "a", output: [{ text: "Command blocked by PreToolUse hook: unavailable. Command: npm test" }] } };
    const raw = JSON.stringify(event) + "\n" + JSON.stringify(event) + "\n";
    writeFileSync(root + "/home/.codex/sessions/one/raw.jsonl", raw);
    const evidence = retainCodexHostSessions(root + "/home", root + "/out");
    assert.ok(evidence);
    assert.equal(evidence.blocked_shell_attempts.length, 1);
    assert.equal(evidence.sessions.length, 1);
    assert.equal(readFileSync(evidence.sessions[0]!.path, "utf8"), raw);
    assert.equal(retainCodexHostSessions(root + "/absent", root + "/empty"), null);
    assert.equal(existsSync(root + "/out/auth.json"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
