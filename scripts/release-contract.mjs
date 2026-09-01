/* c8 ignore file */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "release/release-config.json");

export const SUPPORTED_TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64",
]);

export const NATIVE_NPM_PACKAGES = Object.freeze({
  "darwin-arm64": "@urdira/native-darwin-arm64",
  "darwin-x64": "@urdira/native-darwin-x64",
  "linux-arm64-gnu": "@urdira/native-linux-arm64-gnu",
  "linux-x64-gnu": "@urdira/native-linux-x64-gnu",
  "win32-x64": "@urdira/native-win32-x64",
});

export const NATIVE_NPM_PACKAGE_NAMES = Object.freeze(SUPPORTED_TARGETS.map((target) => NATIVE_NPM_PACKAGES[target]));

export const PRODUCTION_PACKAGE_NAMES = Object.freeze([
  "urdira",
  "@urdira/runtime",
  "@urdira/cli",
  "@urdira/mcp",
  "@urdira/web",
  "@urdira/daemon",
  "@urdira/engine",
  "@urdira/embedding-local",
  "@urdira/storage",
  "@urdira/security",
  "@urdira/plugin-sdk",
  "@urdira/plugin-javascript-typescript",
  "@urdira/native",
  "@urdira/canonical",
  "@urdira/contracts",
]);

export const NPM_PUBLIC_PACKAGE_NAMES = Object.freeze([
  ...PRODUCTION_PACKAGE_NAMES,
  ...NATIVE_NPM_PACKAGE_NAMES,
]);

export const FORBIDDEN_PRODUCTION_PATTERNS = Object.freeze([
  /(?:^|\/)tests?(?:\/|$)/iu,
  /(?:^|\/)fixtures?(?:\/|$)/iu,
  /packages\/testkit(?:\/|$)/iu,
  /synthetic-workers/iu,
  /\.urdira-plugin(?:\/|$)/iu,
  /(?:^|\/)language-plugin(?:\/|$)/iu,
]);

export const RELEASE_GATES = Object.freeze(["unit", "contract", "integration", "e2e", "crash", "corruption", "security", "watcher", "benchmark", "package_inspection"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export async function readReleaseConfig(configPath = CONFIG_PATH) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

export function validateReleaseConfig(config) {
  const errors = [];
  if (config?.release_schema_version !== 1) errors.push("release_schema_version must be 1");
  if (!Array.isArray(config?.targets) || config.targets.length !== SUPPORTED_TARGETS.length) errors.push("target matrix is incomplete");
  else {
    const ids = config.targets.map((target) => target?.id);
    if (JSON.stringify(ids) !== JSON.stringify(SUPPORTED_TARGETS)) errors.push("target matrix order or ids are invalid");
    if (config.targets.some((target) => typeof target?.watcher_package !== "string" || !target.watcher_package.endsWith("@2.6.0"))) errors.push("target watcher coordinates are not frozen");
    if (config.targets.some((target) => typeof target?.rust_target !== "string" || target.rust_target.length === 0)) errors.push("target Rust coordinates are not frozen");
  }
  if (JSON.stringify(config?.production_packages) !== JSON.stringify(PRODUCTION_PACKAGE_NAMES)) errors.push("production package allowlist is invalid");
  if (JSON.stringify(config?.native_npm_packages) !== JSON.stringify(NATIVE_NPM_PACKAGES)) errors.push("native npm package registry is invalid");
  if (JSON.stringify(config?.gates) !== JSON.stringify(RELEASE_GATES)) errors.push("release gates are incomplete or reordered");
  if (config?.semantic_model?.model_id !== "Xenova/all-MiniLM-L6-v2" || config.semantic_model.acquisition !== "configure_time_download" || config.semantic_model.bundled_assets !== false) errors.push("semantic model delivery policy is invalid");
  if (config?.runtime?.rust_toolchain !== "1.98.0" || config.runtime.node_api !== 10 || config.runtime.worker_protocol !== "urdira.ipc.v2" || config.runtime.jsts_parser !== "oxc") errors.push("native runtime coordinates are invalid");
  for (const [name, version] of Object.entries(config?.dependencies ?? {})) if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(version))) errors.push(`dependency ${name} is not pinned to an exact version`);
  return errors;
}

export function buildReleaseMetadata({ gitCommit, lockfileDigest, generatedAt = "1970-01-01T00:00:00.000Z" }) {
  if (!gitCommit || !lockfileDigest) throw new Error("Release metadata requires git commit and lockfile digest.");
  return stable({
    release_schema_version: 1,
    engine_version: "0.3.3",
    generated_at: generatedAt,
    git_commit: gitCommit,
    lockfile_digest: lockfileDigest,
    runtime: { node: "24.18.1", pnpm: "11.20.0", sqlite: "node:sqlite", watcher: "@parcel/watcher@2.6.0", semantic_runtime: "@huggingface/transformers@4.2.0", sandbox_contract: "plugin-sdk:restricted-node@1", rust_toolchain: "1.98.0", node_api: 10, worker_protocol: "urdira.ipc.v2", jsts_parser: "oxc" },
    targets: [...SUPPORTED_TARGETS],
    production_packages: [...PRODUCTION_PACKAGE_NAMES],
    native_npm_packages: { ...NATIVE_NPM_PACKAGES },
    dependencies: { "@huggingface/transformers": "4.2.0", "@modelcontextprotocol/client": "2.0.0", "@modelcontextprotocol/server": "2.0.0", "@parcel/watcher": "2.6.0", "@vitejs/plugin-react": "6.1.0", "adm-zip": "0.6.0", cytoscape: "3.34.1", "isomorphic-git": "1.40.5", react: "19.2.8", "react-dom": "19.2.8", sharp: "0.35.3", typescript: "7.0.2", vite: "8.2.2", vitest: "4.1.10", eslint: "9.39.5" },
    semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", acquisition: "configure_time_download", bundled_assets: false },
    gates: [...RELEASE_GATES],
  });
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
