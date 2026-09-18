import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Keep merge CI focused on deterministic native contract and storage checks.
// Full ignored suites and corpus-scale campaigns remain available through the
// explicit benchmark scripts and are never part of this smoke gate.
run("cargo", ["test", "-p", "urdira-worker-protocol", "--locked"]);
run("cargo", ["test", "-p", "urdira-native-core", "--locked"]);
run("cargo", ["test", "-p", "urdira-structural-store", "--locked", "--lib"]);
