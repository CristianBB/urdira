/* global setTimeout */
import { runUrdiraMcp } from "../../apps/urdira/dist/index.js";

const handle = await runUrdiraMcp({
  data_root: process.env.URDIRA_DATA_ROOT,
});

const shutdown = () => {
  handle.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
