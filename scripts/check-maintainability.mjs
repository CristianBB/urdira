import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ESLint } from "eslint";

const sourceRoots = ["packages", "apps", "crates", "scripts", "tests"];
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".rs"]);
const excludedSegments = new Set(["node_modules", "dist", "target", "coverage"]);
const generatedFiles = new Set([
  "packages/contracts/src/model-contract-source.ts",
  "packages/contracts/src/model-field-authority.ts",
  "packages/contracts/src/generated-model-contracts.ts",
  "packages/contracts/src/generated-schemas.ts",
]);
const measuredRules = {
  complexity: ["warn", 15],
  "max-depth": ["warn", 4],
  "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
};

function isExcluded(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  return generatedFiles.has(normalized) || normalized.includes("/fixtures/") || normalized.includes("/fixture/") || normalized.split("/").some((segment) => excludedSegments.has(segment));
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedSegments.has(entry.name)) await walk(path, files);
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (sourceExtensions.has(extension)) files.push(path);
  }
}

export async function collectSourceFiles(repositoryRoot) {
  const files = [];
  for (const root of sourceRoots) {
    const directory = join(repositoryRoot, root);
    if (existsSync(directory)) await walk(directory, files);
  }
  return files.filter((path) => !isExcluded(relative(repositoryRoot, path))).sort();
}

export async function loadMaintainabilityBaseline(repositoryRoot) {
  return JSON.parse(await readFile(join(repositoryRoot, "architecture/maintainability-baseline.json"), "utf8"));
}

export function summarizeLintResults(results, repositoryRoot) {
  const counts = Object.fromEntries(Object.keys(measuredRules).map((rule) => [rule, 0]));
  const byFile = {};
  for (const result of results) {
    const file = relative(repositoryRoot, result.filePath).split(sep).join("/");
    for (const message of result.messages) {
      if (!(message.ruleId in counts)) continue;
      counts[message.ruleId] += 1;
      byFile[file] ??= {};
      byFile[file][message.ruleId] = (byFile[file][message.ruleId] ?? 0) + 1;
    }
  }
  return { counts, byFile };
}

export function checkMaintainability(summary, baseline) {
  const errors = [];
  for (const [rule, count] of Object.entries(summary.counts)) {
    const allowed = baseline.rules?.[rule] ?? 0;
    if (count > allowed) errors.push(`${rule}: ${count} findings exceed baseline ${allowed}`);
  }
  if (Object.keys(baseline.files ?? {}).length > 0) {
    for (const file of Object.keys(baseline.files)) {
      if (!(file in summary.byFile)) errors.push(`Baseline entry is stale or resolved: ${file}`);
    }
    for (const [file, rules] of Object.entries(summary.byFile)) {
      for (const [rule, count] of Object.entries(rules)) {
        const allowed = baseline.files?.[file]?.[rule] ?? 0;
        if (count > allowed) errors.push(`${file} ${rule}: ${count} findings exceed baseline ${allowed}`);
      }
    }
  }
  return errors;
}

export async function runMaintainabilityCheck(repositoryRoot) {
  const files = await collectSourceFiles(repositoryRoot);
  const eslint = new ESLint({
    overrideConfigFile: join(repositoryRoot, "eslint.config.mjs"),
    overrideConfig: [{ files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"], rules: measuredRules }],
  });
  const results = await eslint.lintFiles(files.filter((file) => !file.endsWith(".rs")));
  const summary = summarizeLintResults(results, repositoryRoot);
  const baseline = await loadMaintainabilityBaseline(repositoryRoot);
  return { files, summary, baseline, errors: checkMaintainability(summary, baseline) };
}

if (process.argv[1]?.endsWith("check-maintainability.mjs")) {
  const result = await runMaintainabilityCheck(join(import.meta.dirname, ".."));
  console.log(JSON.stringify({ files: result.files.length, counts: result.summary.counts, baseline: result.baseline.rules }, null, 2));
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`maintainability: ${error}`);
    process.exitCode = 1;
  }
}
