import {
  canonicalSchemaRegistry,
  type RegistryEntry,
} from "./registries.js";
import {
  generateJsonSchema,
  type CanonicalSchemaDefinition,
  type CanonicalTypeExpression,
  type JsonSchema,
} from "./schema-ir.js";
import { inlineSchemaSpecs, type InlineSchemaSpec } from "./inline-schema-specs.js";
import { authoritativeModelNames } from "./model-names.js";
import { modelContractRegistry } from "./generated-model-contracts.js";
import { authoritativeModelFieldMetadata } from "./model-field-authority.js";

const modelReferenceSpecs: Readonly<Record<string, InlineSchemaSpec>> = {
  ModelAssetManifest: { id: "core:ModelAssetManifest@1", fields: [
    { name: "schema_version", optional: false, type: "PositiveInteger" },
    { name: "model_provider_id", optional: false, type: "NamespacedIdentifier" },
    { name: "model_id", optional: false, type: "Identifier" },
    { name: "model_revision", optional: false, type: "Identifier" },
    { name: "architecture_id", optional: false, type: "NamespacedIdentifier" },
    { name: "model_format", optional: false, type: "NamespacedIdentifier" },
    { name: "configuration_asset_digests", optional: false, type: "Sequence<Digest>" },
    { name: "weight_asset_digests", optional: false, type: "Sequence<Digest>" },
    { name: "model_identity_digest", optional: false, type: "Digest" },
  ] },
  TokenizerAssetManifest: { id: "core:TokenizerAssetManifest@1", fields: [
    { name: "schema_version", optional: false, type: "PositiveInteger" },
    { name: "tokenizer_id", optional: false, type: "Identifier" },
    { name: "tokenizer_revision", optional: false, type: "Identifier" },
    { name: "tokenizer_format", optional: false, type: "NamespacedIdentifier" },
    { name: "configuration_asset_digests", optional: false, type: "Sequence<Digest>" },
    { name: "tokenizer_data_asset_digests", optional: false, type: "Sequence<Digest>" },
    { name: "tokenizer_digest", optional: false, type: "Digest" },
  ] },
  ModelPackRuntimeConfiguration: { id: "core:ModelPackRuntimeConfiguration@1", fields: [
    { name: "schema_version", optional: false, type: "PositiveInteger" },
    { name: "embedding_profile_id", optional: false, type: "Identifier" },
    { name: "runtime_role", optional: false, type: "segmenter | generator" },
    { name: "component_id", optional: false, type: "NamespacedIdentifier" },
    { name: "component_version", optional: false, type: "SemVer" },
    { name: "contract_version", optional: false, type: "PositiveInteger" },
    { name: "configuration_schema_id", optional: false, type: "NamespacedIdentifier" },
    { name: "configuration", optional: false, type: "Bytes" },
    { name: "configuration_digest", optional: false, type: "Digest" },
  ] },
  VisibleSourceStateEntry: { id: "core:VisibleSourceStateEntry@1", fields: [
    { name: "state_kind", optional: false, type: "present | absent" },
    { name: "workspace_id", optional: false, type: "Identifier" },
    { name: "artifact_id", optional: false, type: "Identifier" },
    { name: "normalized_uri", optional: false, type: "URI" },
  ] },
};
const schemaBoundByteCoordinates: Readonly<Record<string, readonly [string, string]>> = {
  normalized_metadata: ["metadata_schema_id", "metadata_schema_version"],
  normalized_configuration: ["configuration_schema_id", "configuration_schema_version"],
  definition_bytes: ["schema_id", "schema_version"],
  requirement_value: ["requirement_schema_id", "requirement_schema_version"],
  partial_arguments: ["partial_arguments_schema_id", "partial_arguments_schema_version"],
};

