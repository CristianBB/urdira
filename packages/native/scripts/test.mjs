import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("cargo", ["build", "-p", "urdira-native-node"]);

const libraryName = process.platform === "win32"
  ? "urdira_native_node.dll"
  : process.platform === "darwin"
    ? "liburdira_native_node.dylib"
    : "liburdira_native_node.so";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "urdira-native-test-"));
const binaryPath = join(temporaryDirectory, "urdira-native.node");

try {
  await copyFile(join(repositoryRoot, "target", "debug", libraryName), binaryPath);
  const pnpmPath = process.env["npm_execpath"];
  if (pnpmPath === undefined) throw new Error("pnpm did not expose npm_execpath.");
  run(process.execPath, [pnpmPath, "exec", "vitest", "run", "tests/native-loader.test.ts", "tests/native-api.test.ts"], {
    env: { ...process.env, URDIRA_NATIVE_TEST_BINARY: binaryPath },
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
