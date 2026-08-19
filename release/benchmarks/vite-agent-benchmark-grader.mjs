#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const worktree = resolve(value("--worktree", "."));
const task = value("--task", "server-request");
if (!["server-request", "lifecycle-map"].includes(task)) throw new Error("--task must be server-request|lifecycle-map");
const runTests = !argv.includes("--skip-tests");
const packageRoot = join(worktree, "packages", "vite");
const changed = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRT"], { cwd: worktree, encoding: "utf8" });
const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" });
const changedFiles = [...new Set([
  ...(changed.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
  ...(status.stdout ?? "").split("\n").map((line) => line.slice(3).trim()).filter(Boolean),
])].filter((file) => file !== "node_modules" && !file.startsWith("node_modules/") && file !== "packages/vite/node_modules" && !file.startsWith("packages/vite/node_modules/") && file !== "packages/vite/dist" && !file.startsWith("packages/vite/dist/") && !file.startsWith(".codebase-memory/"));
const read = (path) => { try { return readFileSync(path.startsWith(worktree) ? path : join(worktree, path), "utf8"); } catch { return ""; } };
const sourceFiles = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) sourceFiles.push(path);
  }
};
walk(join(packageRoot, "src"));
walk(join(packageRoot, "__tests__"));
const source = sourceFiles.map((path) => read(path)).join("\n");
const diffClean = spawnSync("git", ["diff", "--check"], { cwd: worktree, encoding: "utf8" });
const reportPath = "docs/reports/2026-08-19-vite-plugin-lifecycle-map.md";
const report = read(reportPath);
const pluginContract = /serverRequest/.test(read("packages/vite/src/node/plugin.ts"));
const lifecycle = /serverRequest/.test(source) && /(finish|close)/.test(source);
const tests = changedFiles.some((file) => /(test|spec)\.(ts|tsx|js|mjs)$/.test(file)) && /(finish|close)/.test(changedFiles.map(read).join("\n"));
const docs = changedFiles.some((file) => /(^|\/)(docs|README\.md)(\/|$)/.test(file));
const lifecycleMapEvidence = {
  report_file: changedFiles.includes(reportPath) && report.length > 0,
  evidence_table: /evidence|file.{0,12}line|line.{0,12}reference/i.test(report),
  contract_and_dispatch: /(plugin|hook).{0,80}(contract|dispatch)|configResolved|configureServer|resolveId/i.test(report),
  caller_matrix: /(caller|consumer|call graph|matrix)/i.test(report),
  tests_and_docs: /(test|spec).{0,80}(doc|readme)|docs?.{0,80}(test|spec)/i.test(report),
  migration_plan: /(implementation|migration).{0,80}(plan|stage)|risks?|compatibility/i.test(report),
  line_references: (report.match(/:\d{1,5}/g) ?? []).length >= 8,
};
const evidence = task === "lifecycle-map"
  ? { changed_files: changedFiles, ...lifecycleMapEvidence, diff_clean: diffClean.status === 0 }
  : { changed_files: changedFiles, plugin_contract: pluginContract, lifecycle_finish_close: lifecycle, focused_tests: tests, documentation: docs, diff_clean: diffClean.status === 0 };
let testVerification = { attempted: false, passed: false, reason: "not-run" };
if (task === "server-request" && runTests && existsSync(join(worktree, "node_modules")) && existsSync(packageRoot)) {
  const focusedTestFiles = changedFiles.filter((file) => /\.(spec|test)\.(ts|tsx|js|mjs)$/.test(file) && read(file).includes("serverRequest"));
  const testFiles = focusedTestFiles.length > 0 ? focusedTestFiles : ["packages/vite/src/node/__tests__/dev.spec.ts", "packages/vite/src/node/__tests__/plugins/hooks.spec.ts"];
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...testFiles, "-t", "serverRequest|successful response|middleware mode|server restart|aborted response"], { cwd: worktree, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  testVerification = { attempted: true, passed: result.status === 0 && /Tests\s+\d+ passed/.test(output), exit_code: result.status, output_tail: output.slice(-4000) };
} else if (task === "server-request" && runTests) {
  testVerification = { attempted: false, passed: false, reason: "dependencies-not-installed" };
}
const requiredEvidence = task === "lifecycle-map"
  ? Object.entries(lifecycleMapEvidence).map(([, value]) => value)
  : [evidence.plugin_contract, evidence.lifecycle_finish_close, evidence.focused_tests, evidence.documentation, evidence.diff_clean];
const completedSuccessfully = requiredEvidence.every((value) => value === true) && (task === "lifecycle-map" || !runTests || testVerification.passed);
console.log(JSON.stringify({ completed_successfully: completedSuccessfully, evidence, test_verification: testVerification }, null, 2));
if (!completedSuccessfully) process.exitCode = 1;