export const coreSchemaDefinitions: CanonicalSchemaDefinition[] = canonicalSchemaRegistry.map((entry: RegistryEntry) => {
  const spec = inlineSchemaSpecs.find((candidate) => candidate.id === entry.id);
  const modelReference = entry.id.match(/^core:(ModelAssetManifest|ModelPackRuntimeConfiguration|TokenizerAssetManifest)@1$/)?.[1];
  if (modelReference) {
    return {
      schema_id: entry.id.replace(/@1$/, ""),
      definition_revision: entry.definition_revision,
      schema_version: entry.schema_version,
      description: entry.description,
      root_type: externalModelReference(modelReference),
      type_definitions: [],
      lifecycle_state: entry.lifecycle_state,
    };
  }
  if (entry.id === "core:VisibleSourceStateSet@1") {
    return {
      schema_id: "core:VisibleSourceStateSet",
      definition_revision: entry.definition_revision,
      schema_version: entry.schema_version,
      description: entry.description,
      root_type: {
        type_kind: "ordered_set",
        element_type: externalModelReference("VisibleSourceStateEntry"),
        comparator_id: "core:visible_source_state_order",
        comparator_version: 1,
      },
      type_definitions: [],
      lifecycle_state: entry.lifecycle_state,
    };
  }
  if (!spec && entry.id !== "core:Bytes@1") throw new Error(`Missing authoritative inline schema source for ${entry.id}`);
  return {
    schema_id: entry.id.replace(/@1$/, ""),
    definition_revision: entry.definition_revision,
    schema_version: entry.schema_version,
    description: entry.description,
    root_type: entry.id === "core:Bytes@1" ? { type_kind: "bytes" } : {
      type_kind: "record",
      fields: spec?.fields.map((field) => ({
        field_name: field.name,
        description: field.description ?? authoritativeDescription(entry.id.replace(/^core:/, "").replace(/@\d+$/, ""), field.name),
        presence: field.optional ? "optional" as const : "required" as const,
        value_type: inlineType(field.type, field.name),
      })) ?? [],
    },
    type_definitions: [],
    lifecycle_state: entry.lifecycle_state,
  };
});

function inlineType(type: string, fieldName?: string): CanonicalTypeExpression {
  const set = type.match(/^Set<(.+)>$/);
  if (set) return { type_kind: "set" as const, element_type: inlineType(set[1] ?? "", fieldName) };
  const orderedSet = type.match(/^OrderedSet<(.+),\s*(core:[^>]+)>$/);
  if (orderedSet) return { type_kind: "ordered_set" as const, element_type: inlineType(orderedSet[1] ?? ""), comparator_id: (orderedSet[2] ?? "").replace(/@\d+$/, ""), comparator_version: 1 };
  const sequence = type.match(/^Sequence<(.+)>$/);
  if (sequence) return { type_kind: "sequence" as const, element_type: inlineType(sequence[1] ?? "", fieldName), ...(fieldName === "weight_asset_digests" ? { minimum_item_count: 1 } : {}) };
  const enumValues = splitTopLevelPipe(type);
  if (enumValues.length > 1) {
    if (enumValues.every((value) => !authoritativeModelNames.includes(value as (typeof authoritativeModelNames)[number]))) return { type_kind: "enum" as const, values: enumValues };
    throw new Error(`Unsupported inline union without an authoritative Schema IR definition: ${type}`);
  }
  if (type === "Boolean") return { type_kind: "boolean" as const };
  if (type === "PositiveInteger" || type === "Count") return { type_kind: "safe_integer" as const, minimum: type === "PositiveInteger" ? 1 : 0 };
  if (type === "Bytes") return { type_kind: "bytes" as const };
  if (type === "SchemaBoundBytes") {
    const coordinates = fieldName ? schemaBoundByteCoordinates[fieldName] : undefined;
    if (!coordinates) throw new Error(`Missing authoritative adjacent schema coordinate for SchemaBoundBytes field ${fieldName ?? "<unnamed>"}`);
    return { type_kind: "bytes" as const, minimum_byte_length: 1, bound_schema_id_field: coordinates[0], bound_schema_version_field: coordinates[1] };
  }
  if (type === "Digest") return { type_kind: "digest" as const, allowed_hash_algorithms: ["sha256"] };
  if (type === "Identifier") return { type_kind: "text" as const, identifier_kind: "identifier" };
  if (type === "NamespacedIdentifier") return { type_kind: "text" as const, identifier_kind: "namespaced_identifier" };
  if (type === "SemVer") return { type_kind: "text" as const, identifier_kind: "semver" };
  if (type === "URI") return { type_kind: "text" as const, identifier_kind: "uri" };
  if (type === "Text") return { type_kind: "text" as const };
  if (type === "JsonValue") return { type_kind: "schema_reference" as const, reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 };
  if (authoritativeModelNames.includes(type as (typeof authoritativeModelNames)[number])) return externalModelReference(type);
  throw new Error(`Unknown authoritative schema type ${type}`);
}

