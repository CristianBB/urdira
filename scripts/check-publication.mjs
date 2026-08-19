import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenRoots = [".claude/", ".codex/", ".cursor/", ".entire/", ".opencode/", ".superpowers/", "docs/implementation/"];
const publicTextExtensions = new Set([".md", ".json", ".mjs", ".js", ".ts", ".tsx", ".yml", ".yaml", ".toml", ".txt"]);

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer" });
const files = stdout.toString("utf8").split("\0").filter(Boolean).sort();
const errors = [];

for (const path of files) {
  if (!(await exists(resolve(root, path)))) continue;
  if (forbiddenRoots.some((prefix) => path.startsWith(prefix))) errors.push(`${path}: internal workflow material must not be published`);
  if (!publicTextExtensions.has(extname(path)) && !["LICENSE", ".gitignore", ".nvmrc"].includes(path)) continue;
  const text = await readFile(resolve(root, path), "utf8");
  if (/\/Users\/(?:Cristian|cristian)\//u.test(text)) errors.push(`${path}: contains a local macOS user path`);
  if ((path.startsWith("docs/") || path.startsWith("release/benchmarks/")) && /file:\/\//u.test(text)) errors.push(`${path}: contains a local file URI`);
  if ((path.startsWith("docs/") || path.startsWith("release/benchmarks/")) && /\/private\/tmp\//u.test(text)) errors.push(`${path}: contains a private temporary path`);
  if (path !== "scripts/check-publication.mjs" && /\burdira-engine\b/u.test(text)) errors.push(`${path}: contains the superseded package name urdira-engine`);

  if (path.endsWith(".md")) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const raw = match[1].trim().replace(/^<|>$/gu, "");
      if (raw.length === 0 || raw.startsWith("#") || /^(?:https?:|mailto:)/u.test(raw)) continue;
      const target = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
      if (target.startsWith("/")) { errors.push(`${path}: contains an absolute local Markdown link ${raw}`); continue; }
      if (!(await exists(resolve(root, dirname(path), target)))) errors.push(`${path}: broken relative Markdown link ${raw}`);
    }
  }
}

for (const required of ["README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs/release.md"]) {
  if (!(await exists(resolve(root, required)))) errors.push(`${required}: required public release document is missing`);
}

if (errors.length > 0) {
  process.stderr.write(`Publication hygiene failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Publication hygiene passed (${files.length} files checked).\n`);
}
