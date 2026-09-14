import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Preserve only session files, never the isolated home's authentication. */
export function retainCodexHostSessions(home, destination) {
  const source = join(home, ".codex", "sessions");
  if (!existsSync(source)) return null;
  const sessions = [];
  const blocked = new Map();
  let malformedLines = 0;
  const walk = (relative = "") => {
    for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      mkdirSync(join(destination, relative), { recursive: true });
      const path = join(destination, name);
      copyFileSync(join(source, name), path);
      const raw = readFileSync(path);
      sessions.push({ path, sha256: createHash("sha256").update(raw).digest("hex") });
      for (const [index, line] of raw.toString("utf8").split("\n").entries()) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { malformedLines++; continue; }
        const payload = event?.payload;
        if (event?.type !== "response_item" || payload?.type !== "custom_tool_call_output" || !Array.isArray(payload.output)) continue;
        for (const item of payload.output) {
          if (typeof item?.text !== "string" || !item.text.includes("Command blocked by PreToolUse hook:")) continue;
          const key = `${name}:${payload.call_id ?? index}`;
          blocked.set(key, { session: path, call_id: payload.call_id ?? null, text: item.text });
        }
      }
    }
  };
  walk();
  return { sessions, blocked_shell_attempts: [...blocked.values()], malformed_lines: malformedLines };
}
