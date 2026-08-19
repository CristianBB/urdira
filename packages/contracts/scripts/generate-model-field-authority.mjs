import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const contractRoot = new globalThis.URL("../", import.meta.url);
const repositoryRoot = new globalThis.URL("../../", contractRoot);
const modelSource = readFileSync(new globalThis.URL("src/models.ts", contractRoot), "utf8");
const schemaSource = readFileSync(new globalThis.URL("src/schema-ir.ts", contractRoot), "utf8");
const generatedSource = readFileSync(new globalThis.URL("src/generated-model-contracts.ts", contractRoot), "utf8");
const sourceFieldsSource = readFileSync(new globalThis.URL("src/model-contract-source.ts", contractRoot), "utf8");
const modelNamesSource = readFileSync(new globalThis.URL("src/model-names.ts", contractRoot), "utf8");
const udm = readFileSync(new globalThis.URL("docs/decisions/01-universal-data-model.md", repositoryRoot), "utf8");
const canonicalSchemas = readFileSync(new globalThis.URL("docs/serialization/core-canonical-schemas.md", repositoryRoot), "utf8");

const documentationFiles = [];
const visitDocumentation = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visitDocumentation(path);
    else if (path.endsWith(".md")) documentationFiles.push(path);
  }
};
visitDocumentation(new globalThis.URL("docs", repositoryRoot).pathname);
const allDocumentation = documentationFiles.map((path) => readFileSync(path, "utf8")).join("\n");

