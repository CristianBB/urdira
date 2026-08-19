import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = join(repositoryRoot, "docs");
const normativeAuthority = JSON.parse(readFileSync(join(repositoryRoot, "tests/fixtures/contracts/v7-normative-authority.json"), "utf8"));
const udmText = readFileSync(join(docsRoot, "decisions/01-universal-data-model.md"), "utf8");
const inventoryStart = udmText.indexOf("## Model inventory and traceability");
const inventoryEnd = udmText.indexOf("\n## ", inventoryStart + 3);
const inventoryText = udmText.slice(inventoryStart, inventoryEnd < 0 ? undefined : inventoryEnd);
const modelNames = [...inventoryText.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]+)`\s*\|/gm)].map((match) => match[1]);
if (modelNames.length !== 400) throw new Error(`Normative model inventory must contain 400 models, found ${modelNames.length}`);

const models = modelNames.map((name) => {
  return {
    name,
    owner_decision: "decisions/01-universal-data-model.md",
    fields: normativeAuthority.record_variants[name] ? normativeAuthority.record_envelope_fields.map((field) => ({ name: field, presence: "required", logical_type: "normative", description: "Normative inherited envelope field.", source: "decisions/01-universal-data-model.md" })) : [],
  };
});

const readDocs = (relativePath) => readFileSync(join(docsRoot, relativePath), "utf8");
const recipeText = readDocs("protocol/core-intent-recipes.md");
const operationErrorText = readDocs("protocol/core-operation-error-codes.md");
const diagnosticText = readDocs("diagnostics/core-diagnostic-codes.md");
const candidateText = readDocs("indexing/core-candidate-issue-codes.md");
const canonicalSchemaText = readDocs("serialization/core-canonical-schemas.md");
const publicQueryText = readDocs("protocol/public-query-contract.md");
const ids = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);
const operations = ids(publicQueryText, /^###\s+(.+)$/gm).flatMap((heading) => [...heading.matchAll(/`(core:[a-z0-9_]+)`/g)].map((match) => ({ operation_id: match[1], operation_version: 1 })));
const recipes = ids(recipeText, /^##\s+`(core:[a-z0-9_]+)@([0-9]+)`/gm).map((recipe_id) => ({ recipe_id, recipe_version: 1 }));
const payloads = {
  operation_errors: [...new Set([...ids(operationErrorText, /^\|\s+`(core:[a-z0-9_]+)`/gm), ...ids(operationErrorText, /^##\s+`(core:[a-z0-9_]+)`/gm)])],
  diagnostics: ids(diagnosticText, /^##\s+`(core:[a-z0-9_]+)`/gm),
  candidate_issues: ids(candidateText, /^\|\s+`(core:[a-z0-9_]+)`/gm),
};
const schemas = [...new Map([...canonicalSchemaText.matchAll(/core:([A-Za-z][A-Za-z0-9_]*)@(\d+)/g)].filter((match) => !match[1].endsWith("_order")).map((match) => [`core:${match[1]}@${match[2]}`, { schema_id: `core:${match[1]}`, schema_version: Number(match[2]) }])).values()];
const fixture = {
  generated_from: [
    "docs/decisions/01-universal-data-model.md",
    "docs/serialization/core-canonical-schemas.md",
    "docs/protocol/public-query-contract.md",
    "docs/protocol/core-intent-recipes.md",
    "docs/protocol/core-operation-error-codes.md",
    "docs/diagnostics/core-diagnostic-codes.md",
    "docs/indexing/core-candidate-issue-codes.md",
  ],
  authority_kind: "normative-source-table",
  models,
  operations,
  recipes,
  payloads,
  schemas,
};
const output = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/contracts/v5-contract-conformance.json");
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
