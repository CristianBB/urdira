/* External timing for Codex JSONL output. The transcript itself remains the
 * exact stdout byte stream; this module only observes complete lines as they
 * arrive and writes a separate, metadata-only sidecar. */

import { Buffer } from "node:buffer";

const trackedItemTypes = new Set(["mcp_tool_call", "command_execution"]);

const monotonicMilliseconds = (clock) => {
  const value = clock();
  return typeof value === "bigint" ? Number(value) / 1_000_000 : Number(value);
};

const itemMetadata = (item) => {
  if (item?.type === "mcp_tool_call") return {
    kind: "mcp",
    server: typeof item.server === "string" ? item.server : null,
    tool: typeof item.tool === "string" ? item.tool : null,
    status: typeof item.status === "string" ? item.status : null,
  };
  if (item?.type === "command_execution") {
    const command = item.command ?? item.cmd ?? item.command_line;
    return {
      kind: "command",
      command: typeof command === "string" ? command.slice(0, 1_000) : null,
      status: typeof item.status === "string" ? item.status : null,
      exit_code: Number.isSafeInteger(item.exit_code) ? item.exit_code : null,
    };
  }
  return { kind: null };
};

const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};

const aggregateCalls = (calls, key) => {
  const grouped = {};
  for (const call of calls) {
    const group = call[key] ?? "unknown";
    (grouped[group] ??= []).push(call);
  }
  return Object.fromEntries(Object.entries(grouped).map(([group, entries]) => {
    const durations = entries.map((entry) => entry.duration_ms).filter(Number.isFinite);
    return [group, {
      calls: entries.length,
      paired_calls: entries.filter((entry) => entry.pairing_status === "paired").length,
      completed_calls: entries.filter((entry) => entry.status === "completed").length,
      failed_calls: entries.filter((entry) => entry.status === "failed").length,
      total_duration_ms: durations.length === 0 ? null : durations.reduce((sum, duration) => sum + duration, 0),
      mean_duration_ms: durations.length === 0 ? null : durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
      p50_duration_ms: percentile(durations, 0.5),
      p95_duration_ms: percentile(durations, 0.95),
    }];
  }));
};

const summarizeTurns = (turns) => {
  const allCalls = turns.flatMap((turn) => turn.calls);
  const mcpCalls = allCalls.filter((call) => call.kind === "mcp");
  const commandCalls = allCalls.filter((call) => call.kind === "command");
  return {
    schema_version: 1,
    clock: "process.hrtime.bigint",
    turns,
    mcp_calls: mcpCalls,
    command_calls: commandCalls,
    aggregates: {
      mcp_by_tool: aggregateCalls(mcpCalls, "tool"),
      commands_by_command: aggregateCalls(commandCalls, "command"),
    },
  };
};

/** Create an observer for one Codex process. `ingest` accepts arbitrary
 * stdout chunks, including chunks that split a JSON object or contain many
 * lines. */
export function createTimingCapture({ clock = () => process.hrtime.bigint(), label = "turn" } = {}) {
  let buffer = "";
  let lineNumber = 0;
  let currentTurn = 0;
  const lines = [];
  const states = new Map();
  let malformedLines = 0;

  const observeLine = (line) => {
    if (line.length === 0) return;
    const receivedMonotonicMs = monotonicMilliseconds(clock);
    lineNumber += 1;
    let event;
    try { event = JSON.parse(line); } catch {
      malformedLines += 1;
      lines.push({ line: lineNumber, event_type: "invalid_json", received_monotonic_ms: receivedMonotonicMs, turn: currentTurn });
      return;
    }
    if (event?.type === "turn.started") currentTurn += 1;
    const item = event?.item;
    const metadata = itemMetadata(item);
    const itemId = typeof item?.id === "string" ? item.id : null;
    lines.push({
      line: lineNumber,
      event_type: typeof event?.type === "string" ? event.type : null,
      item_id: itemId,
      item_type: typeof item?.type === "string" ? item.type : null,
      received_monotonic_ms: receivedMonotonicMs,
      turn: currentTurn,
    });
    if (!itemId || !trackedItemTypes.has(item?.type)) return;
    const existing = states.get(itemId);
    if (event.type === "item.started") {
      if (existing?.started !== undefined) existing.duplicate_starts = (existing.duplicate_starts ?? 0) + 1;
      else states.set(itemId, { ...metadata, item_id: itemId, started: receivedMonotonicMs, turn: currentTurn, duplicate_starts: 0 });
    } else if (event.type === "item.completed") {
      const state = existing ?? { ...metadata, item_id: itemId, started: null, turn: currentTurn, duplicate_starts: 0 };
      states.set(itemId, {
        ...state,
        ...metadata,
        completed: receivedMonotonicMs,
        completed_turn: currentTurn,
      });
    }
  };

  const ingest = (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      observeLine(line);
    }
  };

  const finish = () => {
    if (buffer.length > 0) { observeLine(buffer); buffer = ""; }
    const calls = [...states.values()].map((state) => {
      const pairingStatus = state.started !== null && state.completed !== undefined
        ? "paired"
        : state.started === null ? "completed_without_start" : "started_without_completion";
      return {
        item_id: state.item_id,
        kind: state.kind,
        server: state.server,
        tool: state.tool,
        command: state.command,
        status: state.status,
        exit_code: state.exit_code,
        turn: state.turn,
        completed_turn: state.completed_turn ?? null,
        started_monotonic_ms: state.started,
        completed_monotonic_ms: state.completed ?? null,
        duration_ms: pairingStatus === "paired" ? Math.max(0, state.completed - state.started) : null,
        pairing_status: pairingStatus,
        duplicate_starts: state.duplicate_starts ?? 0,
      };
    });
    return { schema_version: 1, label, line_count: lineNumber, malformed_lines: malformedLines, lines, calls };
  };

  return { ingest, finish };
}

export function summarizeTimingCaptures(captures) {
  return summarizeTurns((captures ?? []).map((capture) => capture?.schema_version === 1 ? capture : { ...capture, calls: capture?.calls ?? [], lines: capture?.lines ?? [] }));
}
