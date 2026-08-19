import { readFileSync, writeFileSync } from "node:fs";

const root = new globalThis.URL("../", import.meta.url);
const models = readFileSync(new globalThis.URL("src/models.ts", root), "utf8");
const schemaIr = readFileSync(new globalThis.URL("src/schema-ir.ts", root), "utf8");
const modelNamesSource = readFileSync(new globalThis.URL("src/model-names.ts", root), "utf8");

const modelNames = [...modelNamesSource.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
const fieldsByModel = new Map();
const extendsByModel = new Map();
for (const match of `${models}\n${schemaIr}`.matchAll(/export interface (\w+)(?:<[^>]+>)?(?:\s+extends\s+([^{]+))?\s*\{([^}]*)\}/gs)) {
  const baseNames = (match[2] ?? "").split(",").map((base) => base.trim().replace(/<[^>]+>/g, "")).filter(Boolean);
  const fields = [...match[3].matchAll(/(\w+)(\?)?:\s*([^;]+);/g)].map((field) => ({
    name: field[1],
    presence: field[2] ? "optional" : "required",
    logical_type: logicalType(field[3]),
  }));
  if (fields.length > 0) fieldsByModel.set(match[1], fields);
  if (baseNames.length > 0) extendsByModel.set(match[1], baseNames);
}

const ownFieldsByModel = new Map(fieldsByModel);
const expandInheritedFields = (name, active = new Set()) => {
  if (active.has(name)) throw new Error(`Cyclic model inheritance at ${name}`);
  const own = ownFieldsByModel.get(name) ?? [];
  const inherited = [];
  for (const base of extendsByModel.get(name) ?? []) {
    const baseFields = expandInheritedFields(base, new Set([...active, name]));
    inherited.push(...baseFields);
  }
  const merged = [...inherited, ...own];
  const seen = new Set();
  return merged.filter((field) => !seen.has(field.name) && (seen.add(field.name), true));
};
for (const name of ownFieldsByModel.keys()) fieldsByModel.set(name, expandInheritedFields(name));

// These are unions whose authoritative declarations are intentionally aliases.
// The field sets are the closed aggregate of their documented variants; runtime
// validation applies the discriminator-specific required fields separately.
const aliasFields = {
  CanonicalTypeExpression: [{ name: "type_kind", presence: "required" }],
  DigestPayloadBinding: ["binding_kind", "source_path", "field_bindings"].map((name) => ({ name, presence: name === "binding_kind" ? "required" : "optional" })),
  VisibleSourceStateSet: [{ name: "entries", presence: "required" }],
  VisibleSourceStateEntry: ["state_kind", "workspace_id", "artifact_id", "normalized_uri", "artifact_kind", "artifact_version_id", "content_hash", "byte_length", "encoding", "language_hint", "analysis_metadata_digest", "valid_from_generation", "artifact_tombstone_id", "absence_kind", "absence_reason_code", "last_artifact_version_id"].map((name) => ({ name, presence: ["language_hint", "artifact_version_id", "content_hash", "byte_length", "encoding", "analysis_metadata_digest", "valid_from_generation", "artifact_tombstone_id", "absence_kind", "absence_reason_code", "last_artifact_version_id"].includes(name) ? "optional" : "required" })),
  CandidateIssueScope: [{ name: "scope_type", presence: "required" }],
  DiagnosticScope: ["scope_type", "record_id", "artifact_id", "artifact_version_id", "capability"].map((name) => ({ name, presence: name === "scope_type" || name === "record_id" || name === "artifact_id" || name === "capability" ? "required" : "optional" })),
  RelationTarget: ["target_type", "entity_id", "record_id"].map((name) => ({ name, presence: name === "target_type" ? "required" : "optional" })),
  EvidenceSubject: ["subject_type", "record_id", "relation_record_id", "argument_id"].map((name) => ({ name, presence: name === "subject_type" ? "required" : "optional" })),
  QueryScope: ["scope_type", "workspace_id", "participants"].map((name) => ({ name, presence: name === "scope_type" ? "required" : "optional" })),
  QueryExpression: [{ name: "expression_type", presence: "required" }],
  SubjectSelector: ["subject_type", "entity_id", "entity_record_id", "record_id", "artifact_id", "artifact_version_id", "path", "name", "context_artifact", "context_byte_offset", "kind_selector", "stage_id", "output"].map((name) => ({ name, presence: name === "subject_type" ? "required" : "optional" })),
  ChangeDescriptor: ["change_type", "new_name", "new_artifact_path", "new_container", "new_signature", "compatibility_assumptions", "new_type", "new_visibility", "contract_change_code", "new_contract", "behavior_change_code", "description", "affected_effects"].map((name) => ({ name, presence: name === "change_type" ? "required" : "optional" })),
  ResultSubject: ["result_type", "workspace_snapshot_binding_id", "entity_id", "entity_record_id", "record_id", "artifact_id", "artifact_version_id"].map((name) => ({ name, presence: ["result_type", "workspace_snapshot_binding_id"].includes(name) ? "required" : "optional" })),
  PrimaryResultView: ["result_type", "subject", "record", "artifact", "artifact_version"].map((name) => ({ name, presence: ["result_type", "subject"].includes(name) ? "required" : "optional" })),
  CursorTokenClaims: [{ name: "workspace_scope_digest", presence: "required" }, { name: "workspace_status_scope_digest", presence: "required" }],
  IndexStatusRequest: ["request_type", "api_version", "workspace_ids", "include_capabilities", "include_plugins", "include_activation_issues", "include_candidate_issues", "cursor", "response_budget"].map((name) => ({ name, presence: ["request_type", "api_version", "workspace_ids", "response_budget"].includes(name) ? "required" : "optional" })),
};

const aliasLogicalTypes = {
  CanonicalTypeExpression: { type_kind: "Text" },
  DigestPayloadBinding: { binding_kind: "Text", source_path: "Text", field_bindings: "Sequence<DigestPayloadFieldBinding>" },
  VisibleSourceStateSet: { entries: "Sequence<VisibleSourceStateEntry>" },
  VisibleSourceStateEntry: { state_kind: "present | absent", workspace_id: "Identifier", artifact_id: "Identifier", normalized_uri: "Text", artifact_kind: "Text", artifact_version_id: "Identifier", content_hash: "Digest", byte_length: "Count", encoding: "Text", language_hint: "Text", analysis_metadata_digest: "Digest", valid_from_generation: "Count", artifact_tombstone_id: "Identifier", absence_kind: "deleted | excluded", absence_reason_code: "Text", last_artifact_version_id: "Identifier" },
  CandidateIssueScope: { scope_type: "Text" },
  DiagnosticScope: { scope_type: "Text", record_id: "Identifier", artifact_id: "Identifier", artifact_version_id: "Identifier", capability: "Text" },
  RelationTarget: { target_type: "Text", entity_id: "Identifier", record_id: "Identifier" },
  EvidenceSubject: { subject_type: "Text", record_id: "Identifier", relation_record_id: "Identifier", argument_id: "Identifier" },
  QueryScope: { scope_type: "single_workspace | comparison", workspace_id: "Identifier", participants: "Sequence<QueryParticipant>" },
  QueryExpression: { expression_type: "operation | pipeline | recipe" },
  SubjectSelector: { subject_type: "entity | record | artifact | symbol | stage_output", entity_id: "Identifier", entity_record_id: "Identifier", record_id: "Identifier", artifact_id: "Identifier", artifact_version_id: "Identifier", path: "Text", name: "Text", context_artifact: "Identifier", context_byte_offset: "Count", kind_selector: "KindSelector", stage_id: "Text", output: "Text" },
  ChangeDescriptor: { change_type: "delete | rename | move | signature | type | visibility | contract | behavior", new_name: "Text", new_artifact_path: "Text", new_container: "Text", new_signature: "Text", compatibility_assumptions: "Sequence<Text>", new_type: "Text", new_visibility: "Text", contract_change_code: "Text", new_contract: "Text", behavior_change_code: "Text", description: "Text", affected_effects: "Sequence<Text>" },
  ResultSubject: { result_type: "entity | record | artifact", workspace_snapshot_binding_id: "Identifier", entity_id: "Identifier", entity_record_id: "Identifier", record_id: "Identifier", artifact_id: "Identifier", artifact_version_id: "Identifier" },
  PrimaryResultView: { result_type: "entity | record | artifact", subject: "ResultSubject", record: "RecordEnvelope", artifact: "SourceArtifact", artifact_version: "ArtifactVersion" },
  CursorTokenClaims: { workspace_scope_digest: "Digest", workspace_status_scope_digest: "Digest" },
  IndexStatusRequest: { request_type: "initial | continuation", api_version: "PositiveInteger", workspace_ids: "Sequence<Identifier>", include_capabilities: "Boolean", include_plugins: "Boolean", include_activation_issues: "Boolean", include_candidate_issues: "Boolean", cursor: "Text", response_budget: "ResponseBudget" },
};
for (const [name, fields] of Object.entries(aliasFields)) fieldsByModel.set(name, fields.map((field) => ({ ...field, logical_type: aliasLogicalTypes[name]?.[field.name] ?? (() => { throw new Error(`Missing exact logical type for ${name}.${field.name}`); })() })));
const missing = modelNames.filter((name) => !fieldsByModel.has(name));
if (missing.length > 0) throw new Error(`Missing authoritative model declaration fields for: ${missing.join(", ")}`);

const ordered = Object.fromEntries(modelNames.map((name) => [name, fieldsByModel.get(name)]));
const output = `/** Generated from packages/contracts/src/models.ts, schema-ir.ts, and their closed union declarations. */\nexport interface ModelSourceField { readonly name: string; readonly presence: "required" | "optional"; readonly logical_type: string; }\nexport const authoritativeModelSourceFields = ${JSON.stringify(ordered, null, 2)} as const;\n`;
writeFileSync(new globalThis.URL("src/model-contract-source.ts", root), output);

function logicalType(type) {
  const normalized = type.replace(/\s+/g, " ").trim();
  if (normalized === "string") return "Text";
  if (normalized === "boolean") return "Boolean";
  if (normalized === "number") return "Count";
  if (normalized === "Payload") return "JsonValue";
  const sequence = normalized.match(/^ReadonlyArray<(.+)>$/);
  if (sequence) return `Sequence<${logicalType(sequence[1])}>`;
  const literals = normalized.split("|").map((value) => value.trim()).filter((value) => value.startsWith("\"") && value.endsWith("\""));
  if (literals.length > 0 && literals.length === normalized.split("|").length) return literals.map((value) => value.slice(1, -1)).join(" | ");
  return normalized;
}
