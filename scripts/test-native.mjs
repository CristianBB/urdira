import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { arch, platform } from "node:process";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");

function nativeTarget() {
  const targets = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64",
    "linux-x64": "linux-x64",
    "win32-arm64": "win32-arm64",
    "win32-x64": "win32-x64",
  };
  const target = targets[`${platform}-${arch}`];
  if (target === undefined) {
    throw new Error(`Unsupported host for tsgo native tests: ${platform}/${arch}`);
  }
  return target;
}

function tsgoBinary() {
  const target = nativeTarget();
  const pnpmRoot = join(repositoryRoot, "node_modules", ".pnpm");
  const packagePrefix = `@typescript+typescript-${target}@`;
  const packageDirectory = readdirSync(pnpmRoot).find((entry) => entry.startsWith(packagePrefix));
  if (packageDirectory === undefined) {
    throw new Error(`Missing @typescript/typescript-${target} package under ${pnpmRoot}`);
  }
  const binary = join(
    pnpmRoot,
    packageDirectory,
    "node_modules",
    `@typescript/typescript-${target}`,
    "lib",
    "tsc",
  );
  if (!existsSync(binary)) throw new Error(`Missing TypeScript compiler binary: ${binary}`);
  return binary;
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("cargo", ["test", "--workspace", "--locked"]);

const env = { URDIRA_TSGO_BINARY: tsgoBinary() };
run("cargo", [
  "test", "-p", "urdira-tsgo-client", "--locked",
  "--test", "residual_pass", "--test", "semantic_extras", "--test", "rpc_error_repro",
  "--test", "binding_element_test", "--test", "oracle_resolve", "--", "--ignored",
], env);
run("cargo", ["test", "-p", "urdira-tsgo-client", "--locked", "--lib", "--", "--ignored"], env);
run("cargo", [
  "test", "-p", "urdira-indexing-worker", "--locked", "--", "--ignored",
  "inferred_types_and_diagnostics_across_two_runs_and_an_edit",
  "residual_emits_types_and_diagnostics_with_zero_pending_sites",
], env);
