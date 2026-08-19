#!/usr/bin/env node
import { runUrdira, runUrdiraMcp, URDIRA_VERSION, urdiraHelp } from "./index.js";

const endpoint = process.env["URDIRA_ENDPOINT"];
const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
  process.stdout.write(`${URDIRA_VERSION}\n`);
} else if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
  process.stdout.write(urdiraHelp());
} else if (argv[0] === "mcp") {
  const handle = await runUrdiraMcp({ ...(endpoint === undefined ? {} : { endpoint }) });
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  await handle.close();
} else {
  const result = await runUrdira(argv, { ...(endpoint === undefined ? {} : { endpoint }) });
  process.stdout.write(result.stdout);
  process.exitCode = result.exit_code;
}
