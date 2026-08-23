/* global setTimeout */
// Focused MCP projection for the matched agent benchmark. Keeping only the
// two tools used by the protocol makes token accounting measure discovery,
// rather than unrelated public recipes and their full instruction catalogue.
import { runUrdiraMcp, buildBenchmarkInstructions } from "../../apps/urdira/dist/index.js";

const handle = await runUrdiraMcp({
  tool_names: [],
  benchmark_discover: true,
  instructions: buildBenchmarkInstructions("packages/excalidraw/tests/fixtures/agentRestoreMetadata.json"),
});
const shutdown = () => {
  handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
