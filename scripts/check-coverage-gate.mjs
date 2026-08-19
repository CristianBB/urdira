import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gate = JSON.parse(await readFile(join(root, "architecture", "coverage-gate.json"), "utf8"));
const errors = [];
if (gate.version !== 1) errors.push("Coverage gate version must be 1");
if (!Number.isFinite(gate.minimum_repository_line_percent) || gate.minimum_repository_line_percent < 90 || gate.minimum_repository_line_percent > 100) errors.push("Coverage gate repository minimum must be between 90 and 100 percent");
if (gate.critical_branch_percent !== 100) errors.push("Coverage gate critical branch minimum must be 100 percent");
if (!Array.isArray(gate.required_modules) || gate.required_modules.length === 0) errors.push("Coverage gate must declare required modules");

for (const required of Array.isArray(gate.required_modules) ? gate.required_modules : []) {
  try { await stat(join(root, required.module)); } catch { errors.push(`Coverage gate module is missing: ${required.module}`); }
  const source = (await Promise.all((Array.isArray(required.tests) ? required.tests : []).map(async (test) => { try { return await readFile(join(root, test), "utf8"); } catch { errors.push(`Coverage gate test is missing: ${test}`); return ""; } }))).join("\n");
  for (const behavior of Array.isArray(required.required_behaviors) ? required.required_behaviors : []) if (!source.includes(behavior)) errors.push(`Coverage gate behavior ${behavior} is not covered by tests for ${required.module}`);
}

let raw;
try { raw = JSON.parse(await readFile(join(root, gate.coverage_report), "utf8")); } catch { errors.push(`Measured coverage report is missing: ${gate.coverage_report}`); raw = {}; }
const rawFiles = Object.entries(raw).filter(([filename]) => filename.endsWith(".ts") || filename.endsWith(".mjs"));
const repositoryScope = Array.isArray(gate.coverage_scope) && gate.coverage_scope.includes("repository");
const files = repositoryScope
  ? rawFiles.map(([filename, data]) => ({ relative: filename.startsWith(`${root}/`) ? filename.slice(root.length + 1) : filename, data }))
  : (Array.isArray(gate.coverage_scope) ? gate.coverage_scope : []).map((relative) => ({ relative, data: raw[join(root, relative)] ?? raw[resolve(root, relative)] }));
for (const file of files) if (!file.data) errors.push(`Measured coverage is missing for ${file.relative}`);
const measure = (selected, branchFilter = () => true) => {
  let coveredLines = 0; let totalLines = 0; let coveredBranches = 0; let totalBranches = 0;
  for (const { data } of selected) {
    if (!data) continue;
    const lines = new Map();
    for (const [id, location] of Object.entries(data.statementMap ?? {})) {
      const line = location.start.line;
      lines.set(line, (lines.get(line) ?? false) || (data.s?.[id] ?? 0) > 0);
    }
    for (const covered of lines.values()) { totalLines += 1; if (covered) coveredLines += 1; }
    for (const [id, counts] of Object.entries(data.b ?? {})) {
      if (!branchFilter(data.branchMap?.[id])) continue;
      for (const count of counts) { totalBranches += 1; if (count > 0) coveredBranches += 1; }
    }
  }
  return { line: totalLines === 0 ? 100 : (coveredLines / totalLines) * 100, branch: totalBranches === 0 ? 100 : (coveredBranches / totalBranches) * 100, coveredLines, totalLines, coveredBranches, totalBranches };
};
const measured = measure(files);
if (measured.line + 1e-9 < gate.minimum_repository_line_percent) errors.push(`Measured repository-scope line coverage ${measured.line.toFixed(2)}% is below ${gate.minimum_repository_line_percent}%`);
for (const module of Array.isArray(gate.critical_branch_modules) ? gate.critical_branch_modules : []) {
  const moduleMeasure = measure(files.filter((file) => file.relative === module));
  if (moduleMeasure.branch + 1e-9 < gate.critical_branch_percent) errors.push(`Measured critical branch coverage ${moduleMeasure.branch.toFixed(2)}% for ${module} is below ${gate.critical_branch_percent}%`);
}
for (const region of Array.isArray(gate.critical_branch_regions) ? gate.critical_branch_regions : []) {
  const file = files.find((candidate) => candidate.relative === region.module);
  const regionMeasure = measure(file ? [file] : [], (branch) => branch && branch.line >= region.start_line && branch.line <= region.end_line);
  if (regionMeasure.branch + 1e-9 < gate.critical_branch_percent) errors.push(`Measured critical branch coverage ${regionMeasure.branch.toFixed(2)}% for ${region.module}:${region.start_line}-${region.end_line} is below ${gate.critical_branch_percent}%`);
}

if (errors.length > 0) { for (const error of errors) console.error(error); process.exitCode = 1; }
else {
  const critical = measure(files.filter((file) => (Array.isArray(gate.critical_branch_modules) ? gate.critical_branch_modules : []).includes(file.relative)));
  const regions = (Array.isArray(gate.critical_branch_regions) ? gate.critical_branch_regions : []).map((region) => {
    const file = files.find((candidate) => candidate.relative === region.module);
    return measure(file ? [file] : [], (branch) => branch && branch.line >= region.start_line && branch.line <= region.end_line);
  });
  const regionSummary = regions.length === 0 ? "" : `, semantic regions ${regions.map((region) => `${region.branch.toFixed(2)}%`).join(", ")}`;
  console.log(`Coverage gate passed: measured repository lines ${measured.line.toFixed(2)}% (${measured.coveredLines}/${measured.totalLines}), critical branches ${critical.branch.toFixed(2)}% (${critical.coveredBranches}/${critical.totalBranches})${regionSummary}.`);
}
