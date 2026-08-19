/* c8 ignore file */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRelease, inspectReleaseArchive } from "./package-release.mjs";
import { RELEASE_GATES, buildReleaseMetadata, readReleaseConfig, sha256 } from "./release-contract.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export { RELEASE_GATES };

const commands = {
  unit: ["test"],
  contract: ["exec", "vitest", "run", "tests/contracts.test.ts", "tests/canonical.test.ts", "tests/canonical-coverage.test.ts"],
  integration: ["exec", "vitest", "run", "tests/phase12-integration.test.ts", "tests/phase13-mcp.test.ts"],
  e2e: ["exec", "vitest", "run", "tests/phase8-runtime.test.ts", "tests/phase10-semantic.test.ts", "tests/storage.test.ts"],
  crash: ["exec", "vitest", "run", "tests/phase5-review-fixes.test.ts", "tests/phase9-recovery.test.ts", "tests/phase12-daemon-protocol.test.ts"],
  corruption: ["exec", "vitest", "run", "tests/phase9-recovery.test.ts", "tests/phase6-review-fixes.test.ts"],
  security: ["exec", "vitest", "run", "tests/phase6-security.test.ts", "tests/phase6-review-fixes.test.ts"],
  watcher: ["exec", "vitest", "run", "tests/phase7-reconciliation.test.ts", "tests/phase7-providers.test.ts"],
};

async function runCommand(args, rootDir) {
  const started = Date.now();
  try {
    const result = await execFileAsync("pnpm", args, { cwd: rootDir, env: { ...process.env, CI: "true" }, maxBuffer: 30 * 1024 * 1024 });
    return { status: "passed", duration_ms: Date.now() - started, output: `${result.stdout}${result.stderr}`.slice(-8_000) };
  } catch (error) {
    return { status: "failed", duration_ms: Date.now() - started, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? error}`.slice(-8_000) };
  }
}

async function currentGitCommit(rootDir) {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDir });
  return result.stdout.trim();
}

export async function runBenchmark(rootDir = ROOT) {
  const corpus = JSON.parse(await readFile(join(rootDir, "release/benchmarks/corpus.json"), "utf8"));
  const corpusDigest = sha256(JSON.stringify(corpus));
  const engine = await import(join(rootDir, "packages/engine/dist/index.js"));
  const runtime = new engine.DeterministicSemanticRuntime();
  const started = Date.now();
  const outputs = [];
  for (let iteration = 0; iteration < 32; iteration++) {
    for (const entry of corpus.entries) {
      const document = engine.buildSemanticDocument({ artifact_id: entry.id, artifact_version_id: `v-${iteration}`, display_path: `${entry.id}.src`, content_class: entry.content_class, language_ids: entry.language_ids, source_text: entry.text });
      const vector = await runtime.binding("core:deterministic", "sha256:release").generateVector({
        purpose: "document",
        profile: { embedding_profile_id: "release", profile_digest: "sha256:release", dimensions: 8, element_type: "float32", normalization: "l2" },
        text: document.sections.map((section) => section.text).join("\n"),
      });
      outputs.push(vector.vector_digest);
    }
  }
  return { status: "passed", corpus_digest: corpusDigest, output_digest: sha256(outputs.join("\n")), iterations: 32, entries: corpus.entries.length, duration_ms: Date.now() - started };
}

async function runConformanceProbes(rootDir) {
  const engine = await import(join(rootDir, "packages/engine/dist/index.js"));
  const runtime = new engine.DeterministicSemanticRuntime();
  const input = { purpose: "document", profile: { embedding_profile_id: "release", profile_digest: "sha256:release", dimensions: 8, element_type: "float32", normalization: "l2" }, text: "release conformance" };
  const first = await runtime.binding("core:deterministic", "sha256:release").generateVector(input);
  const second = await runtime.binding("core:deterministic", "sha256:release").generateVector(input);
  if (first.vector_digest !== second.vector_digest) throw new Error("Deterministic semantic conformance probe was not stable.");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE release_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO release_probe (value) VALUES ('ok');");
  if (database.prepare("SELECT value FROM release_probe WHERE id = 1").get()?.value !== "ok") throw new Error("SQLite conformance probe failed.");
  database.close();
  const pluginSdk = await import("@urdira/plugin-sdk");
  if (typeof pluginSdk.RestrictedNodeSandbox !== "function") throw new Error("Restricted sandbox conformance probe failed.");
  return { semantic: "passed", sqlite: "passed", sandbox: "passed" };
}

async function packageInspection(rootDir, outputDir) {
  const conformance = await runConformanceProbes(rootDir);
  const result = await buildRelease({ rootDir, outputDir, targets: undefined, clean: true, build: true });
  const config = await readReleaseConfig();
  const required = ["package.json", "platform.json", "release.json", "checksums.sha256", "schemas/registry.json", "README.md", "LICENSE", "dist/index.js", "node_modules/@urdira/engine/dist/index.js", "node_modules/@urdira/mcp/dist/index.js", "node_modules/@urdira/daemon/dist/index.js", "node_modules/@urdira/daemon/dist/semantic-maintenance-process.js", "node_modules/@urdira/daemon/dist/semantic-neural-process.js"];
  const checks = {};
  for (const archive of result.archives) {
    const inspection = await inspectReleaseArchive(archive.path);
    const platform = inspection.platform ?? {};
    const targetConfig = config.targets.find((target) => target.id === archive.target);
    checks[archive.target] = {
      forbidden: inspection.forbidden.length,
      symlinks: inspection.symlinks.length,
      archive_errors: inspection.errors.length,
      checksum_failures: inspection.checksum_failures.length,
      required: required.every((path) => inspection.files.includes(path)),
      conformance: platform.target === archive.target
        && platform.runtime?.sqlite === "node:sqlite"
        && platform.runtime?.semantic_runtime === "@huggingface/transformers@4.2.0"
        && platform.runtime?.sandbox_contract === "plugin-sdk:restricted-node@1"
        && platform.watcher === targetConfig?.watcher_package,
      archive: archive.digest,
    };
  }
  const passed = Object.values(checks).every((check) => check.forbidden === 0 && check.symlinks === 0 && check.archive_errors === 0 && check.checksum_failures === 0 && check.required && check.conformance && typeof check.archive === "string");
  return { status: passed ? "passed" : "failed", conformance, targets: checks, archives: result.archives };
}

export async function writeReleaseReport(report, path) {
  const body = { ...report };
  delete body.report_digest;
  const reportWithDigest = { ...body, report_digest: sha256(JSON.stringify(body)) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(reportWithDigest, null, 2)}\n`);
  return reportWithDigest;
}

