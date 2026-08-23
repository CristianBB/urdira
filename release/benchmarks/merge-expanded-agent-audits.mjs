#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

const historicalPath = value("--historical");
const urdiraPath = value("--urdira");
const outputPath = value("--output");
if (!historicalPath || !urdiraPath || !outputPath) {
  throw new Error("Usage: merge-expanded-agent-audits.mjs --historical <audit.json> --urdira <audit.json> --output <audit.json>");
}

const historical = JSON.parse(readFileSync(historicalPath, "utf8"));
const urdira = JSON.parse(readFileSync(urdiraPath, "utf8"));
const runs = [
  ...historical.runs.filter((run) => run.arm !== "urdira-typescript"),
  ...urdira.runs,
];
const normalizedDiffClean = (worktree) => {
  if (!worktree) return false;
  const diff = spawnSync("git", ["diff", "--unified=0"], { cwd: worktree, encoding: "utf8" });
  if (diff.status !== 0) return false;
  return (diff.stdout ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .every((line) => !/[ \t]+$/.test(line.replace(/\r$/, "")));
};
const evidencePass = (manifest) => {
  const evidence = manifest?.correctness?.evidence;
  return evidence?.changed_paths === true
    && evidence.focused_test_changed === true
    && (evidence.diff_clean === true || normalizedDiffClean(manifest.worktree))
    && Object.values(evidence.required_patterns ?? {}).every(Boolean);
};
const successfulRuns = runs.filter((run) => run.manifest?.completed_successfully === true || (run.manifest?.exit_code === 0 && evidencePass(run.manifest))).length;
const expectedRuns = Number(historical.expected_runs ?? historical.repositories.reduce((count, repository) => count + repository.tasks.length, 0) * 4);
const merged = {
  ...historical,
  campaign_id: `${historical.campaign_id}-urdira-rerun`,
  generated_at: new Date().toISOString(),
  arms: ["baseline", "urdira-typescript", "codebase-memory", "codegraph"],
  reused_arms: ["baseline", "codebase-memory", "codegraph"],
  samples_per_cell: 1,
  expected_runs: expectedRuns,
  successful_runs: successfulRuns,
  failed_runs: runs.length - successfulRuns,
  output_dir: urdira.output_dir,
  runs,
  campaign_status: runs.length === expectedRuns ? "complete" : "partial",
  rerun_status: urdira.runs.length === historical.repositories.reduce((count, repository) => count + repository.tasks.length, 0) ? "complete" : "partial",
  rerun_observed_runs: urdira.runs.length,
  rerun_expected_runs: historical.repositories.reduce((count, repository) => count + repository.tasks.length, 0),
  rerun_stop_reason: urdira.runs.length < historical.repositories.reduce((count, repository) => count + repository.tasks.length, 0)
    ? "Stopped after repeated Urdira JavaScript heap out-of-memory failures during structural publication; all observed failures and host logs are retained."
    : null,
  campaign_gate: { passed: runs.length === expectedRuns && successfulRuns === expectedRuns, expected_runs: expectedRuns, observed_runs: runs.length },
};
writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, observed_runs: runs.length, successful_runs: successfulRuns, failed_runs: runs.length - successfulRuns }));
