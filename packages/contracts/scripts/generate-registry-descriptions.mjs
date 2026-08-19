import { writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = join(repositoryRoot, "docs");

const descriptions = new Map();
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path);
    else if (path.endsWith(".md")) {
      let currentCodes = [];
      let paragraph = [];
      const flush = () => {
        const text = paragraph.join(" ").trim();
        if (text && currentCodes.length > 0) for (const code of currentCodes) if (!descriptions.has(code)) descriptions.set(code, text);
        paragraph = [];
      };
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const heading = [...line.matchAll(/`(core:[a-z0-9_]+)(?:@\d+)?`/g)].map((match) => match[1]);
        if (/^#{2,6}\s+/.test(line)) { flush(); currentCodes = heading; continue; }
        const table = line.match(/^\|\s*`?(core:[a-z0-9_]+)`?\s*\|\s*([^|]+?)\s*\|/);
        if (table) { descriptions.set(table[1], table[2].trim()); continue; }
        const definitionDescription = line.match(/^\|\s*Description\s*\|\s*([^|]+?)\s*\|/);
        if (definitionDescription && currentCodes.length > 0) { for (const code of currentCodes) descriptions.set(code, definitionDescription[1].trim()); continue; }
        const explicit = line.match(/^Description:\s*(.+)$/);
        if (explicit) { flush(); for (const code of currentCodes) descriptions.set(code, explicit[1].trim()); continue; }
        if (currentCodes.length > 0 && line.trim() && !line.trim().startsWith("|") && !line.trim().startsWith("-") && !line.trim().startsWith("Outputs") && !line.trim().startsWith("Stages") && !line.trim().startsWith("Arguments") && !line.trim().startsWith("Ranking") && !line.trim().startsWith("Guards") && !line.trim().startsWith("Streams")) paragraph.push(line.trim());
        if (!line.trim()) flush();
      }
      flush();
    }
  }
};
visit(docsRoot);
const diagnosticSource = readFileSync(join(docsRoot, "diagnostics/core-diagnostic-codes.md"), "utf8");
for (const section of diagnosticSource.split(/^##\s+/m).slice(1)) {
  const code = section.match(/^`(core:[a-z0-9_]+)`/)?.[1];
  const description = section.match(/^\|\s*Description\s*\|\s*([^|]+?)\s*\|/m)?.[1]?.trim();
  if (code && description) descriptions.set(code, description);
}
const ordered = Object.fromEntries([...descriptions.entries()].sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(new globalThis.URL("../src/registry-descriptions.ts", import.meta.url), `/** Mechanically transcribed registry descriptions from the authoritative protocol and indexing documents. */\nexport const authoritativeRegistryDescriptions = ${JSON.stringify(ordered, null, 2)} as const;\n`);
