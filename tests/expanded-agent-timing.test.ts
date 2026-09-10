import { describe, expect, it } from "vitest";
import { createTimingCapture, summarizeTimingCaptures } from "../release/benchmarks/expanded-agent-timing.mjs";

const line = (event: unknown) => `${JSON.stringify(event)}\n`;

describe("expanded agent external timing", () => {
  it("reassembles partial JSONL chunks and pairs MCP calls by item id", () => {
    let tick = 0n;
    const capture = createTimingCapture({ label: "turn-1", clock: () => { tick += 1_000_000n; return tick; } });
    const started = line({ type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "urdira", tool: "urdira_query", status: "in_progress" } });
    const completed = line({ type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "urdira", tool: "urdira_query", status: "completed" } });
    capture.ingest(started.slice(0, 9));
    capture.ingest(started.slice(9) + completed.slice(0, 4));
    capture.ingest(completed.slice(4));

    const turn = capture.finish();
    const summary = summarizeTimingCaptures([turn]);
    expect(turn.line_count).toBe(2);
    expect(turn.malformed_lines).toBe(0);
    expect(turn.calls).toHaveLength(1);
    expect(turn.calls[0]).toMatchObject({ item_id: "mcp-1", server: "urdira", tool: "urdira_query", pairing_status: "paired", duration_ms: 1 });
    expect(summary.aggregates.mcp_by_tool.urdira_query).toMatchObject({ calls: 1, paired_calls: 1, total_duration_ms: 1 });
  });

  it("keeps incomplete pairs explicit and aggregates command timing", () => {
    let tick = 0n;
    const capture = createTimingCapture({ clock: () => { tick += 2_000_000n; return tick; } });
    capture.ingest(line({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pnpm test" } }));
    capture.ingest(line({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "completed", exit_code: 0 } }));
    capture.ingest(line({ type: "item.completed", item: { id: "mcp-2", type: "mcp_tool_call", server: "other", tool: "lookup", status: "failed" } }));

    const summary = summarizeTimingCaptures([capture.finish()]);
    expect(summary.command_calls[0]).toMatchObject({ command: "pnpm test", pairing_status: "paired", duration_ms: 2, exit_code: 0 });
    expect(summary.mcp_calls[0]).toMatchObject({ item_id: "mcp-2", pairing_status: "completed_without_start", duration_ms: null });
    expect(summary.aggregates.commands_by_command["pnpm test"]).toMatchObject({ calls: 1, paired_calls: 1, total_duration_ms: 2 });
    expect(summary.aggregates.mcp_by_tool.lookup).toMatchObject({ calls: 1, paired_calls: 0, total_duration_ms: null });
  });
});

