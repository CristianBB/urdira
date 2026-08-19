/* global setTimeout */
// Focused MCP projection for the matched agent benchmark. Keeping only the
// two tools used by the protocol makes token accounting measure discovery,
// rather than unrelated public recipes and their full instruction catalogue.
import { runUrdiraMcp } from "../../apps/urdira/dist/index.js";

const handle = await runUrdiraMcp({
  tool_names: [],
  benchmark_discover: true,
  instructions: "Call urdira_benchmark_discover exactly once per instruction with {workspace_root:\"...\",path:\"packages/excalidraw/tests/fixtures/agentRestoreMetadata.json\"}. It internally performs core:index_status and uses the source snapshot for this source-safe artifact lookup whenever source_ready is true, including after structural publication; it falls back to the structural snapshot only for retained pre-source-first workspaces without a source snapshot. If neither layer is ready, do not retry.",
});
const shutdown = () => {
  handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