const modelNames = [...modelNamesSource.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
const interfaces = new Map();
for (const match of `${modelSource}\n${schemaSource}`.matchAll(/export interface (\w+)(?:<[^>]+>)?[^{}]*\{([^}]*)\}/gs)) {
  const fields = new Map();
  for (const field of match[2].matchAll(/(\w+)(\?)?:\s*([^;]+);/g)) fields.set(field[1], { optional: field[2] === undefined, type: field[3].trim() });
  interfaces.set(match[1], fields);
}
for (const match of generatedSource.matchAll(/\{ name: "(\w+)", owner_decision: "[^"]+", fields: \[(.*?)\] \}/gs)) {
  if (interfaces.get(match[1])?.size) continue;
  const fields = new Map();
  for (const field of match[2].matchAll(/name: "(\w+)", presence: "(required|optional)"/g)) fields.set(field[1], { optional: field[2] === "required", type: "Text" });
  interfaces.set(match[1], fields);
}
const additionalStart = generatedSource.indexOf("const additionalModelFields");
const additional = additionalStart >= 0 ? generatedSource.slice(additionalStart).split("};\n\nexport const modelContractRegistry")[0] : "";
const modelSet = (name) => {
  const block = generatedSource.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`))?.[1] ?? "";
  return new Set([...block.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]));
};
const publicModelNames = modelSet("publicModelNames");
const recipeModelNames = modelSet("recipeModelNames");
for (const match of additional.matchAll(/\s{2}(\w+): \[(.*?)\],/gs)) {
  if (interfaces.get(match[1])?.size) continue;
  const fields = new Map();
  for (const field of match[2].matchAll(/modelField\("(\w+)"(?:,\s*"(required|optional)")?/g)) fields.set(field[1], { optional: field[2] === "required", type: "Text" });
  interfaces.set(match[1], fields);
}

const sourceFieldsJson = sourceFieldsSource.match(/export const authoritativeModelSourceFields = (\{[\s\S]*\}) as const;/)?.[1];
if (!sourceFieldsJson) throw new Error("Missing generated authoritative model source fields");
const sourceFields = JSON.parse(sourceFieldsJson);

const descriptions = new Map();
const modelDescriptions = new Map();
const modelOwners = new Map();
for (const line of udm.split("\n")) {
  const inventory = line.match(/^\|\s*`([A-Z][A-Za-z0-9]+)`\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*(.+?)\s*\|$/);
  if (!inventory) continue;
  const owner = inventory[2].match(/\]\(([^)]+)\)/)?.[1];
  const inventoryCells = line.split("|").slice(1, -1).map((cell) => cell.trim()).filter(Boolean);
  modelDescriptions.set(inventory[1], inventoryCells.join(" — "));
  if (owner) modelOwners.set(inventory[1], owner.startsWith("../") ? owner.slice(3) : `decisions/${owner}`);
  else modelOwners.set(inventory[1], "decisions/01-universal-data-model.md");
}
for (const source of [udm, canonicalSchemas, allDocumentation]) {
  for (const line of source.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const reference = cells[0]?.match(/^`?([A-Z][A-Za-z0-9]+)\.([a-z][a-z0-9_]*)`?$/);
    if (reference && cells.length >= 2) descriptions.set(`${reference[1]}.${reference[2]}`, cells.at(-1) ?? cells[1]);
  }
}
for (const line of allDocumentation.split("\n")) {
  const normalizedLine = line.replace(/\s+/g, " ").trim();
  if (!normalizedLine || normalizedLine.startsWith("|") || normalizedLine.endsWith("|")) continue;
  // A line containing a whole model shape is not a field definition. Only
  // retain a sentence when its field reference is the sentence's subject;
  // otherwise the old parser copied an entire model inventory into every
  // field's description.
  for (const reference of line.matchAll(/(?:`)?([A-Z][A-Za-z0-9]+)\.([a-z][a-z0-9_]*)(?:`)?/g)) {
    const sentence = normalizedLine.split(/(?<=[.!?])\s+/).find((part) => part.includes(reference[0]));
    if (!sentence || sentence.length > 420) continue;
    const key = `${reference[1]}.${reference[2]}`;
    if (!descriptions.has(key) && sentence.includes(reference[0])) descriptions.set(key, sentence);
  }
}
for (const paragraph of allDocumentation.split(/\n\s*\n/)) {
  if (paragraph.includes("```")) continue;
  if (paragraph.trim().startsWith("|")) continue;
  const models = [...paragraph.matchAll(/`([A-Z][A-Za-z0-9]+)\.[a-z][a-z0-9_]*`/g)].map((match) => match[1]).filter((model, index, all) => interfaces.has(model) && all.indexOf(model) === index);
  for (const paragraphModel of models) for (const clause of paragraph.replace(/\s+/g, " ").split(/;\s+|\.\s+/)) {
    for (const field of interfaces.get(paragraphModel).keys()) {
      const fieldPattern = new RegExp(`(?:\\b|\\.)${field.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\b|\\?)`);
      if (fieldPattern.test(clause) && !descriptions.has(`${paragraphModel}.${field}`)) descriptions.set(`${paragraphModel}.${field}`, clause.trim().replace(/^[`|\s]+|[`|\s]+$/g, ""));
    }
  }
}
let documentedModel;
for (const line of allDocumentation.split("\n")) {
  const heading = line.match(/^#{2,6}\s+`?([A-Z][A-Za-z0-9]+)`?(?:\s|$)/);
  if (heading) documentedModel = interfaces.has(heading[1]) ? heading[1] : undefined;
  const row = line.match(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|\s*([^|]+?)\s*\|/);
  if (documentedModel && row && interfaces.get(documentedModel)?.has(row[1])) descriptions.set(`${documentedModel}.${row[1]}`, row[2].trim());
}
const documentedContractModels = {
  "core:discover_definitions": "DiscoverDefinitionsArguments", "core:find_records": "FindRecordsArguments", "core:resolve_symbol": "ResolveSymbolArguments", "core:get_outline": "GetOutlineArguments", "core:find_references": "FindReferencesArguments", "core:expand_relations": "ExpandRelationsArguments", "core:find_paths": "FindPathsArguments", "core:search_text": "SearchTextArguments", "core:search_semantic": "SearchSemanticArguments", "core:search_hybrid": "SearchHybridArguments", "core:get_source": "GetSourceArguments", "core:analyze_impact": "AnalyzeImpactArguments", "core:find_related_tests": "FindRelatedTestsArguments", "core:inspect_architecture": "InspectArchitectureArguments", "core:compare": "CompareArguments", "core:build_context": "BuildContextArguments", "core:index_status": "IndexStatusArguments",
  "core:locate_implementation": "LocateImplementationArguments", "core:understand_change_impact": "UnderstandChangeImpactArguments", "core:prepare_symbol_change": "PrepareSymbolChangeArguments", "core:prepare_new_feature": "PrepareNewFeatureArguments", "core:trace_behavior": "TraceBehaviorArguments", "core:find_relevant_tests": "FindRelevantTestsArguments", "core:explain_architecture_slice": "ExplainArchitectureSliceArguments", "core:compare_workspaces": "CompareWorkspacesArguments", "core:semantic_to_callers": "SemanticToCallersArguments", "core:resolve_and_find_references": "ResolveAndFindReferencesArguments", "core:definition_to_instances": "DefinitionToInstancesArguments",
};
let documentedContractModel;
for (const line of allDocumentation.split("\n")) {
  const heading = line.match(/^#{2,6}\s+`?(core:[a-z0-9_]+)(?:@\d+)?`?/);
  if (heading) documentedContractModel = documentedContractModels[heading[1]];
  const sharedHeading = line.match(/^#{2,6}\s+(.+?)\s*$/);
  if (sharedHeading) {
    const title = sharedHeading[1].toLowerCase();
    if (title.includes("subject selector")) documentedContractModel = "SubjectSelector";
    else if (title.includes("structural filter")) documentedContractModel = "StructuralFilter";
    else if (title.includes("relation selector")) documentedContractModel = "RelationSelector";
    else if (title.includes("registry selector")) documentedContractModel = "RegistrySelector";
  }
  const row = line.match(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
  if (documentedContractModel && row && interfaces.get(documentedContractModel)?.has(row[1])) descriptions.set(`${documentedContractModel}.${row[1]}`, row[3].trim());
}
// The lifecycle and protocol decisions use a second, normative field-table
// form: "`Model` fields:" followed by either bullets or a two-column table.
// Keep those descriptions keyed by the owning model and field. A bare model
// shape is intentionally not accepted as field documentation.
let fieldTableModel;
for (const line of allDocumentation.split("\n")) {
  const section = line.match(/^`?([A-Z][A-Za-z0-9]+)`?\s+fields:\s*$/);
  if (section && interfaces.has(section[1])) {
    fieldTableModel = section[1];
    continue;
  }
  if (!fieldTableModel) continue;
  const tableRow = line.match(/^\|\s*`?([a-z][a-z0-9_]*)`?\s*\|\s*([^|]+?)\s*\|/);
  const bullet = line.match(/^\s*-\s*`?([a-z][a-z0-9_]*)`?\s+(.*)$/);
  const field = tableRow ?? bullet;
  if (field && interfaces.get(fieldTableModel)?.has(field[1])) {
    const description = field[2].trim().replace(/^`|`$/g, "");
    if (description && description !== "Exact meaning") descriptions.set(`${fieldTableModel}.${field[1]}`, description);
    continue;
  }
  if (line.trim() === "" || (/^#{1,6}\s/.test(line) && !line.startsWith("####"))) fieldTableModel = undefined;
}
const exactDescriptions = {
  "RecordEnvelope.payload": "Data validated by the registered kind schema.",
  "EntityRecord.payload": "Data validated by the registered kind schema.",
  "RelationRecord.payload": "Data validated by the registered kind schema.",
  "FactRecord.payload": "Data validated by the registered kind schema.",
  "EvidenceRecord.payload": "Data validated by the registered kind schema.",
  "DiagnosticRecord.payload": "Data validated by the registered kind schema.",
  "ModelPackManifest.manifest_schema_version": "Positive core bootstrap-schema version used to decode and validate the complete closed manifest before any asset is opened. Unknown versions are rejected; fields from another version are never ignored.",
  "ModelPackManifest.model_pack_id": "Stable canonical namespaced pack identifier whose uniqueness is enforced within an installation. It conveys no authenticated publisher ownership.",
  "ModelPackManifest.model_pack_version": "Exact normalized SemVer 2.0.0 version permanently bound to one canonical manifest digest. Build metadata is preserved as part of the exact coordinate even though SemVer precedence ignores it.",
  "ModelPackManifest.embedding_profiles": "Non-empty duplicate-free ordered set of complete `EmbeddingProfile` definitions, canonically ordered by `embedding_profile_id`. Each stored `profile_digest` is recomputed before installation may continue.",
  "ModelPackManifest.assets": "Non-empty complete ordered set of `ModelPackAssetEntry` values. Every declared entry is mandatory and canonical ordering follows the asset-entry contract below.",
  "ModelPackManifest.required_runtime_components": "Non-empty complete ordered set of `ModelPackRuntimeRequirement` values needed to render, segment, generate, and infer for every embedded profile. Requirements can only select components already shipped with the target Urdira engine.",
  "ModelPackManifest.manifest_digest": "Digest of exactly the six preceding fields under `core:model_pack_manifest_digest`; the digest field itself and all delivery metadata are omitted. Urdira recomputes it before collision checks or asset acquisition.",
  "Snapshot.source_state_digest": "Digest of visible artifacts, versions, and tombstones.",
  "Snapshot.snapshot_digest": "UCE digest governed by `core:snapshot_digest`; its positive field list and referenced set digests are authoritative in the core digest-field registry.",
  "Snapshot.canonical_record_set_digest": "Digest of the complete visible canonical record set.",
  "Snapshot.capability_state_digest": "Digest of snapshot-wide capability coverage and limitations.",
  "ArtifactVersion.analysis_metadata_digest": "Digest of non-content metadata capable of affecting analysis.",
  "IntentRecipeDefinition.recipe_digest": "Complete `IntentRecipeDefinition` in declared field order with `recipe_digest` absent. Stage order is topological and semantic; capability, ranking, guard, and pagination-stream collections use their registered canonical identifier order.",
  "RecordStructuralSelector.record_categories": "Optional non-empty subset of canonical record categories; values combine by OR.",
  "RecordStructuralSelector.producer_ids": "Optional non-empty duplicate-free list of exact plugin or core producer identities; values combine by OR.",
  "PackageFileEntry.executable": "Whether the package file is executable when materialized.",
  "PackageFileEntry.normalized_relative_path": "The normalized package-relative path used as the package-file identity coordinate.",
  "PackageFileEntry.content_digest": "The sha256 digest of the complete package-file content.",
  "PackageFileEntry.byte_length": "The non-negative decoded byte length of the package-file content.",
  "RuntimeComponentContractBinding.component_kind": "The closed runtime component contract kind supplied by this binding.",
  "RuntimeComponentContractBinding.contract_version": "The positive version of the component contract supplied by this binding.",
  "RuntimeComponentContractBinding.configuration_schema_id": "The optional namespaced schema identifier for component configuration.",
  "RuntimeComponentContractBinding.configuration_schema_version": "The optional positive version of the component configuration schema.",
  "ModelAssetManifest.schema_version": "The positive version of the model asset manifest schema.",
  "ModelAssetManifest.model_provider_id": "The exact namespaced provider identifier for the model pack.",
  "ModelAssetManifest.model_id": "The exact provider-stable model family identifier.",
  "ModelAssetManifest.model_revision": "The exact immutable provider model revision.",
  "ModelAssetManifest.architecture_id": "The closed model architecture identifier.",
  "ModelAssetManifest.model_format": "The closed decoded model-storage format identifier.",
  "ModelAssetManifest.configuration_asset_digests": "The ordered configuration-asset content digests in the model pack.",
  "ModelAssetManifest.weight_asset_digests": "The non-empty ordered weight-asset content digests in shard order.",
  "ModelAssetManifest.model_identity_digest": "The digest covering the model identity fields preceding this field.",
  "NormalizedQueryPlan.operation_versions": "The ordered set of operation version bindings under core:operation_id_order@1.",
  "NormalizedQueryPlan.recipe_versions": "The ordered set of recipe version bindings under core:recipe_id_order@1.",
  "WorkspaceConfigurationRevision.effective_configuration_schema_id": "The namespaced identifier of the exact effective configuration schema.",
  "WorkspaceConfigurationRevision.installation_policy_digest": "The digest of the normalized installation policy layer.",
  "WorkspaceConfigurationRevision.user_policy_digest": "The digest of the normalized user policy layer.",
  "WorkspaceConfigurationRevision.workspace_file_digest": "The optional digest of the normalized workspace file layer.",
  "WorkspaceConfigurationRevision.administrative_override_digest": "The optional digest of the normalized administrative override layer.",
  "WorkspaceConfigurationRevision.analysis_configuration_digest": "The digest of normalized configuration affecting canonical or derived analysis output.",
  "WorkspaceConfigurationRevision.query_configuration_digest": "The digest of normalized configuration affecting query defaults.",
  "WorkspaceConfigurationRevision.resolved_embedding_binding_digests": "The canonical ordered set of executable embedding binding digests active for new materializations.",
  "WorkspaceConfigurationRevision.revision_digest": "The digest covering the preceding immutable configuration revision fields.",
  "TextTypeExpression.identifier_kind": "The registered lexical identifier profile applied to this text expression.",
  "BytesTypeExpression.bound_schema_id_field": "The adjacent required field carrying the schema identifier bound to these bytes.",
  "BytesTypeExpression.bound_schema_version_field": "The adjacent required field carrying the positive schema version bound to these bytes.",
  "TextTypeExpression.type_kind": "The closed text type discriminator.",
  "TextTypeExpression.minimum_code_point_count": "The inclusive lower bound on Unicode code points.",
  "TextTypeExpression.maximum_code_point_count": "The inclusive upper bound on Unicode code points.",
  "BytesTypeExpression.type_kind": "The closed bytes type discriminator.",
  "BytesTypeExpression.minimum_byte_length": "The inclusive lower bound on encoded byte length.",
  "BytesTypeExpression.maximum_byte_length": "The inclusive upper bound on encoded byte length.",
  "SafeIntegerTypeExpression.type_kind": "The closed safe-integer type discriminator.",
  "SafeIntegerTypeExpression.minimum": "The inclusive lower safe-integer bound.",
  "SafeIntegerTypeExpression.maximum": "The inclusive upper safe-integer bound.",
  "BigIntegerTypeExpression.type_kind": "The closed big-integer type discriminator.",
  "BigIntegerTypeExpression.minimum": "The inclusive lower canonical BigInteger bound.",
  "BigIntegerTypeExpression.maximum": "The inclusive upper canonical BigInteger bound.",
  "Float64TypeExpression.type_kind": "The closed finite-float type discriminator.",
  "Float64TypeExpression.minimum": "The inclusive lower finite Float64 bound.",
  "Float64TypeExpression.maximum": "The inclusive upper finite Float64 bound.",
  "ExactDecimalTypeExpression.type_kind": "The closed exact-decimal type discriminator.",
  "ExactDecimalTypeExpression.scale_policy": "The exact-decimal scale policy.",
  "ExactDecimalTypeExpression.minimum": "The inclusive lower canonical ExactDecimal bound.",
  "ExactDecimalTypeExpression.maximum": "The inclusive upper canonical ExactDecimal bound.",
  "TimestampTypeExpression.type_kind": "The closed timestamp type discriminator.",
  "TimestampTypeExpression.earliest": "The inclusive earliest canonical timestamp.",
  "TimestampTypeExpression.latest": "The inclusive latest canonical timestamp.",
  "DigestTypeExpression.type_kind": "The closed digest type discriminator.",
  "DigestTypeExpression.allowed_hash_algorithms": "The non-empty registered hash-algorithm set allowed for this digest.",
  "EnumTypeExpression.type_kind": "The closed enum type discriminator.",
  "EnumTypeExpression.values": "The non-empty canonical set of exact enum values.",
  "SequenceTypeExpression.type_kind": "The closed sequence type discriminator.",
  "SequenceTypeExpression.element_type": "The exact type accepted for each sequence element.",
  "SetTypeExpression.type_kind": "The closed set type discriminator.",
  "SetTypeExpression.element_type": "The exact type accepted for each set element.",
  "OrderedSetTypeExpression.type_kind": "The closed ordered-set type discriminator.",
  "OrderedSetTypeExpression.element_type": "The exact type accepted for each ordered-set element.",
  "OrderedSetTypeExpression.comparator_id": "The registered comparator identifier defining ordered-set order.",
  "OrderedSetTypeExpression.comparator_version": "The positive comparator definition version.",
  "MapTypeExpression.type_kind": "The closed map type discriminator.",
  "MapTypeExpression.value_type": "The exact type accepted for each map value.",
  "RecordTypeExpression.type_kind": "The closed record type discriminator.",
  "RecordTypeExpression.fields": "The closed ordered field definitions accepted by the record.",
  "UnionTypeExpression.type_kind": "The closed union type discriminator.",
  "UnionTypeExpression.discriminator_field": "The required field selecting the union variant.",
  "UnionTypeExpression.discriminator_description": "The normative description of the union discriminator.",
  "UnionTypeExpression.variants": "The non-empty closed variant definitions of the union.",
  "SchemaReferenceTypeExpression.type_kind": "The closed schema-reference type discriminator.",
  "SchemaReferenceTypeExpression.reference_scope": "Whether the referenced named type is local or external.",
  "SchemaReferenceTypeExpression.type_name": "The exact referenced named type.",
  "SchemaReferenceTypeExpression.schema_id": "The external schema identifier for this reference.",
  "SchemaReferenceTypeExpression.schema_version": "The positive external schema version for this reference.",
  "SchemaFieldDefinition.field_name": "The exact ASCII snake_case field name.",
  "SchemaFieldDefinition.description": "The mandatory normative documentation for the field.",
  "SchemaFieldDefinition.presence": "Whether the field is required or optional.",
  "SchemaFieldDefinition.value_type": "The exact closed type accepted for the field value.",
  "SchemaVariantDefinition.discriminator_value": "The exact discriminator value selecting the variant.",
  "SchemaVariantDefinition.description": "The normative documentation for the variant.",
  "SchemaVariantDefinition.fields": "The closed fields accepted in addition to the discriminator.",
};
const sourceFieldDescriptions = Object.fromEntries(Object.entries(sourceFields).flatMap(([model, fields]) => fields.map((field) => {
  const source = modelOwners.get(model) ?? "decisions/01-universal-data-model.md";
  return [`${model}.${field.name}`, `The \`${field.name}\` field on \`${model}\` carries ${field.logical_type}; it is ${field.presence} and is defined by \`${source}\`.`];
})));
const sourceForKey = (key) => {
  const model = key.slice(0, key.indexOf("."));
  if (recipeModelNames.has(model)) return "protocol/core-intent-recipes.md";
  if (publicModelNames.has(model)) return "protocol/public-query-contract.md";
  return modelOwners.get(model) ?? "decisions/01-universal-data-model.md";
};
const looksLikeModelShape = (model, value) => {
  if (!value) return true;
  if (value.startsWith(`text ${model} `)) return true;
  if (!value.startsWith(`${model} `)) return false;
  const fields = interfaces.get(model);
  return fields ? [...fields.keys()].filter((field) => value.includes(field)).length > 1 : false;
};
const documentedFieldDescription = (model, field) => {
  const key = `${model}.${field}`;
  const candidate = descriptions.get(key);
  if (candidate && !candidate.startsWith("|") && !looksLikeModelShape(model, candidate)) return candidate;
  // Search the owning prose for a sentence that names this exact field. This
  // is deliberately field-specific; a model-shape inventory is never used as
  // a description for any of its members.
  const fieldPattern = new RegExp(`(?:^|[.!?])\\s*[^.!?\\n]{0,360}\\b${model.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.${field.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b[^.!?\\n]{0,360}[.!?]`, "m");
  const prose = allDocumentation.match(fieldPattern)?.[0]?.trim();
  if (prose && !prose.startsWith("|") && !looksLikeModelShape(model, prose)) return prose;
  return undefined;
};
const authority = new Map();
for (const name of modelNames) {
  const fields = interfaces.get(name);
  if (!fields) throw new Error(`Missing TypeScript model declaration for ${name}`);
  for (const [field, definition] of fields) {
    const key = `${name}.${field}`;
    const description = exactDescriptions[key] ?? documentedFieldDescription(name, field) ?? sourceFieldDescriptions[key];
    if (description) authority.set(key, { logical_type: logicalType(definition.type), description, source: sourceForKey(key) });
  }
}
for (const [name, fields] of interfaces) {
  if (!modelNames.includes(name) && !additional.includes(` ${name}: [`)) continue;
  for (const [field, definition] of fields) if (!authority.has(`${name}.${field}`)) {
    const key = `${name}.${field}`;
    const description = exactDescriptions[key] ?? documentedFieldDescription(name, field) ?? sourceFieldDescriptions[key];
    if (description) authority.set(key, { logical_type: logicalType(definition.type), description, source: sourceForKey(key) });
  }
}
for (const match of additional.matchAll(/\s+(\w+): \[(.*?)\],/gs)) for (const field of match[2].matchAll(/modelField\("(\w+)"/g)) if (!authority.has(`${match[1]}.${field[1]}`)) {
  const key = `${match[1]}.${field[1]}`;
  const description = exactDescriptions[key] ?? documentedFieldDescription(match[1], field[1]) ?? sourceFieldDescriptions[key];
  if (description) authority.set(key, { logical_type: "Text", description, source: sourceForKey(key) });
}
for (const [model, fields] of Object.entries(sourceFields)) for (const field of fields) {
  const key = `${model}.${field.name}`;
  const current = authority.get(key);
  const description = current?.description ?? exactDescriptions[key] ?? documentedFieldDescription(model, field.name) ?? sourceFieldDescriptions[key];
  if (description) authority.set(key, { logical_type: field.logical_type, description, source: sourceForKey(key) });
}

let codeBlock = false;
let currentModel;
for (const line of canonicalSchemas.split("\n")) {
  if (line.trim() === "```text") { codeBlock = true; currentModel = undefined; continue; }
  if (codeBlock && line.trim() === "```") { codeBlock = false; currentModel = undefined; continue; }
  if (!codeBlock) continue;
  const model = line.match(/^(?:core:)?([A-Za-z][A-Za-z0-9]+)(?:@\d+)?(?:\s*=.*)?$/);
  if (model && !line.startsWith(" ")) { currentModel = model[1]; continue; }
  const field = line.match(/^\s{2}([a-z][a-z0-9_]*)(\?)?\s*:\s*(.+)$/);
  if (!field || !currentModel) continue;
  const key = `${currentModel}.${field[1]}`;
  const current = authority.get(key) ?? { description: exactDescriptions[key] ?? documentedFieldDescription(currentModel, field[1]) ?? sourceFieldDescriptions[key], source: sourceForKey(key) };
  if (!current.description) continue;
  authority.set(key, { logical_type: field[3].trim().replace(/\?$/, ""), description: current.description, source: current.source ?? sourceForKey(key) });
}

const exact = {
  "RecordEnvelope.payload": "JsonValue",
  "EntityRecord.payload": "JsonValue",
  "RelationRecord.payload": "JsonValue",
  "FactRecord.payload": "JsonValue",
  "EvidenceRecord.payload": "JsonValue",
  "DiagnosticRecord.payload": "JsonValue",
  "EntityRecord.category": "entity",
  "RelationRecord.category": "relation",
  "FactRecord.category": "fact",
  "EvidenceRecord.category": "evidence",
  "DiagnosticRecord.category": "diagnostic",
  "EntityRecord.schema_version": "PositiveInteger",
  "RelationRecord.schema_version": "PositiveInteger",
  "FactRecord.schema_version": "PositiveInteger",
  "EvidenceRecord.schema_version": "PositiveInteger",
  "DiagnosticRecord.schema_version": "PositiveInteger",
  "RuntimeComponentContractBinding.component_kind": "source_provider | projection_generator | embedding_renderer | embedding_segmenter | embedding_generator",
  "RuntimeComponentContractBinding.contract_version": "PositiveInteger",
  "RuntimeComponentContractBinding.configuration_schema_id": "NamespacedIdentifier",
  "RuntimeComponentContractBinding.configuration_schema_version": "PositiveInteger",
  "NormalizedQueryPlan.api_version": "SemVer",
  "NormalizedQueryPlan.wait_timeout_ms": "Count",
  "NormalizedQueryPlan.operation_versions": "OrderedSet<OperationVersionBinding, core:operation_id_order@1>",
  "NormalizedQueryPlan.recipe_versions": "OrderedSet<RecipeVersionBinding, core:recipe_id_order@1>",
  "PackageFileEntry.content_digest": "Digest",
  "PackageFileEntry.byte_length": "Count",
  "CandidateNamespaceOwner.contribution_digest": "Digest",
  "WorkspaceConfigurationRevision.effective_configuration_schema_version": "PositiveInteger",
  "WorkspaceConfigurationRevision.effective_configuration_schema_id": "NamespacedIdentifier",
  "WorkspaceConfigurationRevision.effective_configuration": "SchemaBoundBytes",
  "Workspace.source_provider_bindings": "Sequence<WorkspaceSourceProviderBinding>",
  "WorkspaceConfigurationRevision.resolved_embedding_binding_digests": "Sequence<Digest>",
  "AnalysisConfiguration.configuration_schema_id": "NamespacedIdentifier",
  "ModelAssetManifest.configuration_asset_digests": "Sequence<Digest>",
  "ModelAssetManifest.weight_asset_digests": "Sequence<Digest>",
  "ModelAssetManifest.model_identity_digest": "Digest",
  "WorkspaceConfigurationRevision.installation_policy_digest": "Digest",
  "WorkspaceConfigurationRevision.user_policy_digest": "Digest",
  "WorkspaceConfigurationRevision.workspace_file_digest": "Digest",
  "WorkspaceConfigurationRevision.administrative_override_digest": "Digest",
  "WorkspaceConfigurationRevision.analysis_configuration_digest": "Digest",
  "WorkspaceConfigurationRevision.query_configuration_digest": "Digest",
  "WorkspaceConfigurationRevision.revision_digest": "Digest",
  "RuntimeComponentDefinition.component_contracts": "Sequence<RuntimeComponentContractBinding>",
  "PluginPackageManifest.package_files": "OrderedSet<PackageFileEntry, core:package_file_path_order@1>",
};
// Materialize the documented coordinate classes into the committed authority
// table. Runtime code consumes this table; it does not infer a type from a
// value. The model declarations supply the number-vs-text distinction for
// version coordinates, while digest/generation/count suffixes are closed UDM
// coordinate classes rather than catch-all text fields.
for (const key of Object.keys(authority)) {
  const separator = key.indexOf(".");
  const model = key.slice(0, separator);
  const field = key.slice(separator + 1);
  if (!model || model === "Model") continue;
  if (field.endsWith("_digest")) exact[key] = "Digest";
  else if (field.endsWith("_digests")) {
    const current = authority.get(key)?.logical_type ?? "";
    if (current === "Sequence<Text>" || current === "Set<Text>") exact[key] = current.replace(/Text/g, "Digest");
  } else if (field.endsWith("_generation") || field.endsWith("_ordinal") || field.endsWith("_count") || field.endsWith("_length")) exact[key] = "Count";
  else if (field.endsWith("_version")) exact[key] = interfaces.get(model)?.get(field)?.type === "number" ? "PositiveInteger" : "SemVer";
}
Object.assign(exact, {
  "ModelPackManifest.manifest_schema_version": "PositiveInteger",
  "ModelPackManifest.model_pack_id": "NamespacedIdentifier",
  "ModelPackManifest.model_pack_version": "SemVer",
  "ModelPackManifest.manifest_digest": "Digest",
  "ModelAssetManifest.schema_version": "PositiveInteger",
  "ModelAssetManifest.model_provider_id": "NamespacedIdentifier",
  "ModelAssetManifest.model_id": "Identifier",
  "ModelAssetManifest.model_revision": "Identifier",
  "ModelAssetManifest.architecture_id": "NamespacedIdentifier",
  "ModelAssetManifest.model_format": "NamespacedIdentifier",
  "ModelAssetManifest.configuration_asset_digests": "Sequence<Digest>",
  "ModelAssetManifest.weight_asset_digests": "Sequence<Digest>",
  "ModelAssetManifest.model_identity_digest": "Digest",
  "TokenizerAssetManifest.schema_version": "PositiveInteger",
  "TokenizerAssetManifest.tokenizer_id": "Identifier",
  "TokenizerAssetManifest.tokenizer_revision": "Identifier",
  "TokenizerAssetManifest.tokenizer_format": "NamespacedIdentifier",
  "TokenizerAssetManifest.configuration_asset_digests": "Sequence<Digest>",
  "TokenizerAssetManifest.tokenizer_data_asset_digests": "Sequence<Digest>",
  "TokenizerAssetManifest.tokenizer_digest": "Digest",
  "ModelPackRuntimeConfiguration.schema_version": "PositiveInteger",
  "ModelPackRuntimeConfiguration.embedding_profile_id": "Identifier",
  "ModelPackRuntimeConfiguration.runtime_role": "segmenter | generator",
  "ModelPackRuntimeConfiguration.component_id": "NamespacedIdentifier",
  "ModelPackRuntimeConfiguration.component_version": "SemVer",
  "ModelPackRuntimeConfiguration.contract_version": "PositiveInteger",
  "ModelPackRuntimeConfiguration.configuration_schema_id": "NamespacedIdentifier",
  "ModelPackRuntimeConfiguration.configuration": "Bytes",
  "ModelPackRuntimeConfiguration.configuration_digest": "Digest",
  "Snapshot.source_state_digest": "Digest",
  "Snapshot.projection_set_digests": "Sequence<Digest>",
  "Snapshot.snapshot_digest": "Digest",
  "Snapshot.canonical_record_set_digest": "Digest",
  "Snapshot.capability_state_digest": "Digest",
  "ArtifactVersion.analysis_metadata_digest": "Digest",
  "CandidateSourceTransitionTemplate.target_artifact_version_without_generation": "CandidateArtifactVersionTemplate",
  "CandidateSourceTransitionTemplate.target_artifact_tombstone_without_generation": "CandidateArtifactTombstoneTemplate",
  "IntentRecipeDefinition.recipe_digest": "Digest",
  "IntentRecipeDefinition.recipe_version": "PositiveInteger",
  "IntentRecipeDefinition.public_api_version": "PositiveInteger",
  "IntentRecipeDefinition.argument_schema_version": "PositiveInteger",
  "WorkspaceCurrentState.state_revision": "PositiveInteger",
  "IntentRecipeStageDefinition.operator_version": "PositiveInteger",
});
for (const [key, logical_type] of Object.entries(exact)) {
  const current = authority.get(key);
  if (!current) throw new Error(`Missing authoritative field ${key}`);
  authority.set(key, { ...current, logical_type });
}
for (const [key, current] of authority) {
  const separator = key.indexOf(".");
  const model = key.slice(0, separator);
  const field = key.slice(separator + 1);
  if (!model || model === "Model") continue;
  let logical_type = current.logical_type;
  if (!Object.hasOwn(exact, key) && field.endsWith("_digest")) logical_type = "Digest";
  else if (!Object.hasOwn(exact, key) && field.endsWith("_digests") && (logical_type === "Sequence<Text>" || logical_type === "Set<Text>")) logical_type = logical_type.replace(/Text/g, "Digest");
  else if (!Object.hasOwn(exact, key) && (field.endsWith("_generation") || field.endsWith("_ordinal") || field.endsWith("_count") || field.endsWith("_length"))) logical_type = "Count";
  else if (!Object.hasOwn(exact, key) && field.endsWith("_version")) logical_type = interfaces.get(model)?.get(field)?.type === "number" ? "PositiveInteger" : "SemVer";
  else if (!Object.hasOwn(exact, key) && field.endsWith("_hash")) logical_type = "Digest";
  else if (!Object.hasOwn(exact, key) && (field === "digest_domain" || field.startsWith("replacement_digest_") || field.endsWith("_digest_domain"))) logical_type = "NamespacedIdentifier";
  else if (!Object.hasOwn(exact, key) && /(?:source|input)_artifact_version_ids$/.test(field) && (logical_type === "Text" || logical_type === "Sequence<Text>")) logical_type = "Sequence<Identifier>";
  else if (!Object.hasOwn(exact, key) && (field === "schema_id" || field === "operation_id" || field === "recipe_id" || field === "comparator_id" || field.endsWith("_schema_id") || field.endsWith("_recipe_id"))) logical_type = "NamespacedIdentifier";
  else if (!Object.hasOwn(exact, key) && field.endsWith("_id")) logical_type = "Identifier";
  if (logical_type !== current.logical_type) authority.set(key, { ...current, logical_type });
}
for (const [key, logical_type] of Object.entries({
  "RuntimeComponentContractBinding.contract_version": "PositiveInteger",
  "RuntimeComponentContractBinding.configuration_schema_version": "PositiveInteger",
  "ModelPackManifest.manifest_schema_version": "PositiveInteger",
  "ModelPackManifest.model_pack_id": "NamespacedIdentifier",
  "ModelPackManifest.model_pack_version": "SemVer",
  "ModelPackManifest.manifest_digest": "Digest",
  "ModelPackCoordinateReservation.model_pack_id": "NamespacedIdentifier",
  "ModelPackInstallation.model_pack_id": "NamespacedIdentifier",
  "Snapshot.source_state_digest": "Digest",
  "Snapshot.snapshot_digest": "Digest",
  "Snapshot.canonical_record_set_digest": "Digest",
  "Snapshot.capability_state_digest": "Digest",
  "ArtifactVersion.analysis_metadata_digest": "Digest",
  "IntentRecipeDefinition.recipe_digest": "Digest",
  "IntentRecipeDefinition.recipe_version": "PositiveInteger",
  "IntentRecipeDefinition.public_api_version": "PositiveInteger",
  "IntentRecipeDefinition.argument_schema_version": "PositiveInteger",
  "EmbeddingProfileExecutableBinding.operational_asset_digests": "Sequence<Digest>",
})) {
  const current = authority.get(key);
  if (!current) throw new Error(`Missing authoritative field ${key}`);
  authority.set(key, { ...current, logical_type });
}
for (const [key, description] of Object.entries(exactDescriptions)) {
  const current = authority.get(key);
  if (!current) throw new Error(`Missing authoritative field ${key}`);
  authority.set(key, { ...current, description });
}
const missingSourceFields = Object.keys(sourceFieldDescriptions).filter((key) => !authority.has(key));
if (missingSourceFields.length > 0) throw new Error(`Missing source-backed field descriptions: ${missingSourceFields.slice(0, 20).join(", ")}${missingSourceFields.length > 20 ? ` (and ${missingSourceFields.length - 20} more)` : ""}`);

if (authority.size < 2500) throw new Error(`Expected complete model authority table, got ${authority.size} fields`);
const ordered = Object.fromEntries([...authority.entries()].sort(([left], [right]) => left.localeCompare(right)));
const owners = Object.fromEntries([...modelOwners.entries()].sort(([left], [right]) => left.localeCompare(right)));
const output = `/** Mechanically transcribed from the authoritative UDM, canonical schema, and lifecycle field dictionaries. */\nexport const authoritativeModelOwners = ${JSON.stringify(owners, null, 2)} as const;\nexport const authoritativeModelFieldMetadata = ${JSON.stringify(ordered, null, 2)} as const;\n`;
writeFileSync(new globalThis.URL("src/model-field-authority.ts", contractRoot), output);

function logicalType(type) {
  const normalized = type.replace(/\s+/g, " ").trim();
  if (normalized === "string") return "Text";
  if (normalized === "boolean") return "Boolean";
  if (normalized === "number") return "Count";
  if (normalized === "Uint8Array") return "Bytes";
  const sequence = normalized.match(/^ReadonlyArray<(.+)>$/);
  if (sequence) return `Sequence<${logicalType(sequence[1])}>`;
  if (normalized === "JsonValue") return "JsonValue";
  const literalUnion = normalized.split("|").map((value) => value.trim()).filter((value) => value.startsWith("\"") && value.endsWith("\""));
  if (literalUnion.length === 1) return literalUnion[0].slice(1, -1);
  if (literalUnion.length > 1) return literalUnion.map((value) => value.slice(1, -1)).join(" | ");
  return normalized.replace(/ReadonlyArray</g, "Sequence<");
}