export async function runReleaseSuite({ rootDir = ROOT, outputDir = join(rootDir, "release/artifacts"), reportPath = join(rootDir, "release/reports/phase-14-release.json"), skipInstall = false } = {}) {
  const started = new Date().toISOString();
  const gates = {};
  if (!skipInstall) gates.install = await runCommand(["install", "--frozen-lockfile"], rootDir);
  for (const gate of RELEASE_GATES) {
    try {
      if (gate === "benchmark") gates[gate] = await runBenchmark(rootDir);
      else if (gate === "package_inspection") gates[gate] = await packageInspection(rootDir, outputDir);
      else gates[gate] = await runCommand(commands[gate], rootDir);
    } catch (error) {
      gates[gate] = { status: "failed", output: String(error instanceof Error ? error.stack ?? error.message : error) };
    }
  }
  const status = Object.values(gates).every((gate) => gate.status === "passed") ? "passed" : "failed";
  const report = {
    release_schema_version: 1,
    status,
    started_at: started,
    completed_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    semantic_model: { model_id: "Xenova/all-MiniLM-L6-v2", acquisition: "configure_time_download", bundled_assets: false },
    gates,
    release_metadata: buildReleaseMetadata({ gitCommit: await currentGitCommit(rootDir), lockfileDigest: sha256(await readFile(join(rootDir, "pnpm-lock.yaml"))) }),
  };
  const finalReport = await writeReleaseReport(report, reportPath);
  if (status !== "passed") {
    const failing = Object.entries(gates).filter(([, gate]) => gate.status !== "passed").map(([name]) => name).join(", ");
    throw new Error(`Release acceptance failed at: ${failing}`);
  }
  return finalReport;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = await runReleaseSuite({ rootDir: ROOT, skipInstall: process.env.URDIRA_SKIP_INSTALL === "1" });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