function splitTopLevelPipe(type: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < type.length; index += 1) {
    const character = type[index];
    if (character === "<") depth += 1;
    if (character === ">") depth -= 1;
    if (character === "|" && depth === 0) {
      values.push(type.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(type.slice(start).trim());
  return values;
}

function externalModelReference(typeName: string): CanonicalTypeExpression {
  return { type_kind: "schema_reference", reference_scope: "external", type_name: typeName, schema_id: `core:${typeName}`, schema_version: 1 };
}

export const generatedJsonSchemaRegistry: Readonly<Record<string, JsonSchema>> = Object.fromEntries(
  coreSchemaDefinitions.map((schema) => [`${schema.schema_id}@${schema.schema_version}`, addModelDefinitions(schema, generateJsonSchema(schema))]),
);

function addModelDefinitions(schema: CanonicalSchemaDefinition, generated: JsonSchema): JsonSchema {
  const references = new Set<string>();
  const collect = (type: CanonicalTypeExpression): void => {
    if (type.type_kind === "schema_reference" && type.reference_scope === "external" && authoritativeModelNames.includes(type.type_name as (typeof authoritativeModelNames)[number])) references.add(type.type_name);
    if (type.type_kind === "sequence" || type.type_kind === "set" || type.type_kind === "ordered_set") collect(type.element_type);
    if (type.type_kind === "map") collect(type.value_type);
    if (type.type_kind === "record") for (const field of type.fields) collect(field.value_type);
    if (type.type_kind === "union") for (const variant of type.variants) for (const field of variant.fields) collect(field.value_type);
  };
  collect(schema.root_type);
  for (const definition of schema.type_definitions) collect(definition.type_expression);
  const defs: Record<string, JsonSchema> = { ...(generated.$defs ?? {}) };
  const built = new Set<string>();
  const add = (typeName: string): void => {
    if (built.has(typeName)) return;
    built.add(typeName);
    const spec = modelReferenceSpecs[typeName];
    const model = modelContractRegistry.find((candidate) => candidate.name === typeName);
    if (!spec && !model) throw new Error(`Missing authoritative model schema source for ${typeName}`);
    const fields = spec
      ? spec.fields.map((field) => ({
          field_name: field.name,
          description: field.description ?? authoritativeDescription(typeName, field.name),
          presence: field.optional ? "optional" as const : "required" as const,
          value_type: inlineType(field.type, field.name),
        }))
      : model!.fields.map((field) => ({
          field_name: field.name,
          description: field.description,
          presence: field.presence,
          value_type: inlineType(field.logical_type, field.name),
        }));
    const rootType: CanonicalTypeExpression = typeName === "VisibleSourceStateEntry"
    ? {
        type_kind: "union",
        discriminator_field: "state_kind",
        discriminator_description: "The exact visible source-state variant.",
        variants: [
          {
            discriminator_value: "present",
            description: "A present source artifact version.",
            fields: [
              { field_name: "workspace_id", description: "The owning workspace.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "artifact_id", description: "The exact artifact address.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "normalized_uri", description: "The canonical artifact URI.", presence: "required", value_type: inlineType("URI") },
              { field_name: "artifact_kind", description: "The source artifact kind.", presence: "required", value_type: inlineType("Text") },
              { field_name: "artifact_version_id", description: "The exact visible artifact version.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "content_hash", description: "The exact content hash.", presence: "required", value_type: inlineType("Digest") },
              { field_name: "byte_length", description: "The decoded byte length.", presence: "required", value_type: inlineType("Count") },
              { field_name: "encoding", description: "The canonical content encoding.", presence: "required", value_type: inlineType("Text") },
              { field_name: "language_hint", description: "The optional language hint.", presence: "optional", value_type: inlineType("Text") },
              { field_name: "analysis_metadata_digest", description: "The analysis metadata digest.", presence: "required", value_type: inlineType("Digest") },
              { field_name: "valid_from_generation", description: "The opening generation.", presence: "required", value_type: inlineType("Count") },
            ],
          },
          {
            discriminator_value: "absent",
            description: "An absent source artifact tombstone.",
            fields: [
              { field_name: "workspace_id", description: "The owning workspace.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "artifact_id", description: "The exact artifact address.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "normalized_uri", description: "The canonical artifact URI.", presence: "required", value_type: inlineType("URI") },
              { field_name: "artifact_kind", description: "The source artifact kind.", presence: "required", value_type: inlineType("Text") },
              { field_name: "artifact_tombstone_id", description: "The exact absence tombstone.", presence: "required", value_type: inlineType("Identifier") },
              { field_name: "absence_kind", description: "The closed absence reason kind.", presence: "required", value_type: { type_kind: "enum", values: ["deleted", "excluded"] } },
              { field_name: "absence_reason_code", description: "The registered absence reason.", presence: "required", value_type: inlineType("NamespacedIdentifier") },
              { field_name: "last_artifact_version_id", description: "The last visible artifact version.", presence: "optional", value_type: inlineType("Identifier") },
              { field_name: "valid_from_generation", description: "The opening generation.", presence: "required", value_type: inlineType("Count") },
            ],
          },
        ],
      }
    : { type_kind: "record", fields };
    const definition = generateJsonSchema({
    schema_id: `core:${typeName}`,
    definition_revision: 1,
    schema_version: 1,
    description: `${typeName} is the exact model referenced by the canonical schema registry.`,
    root_type: rootType,
    type_definitions: [],
    lifecycle_state: "active",
  });
    defs[typeName] = definition;
    const collectDefinition = (type: CanonicalTypeExpression): void => {
      if (type.type_kind === "schema_reference" && type.reference_scope === "external" && authoritativeModelNames.includes(type.type_name as (typeof authoritativeModelNames)[number])) {
        add(type.type_name);
        return;
      }
      if (type.type_kind === "sequence" || type.type_kind === "set" || type.type_kind === "ordered_set") collectDefinition(type.element_type);
      if (type.type_kind === "map") collectDefinition(type.value_type);
      if (type.type_kind === "record") for (const field of type.fields) collectDefinition(field.value_type);
      if (type.type_kind === "union") for (const variant of type.variants) for (const field of variant.fields) collectDefinition(field.value_type);
    };
    for (const field of fields) collectDefinition(field.value_type);
  };
  for (const reference of references) add(reference);
  return Object.keys(defs).length > 0 ? { ...generated, $defs: defs } : generated;
}

function authoritativeDescription(modelName: string, fieldName: string): string {
  const metadata = authoritativeModelFieldMetadata[`${modelName}.${fieldName}` as keyof typeof authoritativeModelFieldMetadata];
  if (!metadata?.description) throw new Error(`Missing authoritative description for ${modelName}.${fieldName}`);
  return metadata.description;
}

export function getGeneratedJsonSchema(schemaId: string, schemaVersion = 1): JsonSchema | undefined {
  return generatedJsonSchemaRegistry[`${schemaId}@${schemaVersion}`];
}
