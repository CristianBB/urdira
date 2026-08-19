import { runUrdiraMcp } from "../../apps/urdira/dist/index.js";

const handle = await runUrdiraMcp({
  tool_names: [],
  benchmark_discover: true,
  instructions: "Call urdira_benchmark_discover exactly once per benchmark iteration with the explicit workspace_root and one relevant repository-relative path. Use the returned workspace/index status and artifact evidence; never infer workspace scope from process state.",
});
const shutdown = () => { handle.close().finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
