import { runUrdiraMcp, buildBenchmarkInstructions } from "../../apps/urdira/dist/index.js";

const handle = await runUrdiraMcp({
  tool_names: [],
  benchmark_discover: true,
  instructions: buildBenchmarkInstructions(),
});
const shutdown = () => { handle.close().finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
