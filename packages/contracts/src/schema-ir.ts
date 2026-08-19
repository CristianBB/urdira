import { authoritativeModelNames } from "./model-names.js";
import { comparatorRegistry, operationDefinitions, recipeRegistry } from "./registries.js";
import { modelContractRegistry } from "./generated-model-contracts.js";

export type Presence = "required" | "optional";
export type LifecycleState = "active" | "deprecated" | "retired";

export interface SchemaFieldDefinition {
  field_name: string;
  description: string;
  presence: Presence;
  value_type: CanonicalTypeExpression;
}

export interface SchemaVariantDefinition {
  discriminator_value: string;
  description: string;
  fields: ReadonlyArray<SchemaFieldDefinition>;
}

export interface CanonicalNamedTypeDefinition {
  type_name: string;
  description: string;
  type_expression: CanonicalTypeExpression;
}

export interface NullTypeExpression { type_kind: "null"; }
export interface BooleanTypeExpression { type_kind: "boolean"; }
export interface SafeIntegerTypeExpression {
  type_kind: "safe_integer";
  minimum?: number;
  maximum?: number;
}
export interface BigIntegerTypeExpression {
  type_kind: "big_integer";
  minimum?: string;
  maximum?: string;
}
export interface Float64TypeExpression {
  type_kind: "float64";
  minimum?: number;
  maximum?: number;
}
export interface ExactDecimalTypeExpression {
  type_kind: "exact_decimal";
  minimum?: string;
  maximum?: string;
  scale_policy: "significant" | "insignificant";
}
export interface TextTypeExpression {
  type_kind: "text";
  identifier_kind?: "identifier" | "namespaced_identifier" | "semver" | "uri";
  minimum_code_point_count?: number;
  maximum_code_point_count?: number;
}
export interface BytesTypeExpression {
  type_kind: "bytes";
  minimum_byte_length?: number;
  maximum_byte_length?: number;
  bound_schema_id_field?: string;
  bound_schema_version_field?: string;
}
export interface TimestampTypeExpression {
  type_kind: "timestamp";
  earliest?: string;
  latest?: string;
}
export interface DigestTypeExpression {
  type_kind: "digest";
  allowed_hash_algorithms: ReadonlyArray<string>;
}
export interface EnumTypeExpression {
  type_kind: "enum";
  values: ReadonlyArray<string>;
}
export interface SequenceTypeExpression {
  type_kind: "sequence";
  element_type: CanonicalTypeExpression;
  minimum_item_count?: number;
  maximum_item_count?: number;
}
export interface SetTypeExpression {
  type_kind: "set";
  element_type: CanonicalTypeExpression;
  minimum_item_count?: number;
  maximum_item_count?: number;
}
export interface OrderedSetTypeExpression {
  type_kind: "ordered_set";
  element_type: CanonicalTypeExpression;
  comparator_id: string;
  comparator_version: number;
  minimum_item_count?: number;
  maximum_item_count?: number;
}
export interface MapTypeExpression {
  type_kind: "map";
  value_type: CanonicalTypeExpression;
  minimum_entry_count?: number;
  maximum_entry_count?: number;
}
export interface RecordTypeExpression {
  type_kind: "record";
  fields: ReadonlyArray<SchemaFieldDefinition>;
}
export interface UnionTypeExpression {
  type_kind: "union";
  discriminator_field: string;
  discriminator_description: string;
  variants: ReadonlyArray<SchemaVariantDefinition>;
}
export interface SchemaReferenceTypeExpression {
  type_kind: "schema_reference";
  reference_scope: "local" | "external";
  type_name: string;
  schema_id?: string;
  schema_version?: number;
}

export type CanonicalTypeExpression =
  | NullTypeExpression
  | BooleanTypeExpression
  | SafeIntegerTypeExpression
  | BigIntegerTypeExpression
  | Float64TypeExpression
  | ExactDecimalTypeExpression
  | TextTypeExpression
  | BytesTypeExpression
  | TimestampTypeExpression
  | DigestTypeExpression
  | EnumTypeExpression
  | SequenceTypeExpression
  | SetTypeExpression
  | OrderedSetTypeExpression
  | MapTypeExpression
  | RecordTypeExpression
  | UnionTypeExpression
  | SchemaReferenceTypeExpression;

export interface CanonicalSchemaDefinition {
  schema_id: string;
  definition_revision: number;
  schema_version: number;
  description: string;
  root_type: CanonicalTypeExpression;
  type_definitions: ReadonlyArray<CanonicalNamedTypeDefinition>;
  plugin_owner?: string;
  lifecycle_state: LifecycleState;
  deprecated_since?: number;
  retired_since?: number;
  replacement_schema?: string;
}

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  [extension: `x-urdira-${string}`]: unknown;
}

export interface SchemaValidationContext {
  schemas?: readonly CanonicalSchemaDefinition[] | ReadonlyMap<string, CanonicalSchemaDefinition>;
  comparators?: readonly { comparator_id: string; comparator_version: number; sort_keys?: readonly { value_path: string; comparison_mode: string }[] }[];
  localDefinitions?: ReadonlyMap<string, CanonicalTypeExpression>;
}

export function toPublicName(canonicalName: string): string {
  return canonicalName.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

export function toCanonicalName(publicName: string): string {
  return publicName.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export function generateJsonSchema(schema: CanonicalSchemaDefinition): JsonSchema {
  validateSchemaDefinition(schema);
  const definitions: Record<string, JsonSchema> = {};
  for (const definition of schema.type_definitions) {
    definitions[definition.type_name] = {
      ...typeToJsonSchema(definition.type_expression, definitions),
      description: definition.description,
    };
  }
  const generated = typeToJsonSchema(schema.root_type, definitions);
  generated.$schema = "https://json-schema.org/draft/2020-12/schema";
  generated.$id = `${schema.schema_id}@${schema.schema_version}`;
  generated.description = schema.description;
  if (Object.keys(definitions).length > 0) generated.$defs = definitions;
  return generated;
}

function typeToJsonSchema(type: CanonicalTypeExpression, definitions: Record<string, JsonSchema>): JsonSchema {
  switch (type.type_kind) {
    case "null": return { type: "null" };
    case "boolean": return { type: "boolean" };
    case "safe_integer": return withBounds({ type: "integer" }, type.minimum, type.maximum);
    case "big_integer": return { type: "string", pattern: BIG_INTEGER_PATTERN.source, ...(type.minimum === undefined ? {} : { "x-urdira-big-integer-minimum": type.minimum }), ...(type.maximum === undefined ? {} : { "x-urdira-big-integer-maximum": type.maximum }) };
    case "float64": return withBounds({ type: "number" }, type.minimum, type.maximum);
    case "exact_decimal": return { type: "string", pattern: EXACT_DECIMAL_PATTERN.source, "x-urdira-exact-decimal-scale-policy": type.scale_policy, ...(type.minimum === undefined ? {} : { "x-urdira-exact-decimal-minimum": type.minimum }), ...(type.maximum === undefined ? {} : { "x-urdira-exact-decimal-maximum": type.maximum }) };
    case "text": return withBounds({ type: "string", ...(type.identifier_kind === "identifier" ? { pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" } : {}), ...(type.identifier_kind === "namespaced_identifier" ? { pattern: "^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$" } : {}), ...(type.identifier_kind === "semver" ? { pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$" } : {}) }, type.minimum_code_point_count, type.maximum_code_point_count, "length");
    case "bytes": {
      const minimumBytes = type.minimum_byte_length ?? (type.bound_schema_id_field === undefined ? undefined : 1);
      const minimumEncodedLength = minimumBytes === undefined || minimumBytes === 0 ? undefined : 10 + Math.ceil(minimumBytes * 8 / 6);
      return { type: "string", pattern: minimumEncodedLength === undefined ? "^base64url:[A-Za-z0-9_-]*$" : "^base64url:[A-Za-z0-9_-]+$", ...(minimumEncodedLength === undefined ? {} : { minLength: minimumEncodedLength }), ...(type.minimum_byte_length === undefined ? {} : { "x-urdira-minimum-byte-length": type.minimum_byte_length }), ...(type.maximum_byte_length === undefined ? {} : { "x-urdira-maximum-byte-length": type.maximum_byte_length }), ...(type.bound_schema_id_field === undefined ? {} : { "x-urdira-schema-bound-bytes": { schema_id_field: type.bound_schema_id_field, schema_version_field: type.bound_schema_version_field } }) };
    }
    case "timestamp": return { type: "string", pattern: TIMESTAMP_PATTERN.source, ...(type.earliest === undefined ? {} : { "x-urdira-timestamp-earliest": type.earliest }), ...(type.latest === undefined ? {} : { "x-urdira-timestamp-latest": type.latest }) };
    case "digest": return { type: "string", pattern: digestPattern(type.allowed_hash_algorithms).source };
    case "enum": return { type: "string", enum: [...type.values] };
    case "sequence": return collectionSchema(type, definitions);
    case "set": return collectionSchema(type, definitions);
    case "ordered_set": return collectionSchema(type, definitions);
    case "map": return {
      type: "object",
      additionalProperties: typeToJsonSchema(type.value_type, definitions),
      ...optionalBounds(type.minimum_entry_count, type.maximum_entry_count, "minProperties", "maxProperties"),
    };
    case "record": return recordSchema(type.fields, definitions);
    case "union": return {
      oneOf: type.variants.map((variant) => variantSchema(type.discriminator_field, type.discriminator_description, variant, definitions)),
    };
    case "schema_reference":
      if (type.type_name === "JsonValue" && type.schema_id === "core:JsonValue" && type.schema_version === 1) return jsonValueSchema();
      return { $ref: type.reference_scope === "local" || isAuthoritativeModelReference(type) ? `#/$defs/${type.type_name}` : `${type.schema_id ?? ""}#/$defs/${type.type_name}` };
  }
}

function jsonValueSchema(): JsonSchema {
  return { oneOf: [
    { type: "null" },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: {} },
  ] };
}

function collectionSchema(type: SequenceTypeExpression | SetTypeExpression | OrderedSetTypeExpression, definitions: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "array",
    items: typeToJsonSchema(type.element_type, definitions),
    ...(type.type_kind === "sequence" ? {} : { uniqueItems: true }),
    ...(type.type_kind === "ordered_set" ? { "x-urdira-ordered-set-comparator": { comparator_id: type.comparator_id, comparator_version: type.comparator_version } } : {}),
    ...optionalBounds(type.minimum_item_count, type.maximum_item_count, "minItems", "maxItems"),
  };
}

function recordSchema(fields: ReadonlyArray<SchemaFieldDefinition>, definitions: Record<string, JsonSchema>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[toPublicName(field.field_name)] = {
      ...typeToJsonSchema(field.value_type, definitions),
      description: field.description,
    };
    if (field.presence === "required") required.push(toPublicName(field.field_name));
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function variantSchema(discriminatorField: string, discriminatorDescription: string, variant: SchemaVariantDefinition, definitions: Record<string, JsonSchema>): JsonSchema {
  const schema = recordSchema(variant.fields, definitions);
  schema.properties = {
    [toPublicName(discriminatorField)]: { const: variant.discriminator_value, description: discriminatorDescription },
    ...schema.properties,
  };
  schema.required = [toPublicName(discriminatorField), ...(schema.required ?? [])];
  schema.description = variant.description;
  return schema;
}

function withBounds(schema: JsonSchema, minimum: number | undefined, maximum: number | undefined, mode: "length" | "value" = "value"): JsonSchema {
  if (mode === "length") {
    return { ...schema, ...(minimum === undefined ? {} : { minLength: minimum }), ...(maximum === undefined ? {} : { maxLength: maximum }) };
  }
  return { ...schema, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) };
}

function optionalBounds(minimum: number | undefined, maximum: number | undefined, minKey: "minItems" | "minProperties", maxKey: "maxItems" | "maxProperties"): JsonSchema {
  return { ...(minimum === undefined ? {} : { [minKey]: minimum }), ...(maximum === undefined ? {} : { [maxKey]: maximum }) };
}

export function validateSchemaValue(schema: CanonicalSchemaDefinition, value: unknown, context: SchemaValidationContext = {}): void {
  const scopedContext = { ...context, localDefinitions: new Map(schema.type_definitions.map((definition) => [definition.type_name, definition.type_expression])) };
  validateSchemaReferenceGraph([schema, ...contextSchemas(context).filter((candidate) => candidate.schema_id !== schema.schema_id)] , scopedContext);
  validateType(schema.root_type, value, "root", scopedContext, new Set());
}

export function validateSchemaDefinition(schema: CanonicalSchemaDefinition, context: SchemaValidationContext = {}): void {
  assertClosedObject(schema as unknown as Record<string, unknown>, ["schema_id", "definition_revision", "schema_version", "description", "root_type", "type_definitions", "plugin_owner", "lifecycle_state", "deprecated_since", "retired_since", "replacement_schema"], "schema");
  if (!schema.schema_id || !schema.description) fail("schema", "requires an identifier and description");
  if (!Number.isSafeInteger(schema.definition_revision) || schema.definition_revision < 1) fail("schema.definition_revision", "must be a positive safe integer");
  if (!Number.isSafeInteger(schema.schema_version) || schema.schema_version < 1) fail("schema.schema_version", "must be a positive safe integer");
  const names = new Set<string>();
  for (const definition of schema.type_definitions) {
    assertClosedObject(definition as unknown as Record<string, unknown>, ["type_name", "description", "type_expression"], `schema.type_definitions.${definition.type_name || "<unnamed>"}`);
    if (!definition.description) fail(`schema.type_definitions.${definition.type_name}`, "requires a description");
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(definition.type_name)) fail(`schema.type_definitions.${definition.type_name}`, "must be ASCII snake_case");
    if (names.has(definition.type_name)) fail(`schema.type_definitions.${definition.type_name}`, "duplicate named type");
    names.add(definition.type_name);
    validateTypeDefinition(definition.type_expression, `schema.type_definitions.${definition.type_name}`, context);
  }
  validateTypeDefinition(schema.root_type, "schema.root_type", context);
  validateLocalReferences(schema, context);
  if (schema.lifecycle_state === "active" && (schema.deprecated_since !== undefined || schema.retired_since !== undefined)) fail("schema.lifecycle_state", "active schema cannot have lifecycle markers");
  if (schema.lifecycle_state !== "active" && schema.deprecated_since === undefined) fail("schema.deprecated_since", "is required for deprecated or retired schemas");
  if (schema.lifecycle_state === "retired" && schema.retired_since === undefined) fail("schema.retired_since", "is required for retired schemas");
}

function validateTypeDefinition(type: CanonicalTypeExpression, path: string, context: SchemaValidationContext = {}): void {
  if (!type || typeof type !== "object" || typeof (type as { type_kind?: unknown }).type_kind !== "string") fail(path, "requires a recognized type_kind");
  const allowedByKind: Record<CanonicalTypeExpression["type_kind"], readonly string[]> = {
    null: ["type_kind"], boolean: ["type_kind"], safe_integer: ["type_kind", "minimum", "maximum"], big_integer: ["type_kind", "minimum", "maximum"],
    float64: ["type_kind", "minimum", "maximum"], exact_decimal: ["type_kind", "minimum", "maximum", "scale_policy"], text: ["type_kind", "identifier_kind", "minimum_code_point_count", "maximum_code_point_count"],
    bytes: ["type_kind", "minimum_byte_length", "maximum_byte_length", "bound_schema_id_field", "bound_schema_version_field"], timestamp: ["type_kind", "earliest", "latest"], digest: ["type_kind", "allowed_hash_algorithms"],
    enum: ["type_kind", "values"], sequence: ["type_kind", "element_type", "minimum_item_count", "maximum_item_count"], set: ["type_kind", "element_type", "minimum_item_count", "maximum_item_count"],
    ordered_set: ["type_kind", "element_type", "comparator_id", "comparator_version", "minimum_item_count", "maximum_item_count"], map: ["type_kind", "value_type", "minimum_entry_count", "maximum_entry_count"],
    record: ["type_kind", "fields"], union: ["type_kind", "discriminator_field", "discriminator_description", "variants"], schema_reference: ["type_kind", "reference_scope", "type_name", "schema_id", "schema_version"],
  };
  assertClosedObject(type as unknown as Record<string, unknown>, allowedByKind[type.type_kind], path);
  switch (type.type_kind) {
    case "safe_integer": checkOptionalNumericBounds(type.minimum, type.maximum, path); return;
    case "float64": if (type.minimum !== undefined && !Number.isFinite(type.minimum) || type.maximum !== undefined && !Number.isFinite(type.maximum)) fail(path, "bounds must be finite"); checkOptionalValueBounds(type.minimum, type.maximum, path); return;
    case "big_integer": validateBigIntegerDefinitionBounds(type.minimum, type.maximum, path); return;
    case "exact_decimal":
      if (type.scale_policy !== "significant" && type.scale_policy !== "insignificant") fail(path, "scale_policy must be significant or insignificant");
      validateDecimalDefinitionBounds(type.minimum, type.maximum, path); return;
    case "text": if (type.identifier_kind !== undefined && !["identifier", "namespaced_identifier", "semver", "uri"].includes(type.identifier_kind)) fail(path, "identifier_kind is not registered"); checkOptionalBounds(type.minimum_code_point_count, type.maximum_code_point_count, path); return;
    case "bytes":
      checkOptionalBounds(type.minimum_byte_length, type.maximum_byte_length, path);
      if ((type.bound_schema_id_field === undefined) !== (type.bound_schema_version_field === undefined)) fail(path, "schema-bound bytes requires both coordinate fields");
      if (type.bound_schema_id_field !== undefined && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(type.bound_schema_id_field)) fail(path, "bound schema id field must be snake_case");
      if (type.bound_schema_version_field !== undefined && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(type.bound_schema_version_field)) fail(path, "bound schema version field must be snake_case");
      return;
    case "timestamp": if (type.earliest !== undefined) validateTimestamp(type.earliest, path); if (type.latest !== undefined) validateTimestamp(type.latest, path); if (type.earliest !== undefined && type.latest !== undefined && type.earliest > type.latest) fail(path, "earliest exceeds latest"); return;
    case "digest": if (new Set(type.allowed_hash_algorithms).size !== type.allowed_hash_algorithms.length || type.allowed_hash_algorithms.length === 0 || type.allowed_hash_algorithms.some((algorithm) => !DIGEST_LENGTHS[algorithm])) fail(path, "requires allowed registered hash algorithms"); return;
    case "enum": if (new Set(type.values).size !== type.values.length || type.values.length === 0) fail(path, "requires a non-empty unique enum set"); return;
    case "sequence": case "set": case "ordered_set":
      checkOptionalBounds(type.minimum_item_count, type.maximum_item_count, path);
      if (type.type_kind === "ordered_set" && (!type.comparator_id || type.comparator_version < 1)) fail(path, "requires a comparator identifier and positive version");
      if (type.type_kind === "ordered_set") {
        const comparator = findComparator(type.comparator_id, type.comparator_version, context);
        if (!comparator) fail(path, `references unknown comparator ${type.comparator_id}@${type.comparator_version}`);
        validateComparatorCompatibility(type.element_type, comparator.sort_keys ?? [], path, context);
      }
      validateTypeDefinition(type.element_type, `${path}.element_type`, context); return;
    case "map": checkOptionalBounds(type.minimum_entry_count, type.maximum_entry_count, path); validateTypeDefinition(type.value_type, `${path}.value_type`, context); return;
    case "record": validateFields(type.fields, path, context); return;
    case "union":
      if (!type.discriminator_field || !type.discriminator_description || type.variants.length === 0) fail(path, "requires a discriminator, description, and variants");
      if (new Set(type.variants.map((variant) => variant.discriminator_value)).size !== type.variants.length) fail(path, "has duplicate discriminator values");
      for (const variant of type.variants) {
        assertClosedObject(variant as unknown as Record<string, unknown>, ["discriminator_value", "description", "fields"], `${path}.variants.${variant.discriminator_value || "<unnamed>"}`);
        if (!variant.description) fail(`${path}.variants.${variant.discriminator_value}`, "requires a description");
        if (variant.fields.some((field) => field.field_name === type.discriminator_field)) fail(`${path}.${type.discriminator_field}`, "variant cannot redeclare discriminator field");
        validateFields(variant.fields, `${path}.${type.discriminator_field}`, context);
      }
      return;
    case "schema_reference":
      if (type.reference_scope !== "local" && type.reference_scope !== "external") fail(path, "reference_scope must be local or external");
      if (!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(type.type_name)) fail(path, "requires a valid type name");
      if (type.reference_scope === "local" && (type.schema_id !== undefined || type.schema_version !== undefined)) fail(path, "local reference cannot specify external coordinates");
      if (type.reference_scope === "external" && (type.schema_id === undefined || !type.schema_id || type.schema_version === undefined || !Number.isSafeInteger(type.schema_version) || type.schema_version < 1)) fail(path, "external reference requires valid schema coordinates");
      return;
    case "null": case "boolean": return;
  }
}

function validateFields(fields: ReadonlyArray<SchemaFieldDefinition>, path: string, context: SchemaValidationContext = {}): void {
  const names = new Set<string>();
  for (const field of fields) {
    assertClosedObject(field as unknown as Record<string, unknown>, ["field_name", "description", "presence", "value_type"], `${path}.${field.field_name || "<unnamed>"}`);
    if (names.has(field.field_name)) fail(`${path}.${field.field_name}`, "duplicate field");
    names.add(field.field_name);
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(field.field_name)) fail(`${path}.${field.field_name}`, "must be ASCII snake_case");
    if (!field.description) fail(`${path}.${field.field_name}`, "requires a description");
    if (field.presence !== "required" && field.presence !== "optional") fail(`${path}.${field.field_name}.presence`, "must be required or optional");
    validateTypeDefinition(field.value_type, `${path}.${field.field_name}`, context);
  }
  for (const field of fields) {
    const bytesType = field.value_type.type_kind === "bytes" ? field.value_type : undefined;
    if (!bytesType?.bound_schema_id_field) continue;
    const idIndex = fields.findIndex((candidate) => candidate.field_name === bytesType.bound_schema_id_field);
    const versionIndex = fields.findIndex((candidate) => candidate.field_name === bytesType.bound_schema_version_field);
    const fieldIndex = fields.indexOf(field);
    if (idIndex < 0 || versionIndex < 0 || idIndex !== fieldIndex - 2 || versionIndex !== fieldIndex - 1) fail(`${path}.${field.field_name}`, "SchemaBoundBytes coordinates must be adjacent fields immediately before the bytes field");
    const idField = fields[idIndex];
    const versionField = fields[versionIndex];
    if (idField?.presence !== "required" || versionField?.presence !== "required") fail(`${path}.${field.field_name}`, "SchemaBoundBytes coordinate fields must be required");
    if (idField?.value_type.type_kind !== "text" || idField.value_type.identifier_kind !== "namespaced_identifier") fail(`${path}.${bytesType.bound_schema_id_field}`, "SchemaBoundBytes schema id coordinate must be a NamespacedIdentifier");
    if (versionField?.value_type.type_kind !== "safe_integer" || (versionField.value_type.minimum ?? 0) < 1) fail(`${path}.${bytesType.bound_schema_version_field}`, "SchemaBoundBytes schema version coordinate must be a positive safe integer");
  }
}

function checkOptionalBounds(minimum: number | undefined, maximum: number | undefined, path: string): void {
  if (minimum !== undefined && (!Number.isSafeInteger(minimum) || minimum < 0)) fail(path, "minimum must be a non-negative safe integer");
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) fail(path, "maximum must be a non-negative safe integer");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "minimum exceeds maximum");
}

function checkOptionalNumericBounds(minimum: number | undefined, maximum: number | undefined, path: string): void {
  if (minimum !== undefined && (!Number.isSafeInteger(minimum))) fail(path, "minimum must be a safe integer");
  if (maximum !== undefined && (!Number.isSafeInteger(maximum))) fail(path, "maximum must be a safe integer");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "minimum exceeds maximum");
}

function checkOptionalValueBounds(minimum: number | undefined, maximum: number | undefined, path: string): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(path, "minimum exceeds maximum");
}

function validateType(type: CanonicalTypeExpression, value: unknown, path: string, context: SchemaValidationContext, activeReferences: Set<string>): void {
  switch (type.type_kind) {
    case "null": if (value !== null) fail(path, "must be null"); return;
    case "boolean": if (typeof value !== "boolean") fail(path, "must be boolean"); return;
    case "safe_integer": if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "must be a safe integer"); checkNumberBounds(type, value, path); return;
    case "big_integer": if (typeof value !== "bigint" && !(typeof value === "string" && BIG_INTEGER_PATTERN.test(value))) fail(path, "must be a BigInteger"); if (typeof value === "string") checkBigIntegerBounds(type, value, path); return;
    case "float64": if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be finite Float64"); checkNumberBounds(type, value, path); return;
    case "exact_decimal": if (typeof value !== "string" || !EXACT_DECIMAL_PATTERN.test(value)) fail(path, "must be an ExactDecimal"); validateDecimalValue(type, value, path); return;
    case "text": if (typeof value !== "string") fail(path, "must be text"); validateConstrainedText(type, value, path); return;
    case "bytes": { const length = byteLength(value); if (type.bound_schema_id_field !== undefined && length < 1) fail(path, "SchemaBoundBytes must contain at least one byte"); checkCountBounds(type.minimum_byte_length, type.maximum_byte_length, length, path); return; }
    case "timestamp": if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) fail(path, "must be a timestamp"); validateTimestamp(value, path); if (type.earliest !== undefined && value < type.earliest) fail(path, "is before earliest"); if (type.latest !== undefined && value > type.latest) fail(path, "is after latest"); return;
    case "digest": if (typeof value !== "string" || !digestPattern(type.allowed_hash_algorithms).test(value)) fail(path, "must be an allowed digest"); return;
    case "enum": if (typeof value !== "string" || !type.values.includes(value)) fail(path, "must be a registered enum value"); return;
    case "sequence": case "set": case "ordered_set": validateCollection(type, value, path, context, activeReferences); return;
    case "map": validateMap(type, value, path, context, activeReferences); return;
    case "record": validateRecord(type.fields, value, path, context, activeReferences); return;
    case "union": validateUnion(type, value, path, context, activeReferences); return;
    case "schema_reference": {
      if (type.reference_scope === "external" && type.type_name === "JsonValue" && type.schema_id === "core:JsonValue" && type.schema_version === 1) {
        validateJsonValue(value, path);
        return;
      }
      if (type.reference_scope === "external" && type.schema_id === `core:${type.type_name}` && authoritativeModelNames.includes(type.type_name as (typeof authoritativeModelNames)[number])) {
        validateModelReferenceValue(type.type_name, value, path, context);
        return;
      }
      const referenceKey = referenceKeyFor(type);
      if (activeReferences.has(referenceKey)) fail(path, `reference cycle at ${referenceKey}`);
      const target = resolveReferenceType(type, context);
      const next = new Set(activeReferences); next.add(referenceKey);
      const targetSchema = type.reference_scope === "external" ? resolveExternalSchema(type, context) : undefined;
      const targetContext = targetSchema
        ? { ...context, localDefinitions: new Map(targetSchema.type_definitions.map((definition) => [definition.type_name, definition.type_expression])) }
        : context;
      validateType(target, value, path, targetContext, next);
      return;
    }
  }
}

function validateModelReferenceValue(typeName: string, value: unknown, path: string, context: SchemaValidationContext, allowStageOutput = false): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, `must be the closed ${typeName} model object`);
  const object = value as Record<string, unknown>;
  if (typeName === "CanonicalTypeExpression") {
    validateCanonicalTypeExpressionModel(object, path, context);
    return;
  }
  if (typeName === "QueryExpression") {
    validateQueryExpressionModel(object, path, context);
    return;
  }
  if (typeName === "VisibleSourceStateEntry") {
    const stateType = object["state_kind"];
    if (stateType === "present") {
      requireModelFields(object, ["state_kind", "workspace_id", "artifact_id", "normalized_uri", "artifact_kind", "artifact_version_id", "content_hash", "byte_length", "encoding", "analysis_metadata_digest", "valid_from_generation"], path);
      rejectUnknownModelFields(object, ["state_kind", "workspace_id", "artifact_id", "normalized_uri", "artifact_kind", "artifact_version_id", "content_hash", "byte_length", "encoding", "language_hint", "analysis_metadata_digest", "valid_from_generation"], path);
      if (typeof object["byte_length"] !== "number" || !Number.isSafeInteger(object["byte_length"]) || Number(object["byte_length"]) < 0) fail(`${path}.byte_length`, "must be a non-negative safe integer");
      return;
    }
    if (stateType === "absent") {
      requireModelFields(object, ["state_kind", "workspace_id", "artifact_id", "normalized_uri", "artifact_tombstone_id", "absence_kind", "absence_reason_code", "valid_from_generation"], path);
      rejectUnknownModelFields(object, ["state_kind", "workspace_id", "artifact_id", "normalized_uri", "artifact_tombstone_id", "absence_kind", "absence_reason_code", "last_artifact_version_id", "valid_from_generation"], path);
      if (object["absence_kind"] !== "deleted" && object["absence_kind"] !== "excluded") fail(`${path}.absence_kind`, "must be deleted or excluded");
      return;
    }
    fail(`${path}.state_kind`, "must be present or absent");
  }
  if (["DefinitionMatcher", "SubjectSelector", "StructuralFilter", "RelationSelector", "RegistrySelector", "KindSelector", "RecordStructuralSelector", "ChangeDescriptor"].includes(typeName)) {
    validatePublicQueryModel(typeName, object, path, context, allowStageOutput);
    return;
  }
  const model = modelContractRegistry.find((candidate) => candidate.name === typeName);
  if (!model) fail(path, `missing authoritative model definition for ${typeName}`);
  const fields = model.fields.map((field) => field.name);
  requireModelFields(object, model.fields.filter((field) => field.presence === "required").map((field) => field.name), path);
  rejectUnknownModelFields(object, fields, path);
  for (const field of model.fields) {
    if (!(field.name in object)) continue;
    if (field.logical_type === "SchemaBoundBytes") validateModelSchemaBoundCoordinates(typeName, field.name, object, path, field.schema_bound_coordinates);
    if (field.minimum_item_count !== undefined && (!Array.isArray(object[field.name]) || (object[field.name] as unknown[]).length < field.minimum_item_count)) fail(`${path}.${field.name}`, "is below the authoritative minimum item count");
    validateType(logicalTypeExpression(field.logical_type), object[field.name], `${path}.${field.name}`, context, new Set());
  }
}

const canonicalTypeModelFields: Readonly<Record<string, readonly string[]>> = {
  null: ["type_kind"], boolean: ["type_kind"], safe_integer: ["type_kind", "minimum", "maximum"], big_integer: ["type_kind", "minimum", "maximum"],
  float64: ["type_kind", "minimum", "maximum"], exact_decimal: ["type_kind", "minimum", "maximum", "scale_policy"],
  text: ["type_kind", "identifier_kind", "minimum_code_point_count", "maximum_code_point_count"], bytes: ["type_kind", "minimum_byte_length", "maximum_byte_length", "bound_schema_id_field", "bound_schema_version_field"],
  timestamp: ["type_kind", "earliest", "latest"], digest: ["type_kind", "allowed_hash_algorithms"], enum: ["type_kind", "values"],
  sequence: ["type_kind", "element_type", "minimum_item_count", "maximum_item_count"], set: ["type_kind", "element_type", "minimum_item_count", "maximum_item_count"],
  ordered_set: ["type_kind", "element_type", "comparator_id", "comparator_version", "minimum_item_count", "maximum_item_count"], map: ["type_kind", "value_type", "minimum_entry_count", "maximum_entry_count"],
  record: ["type_kind", "fields"], union: ["type_kind", "discriminator_field", "discriminator_description", "variants"],
  schema_reference: ["type_kind", "reference_scope", "type_name", "schema_id", "schema_version"],
};
const canonicalTypeRequiredFields: Readonly<Record<string, readonly string[]>> = {
  null: ["type_kind"], boolean: ["type_kind"], safe_integer: ["type_kind"], big_integer: ["type_kind"], float64: ["type_kind"],
  exact_decimal: ["type_kind", "scale_policy"], text: ["type_kind"], bytes: ["type_kind"], timestamp: ["type_kind"], digest: ["type_kind", "allowed_hash_algorithms"], enum: ["type_kind", "values"],
  sequence: ["type_kind", "element_type"], set: ["type_kind", "element_type"], ordered_set: ["type_kind", "element_type", "comparator_id", "comparator_version"], map: ["type_kind", "value_type"],
  record: ["type_kind", "fields"], union: ["type_kind", "discriminator_field", "discriminator_description", "variants"], schema_reference: ["type_kind", "reference_scope", "type_name"],
};

function validateCanonicalTypeExpressionModel(object: Record<string, unknown>, path: string, context: SchemaValidationContext): void {
  const kind = object["type_kind"];
  if (typeof kind !== "string") fail(`${path}.type_kind`, "must be a registered canonical type kind");
  const allowedFields = canonicalTypeModelFields[kind];
  const requiredFields = canonicalTypeRequiredFields[kind];
  if (!allowedFields || !requiredFields) fail(`${path}.type_kind`, "must be a registered canonical type kind");
  requireModelFields(object, requiredFields, path);
  rejectUnknownModelFields(object, allowedFields, path);
  if (kind === "exact_decimal" && object["scale_policy"] !== "significant" && object["scale_policy"] !== "insignificant") fail(`${path}.scale_policy`, "must be significant or insignificant");
  if (kind === "text" && object["identifier_kind"] !== undefined && !["identifier", "namespaced_identifier", "semver", "uri"].includes(String(object["identifier_kind"]))) fail(`${path}.identifier_kind`, "must be a registered identifier kind");
  if (kind === "digest") {
    const algorithms = object["allowed_hash_algorithms"];
    if (!Array.isArray(algorithms) || algorithms.length === 0 || algorithms.some((algorithm) => algorithm !== "sha256")) fail(`${path}.allowed_hash_algorithms`, "must be a non-empty list of allowed digest algorithms");
  }
  if (kind === "enum") {
    if (!Array.isArray(object["values"]) || object["values"].length === 0 || object["values"].some((item) => typeof item !== "string")) fail(`${path}.values`, "must be a non-empty list of strings");
  }
  if (["sequence", "set", "ordered_set"].includes(kind)) validateCanonicalTypeExpressionModel(object["element_type"] as Record<string, unknown>, `${path}.element_type`, context);
  if (kind === "map") validateCanonicalTypeExpressionModel(object["value_type"] as Record<string, unknown>, `${path}.value_type`, context);
  if (kind === "record") {
    if (!Array.isArray(object["fields"])) fail(`${path}.fields`, "must be an array");
    validateSchemaFieldModels(object["fields"] as unknown[], `${path}.fields`, context);
  }
  if (kind === "union") {
    if (typeof object["discriminator_field"] !== "string" || !SNAKE_CASE_FIELD_PATTERN.test(object["discriminator_field"]) || typeof object["discriminator_description"] !== "string" || object["discriminator_description"] === "") fail(path, "has an invalid union discriminator definition");
    if (!Array.isArray(object["variants"]) || object["variants"].length === 0) fail(`${path}.variants`, "must be non-empty");
    const discriminatorValues = new Set<string>();
    for (const [index, variant] of (object["variants"] as unknown[]).entries()) {
      if (variant === null || typeof variant !== "object" || Array.isArray(variant)) fail(`${path}.variants[${index}]`, "must be a closed variant object");
      const candidate = variant as Record<string, unknown>;
      requireModelFields(candidate, ["discriminator_value", "description", "fields"], `${path}.variants[${index}]`);
      rejectUnknownModelFields(candidate, ["discriminator_value", "description", "fields"], `${path}.variants[${index}]`);
      if (typeof candidate["discriminator_value"] !== "string" || candidate["discriminator_value"].length === 0) fail(`${path}.variants[${index}].discriminator_value`, "must be non-empty");
      if (discriminatorValues.has(candidate["discriminator_value"])) fail(`${path}.variants[${index}].discriminator_value`, "duplicate discriminator value");
      discriminatorValues.add(candidate["discriminator_value"]);
      if (typeof candidate["description"] !== "string" || candidate["description"].length === 0) fail(`${path}.variants[${index}].description`, "must be non-empty");
      if (!Array.isArray(candidate["fields"])) fail(`${path}.variants[${index}].fields`, "must be an array");
      validateSchemaFieldModels(candidate["fields"] as unknown[], `${path}.variants[${index}].fields`, context, object["discriminator_field"] as string);
    }
  }
  if (kind === "schema_reference") {
    if (object["reference_scope"] !== "local" && object["reference_scope"] !== "external") fail(`${path}.reference_scope`, "must be local or external");
    if (typeof object["type_name"] !== "string" || object["type_name"].length === 0) fail(`${path}.type_name`, "must be non-empty");
    if (object["reference_scope"] === "external" && (typeof object["schema_id"] !== "string" || !Number.isSafeInteger(object["schema_version"]))) fail(path, "external reference requires schema coordinates");
  }
}

function validateSchemaFieldModels(values: unknown[], path: string, context: SchemaValidationContext, discriminatorField?: string): void {
  const names = new Set<string>();
  for (const [index, value] of values.entries()) {
    const fieldPath = `${path}[${index}]`;
    validateSchemaFieldModel(value, fieldPath, context, discriminatorField);
    const name = (value as Record<string, unknown>)["field_name"];
    if (typeof name === "string") {
      if (names.has(name)) fail(`${fieldPath}.field_name`, "duplicate field");
      names.add(name);
    }
  }
}

function validateSchemaFieldModel(value: unknown, path: string, context: SchemaValidationContext, discriminatorField?: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a SchemaFieldDefinition object");
  const field = value as Record<string, unknown>;
  requireModelFields(field, ["field_name", "description", "presence", "value_type"], path);
  rejectUnknownModelFields(field, ["field_name", "description", "presence", "value_type"], path);
  if (typeof field["field_name"] !== "string" || !SNAKE_CASE_FIELD_PATTERN.test(field["field_name"])) fail(`${path}.field_name`, "must be ASCII snake_case");
  if (discriminatorField !== undefined && field["field_name"] === discriminatorField) fail(`${path}.field_name`, "must not redeclare the enclosing union discriminator");
  if (typeof field["description"] !== "string" || field["description"].length === 0) fail(`${path}.description`, "must be non-empty");
  if (field["presence"] !== "required" && field["presence"] !== "optional") fail(`${path}.presence`, "must be required or optional");
  if (field["value_type"] === null || typeof field["value_type"] !== "object" || Array.isArray(field["value_type"])) fail(`${path}.value_type`, "must be a canonical type expression");
  validateCanonicalTypeExpressionModel(field["value_type"] as Record<string, unknown>, `${path}.value_type`, context);
}

export const queryAlgebraOperatorIds = [
  "source.operation", "source.registry", "set.union", "set.intersection", "set.difference",
  "expand.relations", "expand.operation", "filter", "join", "deduplicate", "select",
  "bind.record_selector", "bind.subject_record_selector",
] as const;
const registeredQueryOperators = new Set<string>(queryAlgebraOperatorIds);

interface QueryStageValidationResult {
  readonly operator: string;
  readonly outputNames?: readonly string[];
}

interface PipelineStageOutputInfo {
  readonly index: number;
  readonly operator: string;
  readonly outputs?: readonly string[];
}

function modelNameFromSchemaId(schemaId: string): string {
  const modelName = schemaId.replace(/^core:/, "");
  if (!modelContractRegistry.some((model) => model.name === modelName)) throw new Error(`Missing authoritative argument model ${modelName}`);
  return modelName;
}

/**
 * Validates a `SubjectSelector`-typed field whose PUBLIC contract narrows
 * the legal `subject_type` values to a subset (`ReferenceTargetSelector`'s
 * `entity | record | symbol`, `OutlineContainerSelector`'s
 * `artifact | entity | record`) -- narrower than the full 5-variant
 * `SubjectSelector` union. `allowStageOutput` (threaded from the same flag
 * every other `SubjectSelector`-typed field already honors, see
 * `validateOperationArgumentValue`'s plain `"SubjectSelector"` branch) was
 * previously NOT forwarded here, which made `stage_output` selectors
 * unconditionally illegal on `target`/`container`-shaped fields even inside
 * a pipeline -- `core:find_references.target` and `core:get_outline.container`
 * could never bind a prior stage's output, contrary to the documented
 * "`stage_output` is legal only in pipeline arguments" rule (which says
 * "only in pipeline arguments", not "never on these two fields"). A
 * `stage_output` selector's real subject_type is unknowable until the
 * referenced stage actually runs, so it bypasses the subset check entirely
 * here exactly as it bypasses the 4-variant check on a plain
 * `SubjectSelector` field.
 */
function validateSubjectSelectorSubset(value: unknown, path: string, context: SchemaValidationContext, allowedTypes: readonly string[], allowStageOutput = false): void {
  validateModelReferenceValue("SubjectSelector", value, path, context, allowStageOutput);
  const subjectType = (value as Record<string, unknown>)["subject_type"];
  if (allowStageOutput && subjectType === "stage_output") return;
  if (!allowedTypes.includes(String(subjectType))) fail(`${path}.subject_type`, "is not allowed by this operation selector");
}

function validateSourceIncludeOptions(value: unknown, path: string, requireContent: boolean): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a closed SourceIncludeOptions object");
  const object = value as Record<string, unknown>;
  requireModelFields(object, ["mode", "max_characters_per_snippet", "max_total_characters", "context_lines"], path);
  rejectUnknownModelFields(object, ["mode", "max_characters_per_snippet", "max_total_characters", "context_lines"], path);
  if (!["none", "signature", "relevant", "body"].includes(String(object["mode"]))) fail(`${path}.mode`, "must be a registered source mode");
  if (requireContent && object["mode"] === "none") fail(`${path}.mode`, "must request a source projection");
  for (const name of ["max_characters_per_snippet", "max_total_characters", "context_lines"]) if (!Number.isSafeInteger(object[name]) || Number(object[name]) < 0) fail(`${path}.${name}`, "must be a non-negative safe integer");
}

function validateOperationArgumentValue(operationId: string, fieldName: string, logicalType: string, value: unknown, path: string, context: SchemaValidationContext, allowStageOutput = false): void {
  if (logicalType === "OutlineContainerSelector") { validateSubjectSelectorSubset(value, path, context, ["artifact", "entity", "record"], allowStageOutput); return; }
  if (logicalType === "ReferenceTargetSelector") { validateSubjectSelectorSubset(value, path, context, ["entity", "record", "symbol"], allowStageOutput); return; }
  if (logicalType === "SourceIncludeOptions") { validateSourceIncludeOptions(value, path, operationId === "core:get_source"); return; }
  const sequence = logicalType.match(/^Sequence<(.+)>$/);
  if (sequence && Array.isArray(value)) {
    for (const [index, item] of value.entries()) validateOperationArgumentValue(operationId, fieldName, sequence[1] ?? "", item, `${path}[${index}]`, context, allowStageOutput);
    return;
  }
  if (sequence && !Array.isArray(value)) fail(path, "must be an array");
  if (logicalType === "SubjectSelector") { validateModelReferenceValue("SubjectSelector", value, path, context, allowStageOutput); return; }
  if (["DefinitionMatcher", "RecordStructuralSelector", "KindSelector", "StructuralFilter", "RelationSelector", "RegistrySelector", "ChangeDescriptor"].includes(logicalType)) { validateModelReferenceValue(logicalType, value, path, context); return; }
  validateType(logicalTypeExpression(logicalType), value, path, context, new Set());
}

function validateInlineOperationArguments(operation: NonNullable<typeof operationDefinitions[number]>, argumentsValue: unknown, argumentPath: string, context: SchemaValidationContext, omittedField?: string, allowStageOutput = false): void {
  if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) fail(argumentPath, "must be a closed operation argument object");
  const object = argumentsValue as Record<string, unknown>;
  const fields = operation.argument_fields.filter((field) => field.name !== omittedField);
  requireModelFields(object, fields.filter((field) => field.presence === "required").map((field) => field.name), argumentPath);
  rejectUnknownModelFields(object, fields.map((field) => field.name), argumentPath);
  for (const field of fields) {
    if (!(field.name in object)) continue;
    const fieldValue = object[field.name];
    if (field.minimum_item_count !== undefined && (!Array.isArray(fieldValue) || fieldValue.length < field.minimum_item_count)) fail(`${argumentPath}.${field.name}`, "must satisfy the authoritative minimum item count");
    if (operation.operation_id === "core:resolve_symbol" && field.name === "reference" && (typeof fieldValue !== "string" || fieldValue.length === 0)) fail(`${argumentPath}.reference`, "must be non-empty");
    if (operation.operation_id === "core:resolve_symbol" && field.name === "context_byte_offset" && !("context_artifact" in object)) fail(`${argumentPath}.context_artifact`, "is required when context_byte_offset is present");
    if (operation.operation_id === "core:inspect_architecture" && field.name === "scope" && Array.isArray(fieldValue) && fieldValue.length === 0) fail(`${argumentPath}.scope`, "must be non-empty when present");
    if (operation.operation_id === "core:compare" && field.name === "selection" && Array.isArray(fieldValue) && fieldValue.length === 0) fail(`${argumentPath}.selection`, "must be non-empty when present");
    validateOperationArgumentValue(operation.operation_id, field.name, field.logical_type, fieldValue, `${argumentPath}.${field.name}`, context, allowStageOutput);
  }
}

function validateRegisteredOperationArguments(operationId: unknown, argumentsValue: unknown, argumentPath: string, context: SchemaValidationContext, omittedField?: string, allowStageOutput = false): { operation: NonNullable<typeof operationDefinitions[number]>; } {
  if (typeof operationId !== "string" || operationId.length === 0) fail(`${argumentPath}.operation`, "must be a non-empty registered operation identifier");
  const operation = operationDefinitions.find((candidate) => candidate.operation_id === operationId);
  if (!operation) fail(`${argumentPath}.operation`, "must name a registered core operation");
  validateInlineOperationArguments(operation, argumentsValue, argumentPath, context, omittedField, allowStageOutput);
  return { operation };
}

const predicateLeafNames = new Set(["path", "language", "namespace", "subject_type", "kind", "facet", "evidence_class", "confidence", "completeness", "participant_role"]);
const predicateLeafEnums: Readonly<Record<string, readonly string[]>> = {
  subject_type: ["entity", "record", "artifact", "symbol"],
  evidence_class: ["confirmed", "possible", "both"],
  confidence: ["high", "medium", "low"],
  completeness: ["complete", "partial", "unknown", "unsupported", "stale"],
};

/**
 * Deep-walks a `source.operation`/`expand.operation` stage's
 * `operation_arguments` for embedded `{subject_type: "stage_output", ...}`
 * selectors (they may appear anywhere -- alone as a scalar field value, or
 * as one element of a `Sequence<SubjectSelector>` array field) and checks
 * each one against `availableStageOutputs`, the EARLIER-stages-only map
 * `validateQueryExpressionModel`'s pipeline loop already threads through
 * for exactly this purpose (`select`'s own `input` field already uses it
 * the same way just above). Before this, a `stage_output` selector's shape
 * was checked (`stage_id`/`output` are non-empty strings, via
 * `validateModelReferenceValue`'s `StageOutputSubjectSelector` variant) but
 * never its REFERENT -- a typo'd or forward-referencing `stage_id`, or an
 * `output` the referenced stage never declares, passed validation and
 * would only surface (if at all) as an empty stream deep in execution. The
 * two failure messages intentionally reuse the exact wording
 * `validateQueryExpressionModel`'s own `stages[].inputs[]` check uses
 * ("must reference an earlier pipeline stage" / "is not a registered
 * output of the referenced stage") so `validatePipelineContract`'s
 * substring-based error-code mapping in `query-plan.ts` classifies both as
 * `core:stage_reference_invalid` without needing a third substring.
 */
function validateStageOutputCrossReferences(value: unknown, path: string, availableStageOutputs: ReadonlyMap<string, PipelineStageOutputInfo>): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateStageOutputCrossReferences(entry, `${path}[${index}]`, availableStageOutputs));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (object["subject_type"] === "stage_output") {
    const stageId = String(object["stage_id"] ?? "");
    const target = availableStageOutputs.get(stageId);
    if (!target) fail(`${path}.stage_id`, "must reference an earlier pipeline stage");
    const output = String(object["output"] ?? "");
    if (target.outputs !== undefined && !target.outputs.includes(output)) fail(`${path}.output`, "is not a registered output of the referenced stage");
    return;
  }
  for (const [key, entry] of Object.entries(object)) validateStageOutputCrossReferences(entry, `${path}.${key}`, availableStageOutputs);
}

function validatePipelinePredicate(value: unknown, path: string, depth = 0): void {
  if (depth > 32) fail(path, "exceeds the registered predicate recursion limit");
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a closed predicate object");
  const predicate = value as Record<string, unknown>;
  const keys = Object.keys(predicate);
  if (keys.length !== 1) fail(path, "must contain exactly one registered predicate variant");
  const variant = keys[0];
  if (variant === "all" || variant === "any") {
    if (!Array.isArray(predicate[variant]) || predicate[variant].length === 0) fail(`${path}.${variant}`, "must be a non-empty predicate array");
    for (const [index, child] of (predicate[variant] as unknown[]).entries()) validatePipelinePredicate(child, `${path}.${variant}[${index}]`, depth + 1);
    return;
  }
  if (variant === "not") {
    validatePipelinePredicate(predicate["not"], `${path}.not`, depth + 1);
    return;
  }
  if (!variant || !predicateLeafNames.has(variant)) fail(`${path}.${variant ?? "<missing>"}`, "is not a registered predicate variant");
  if (!Array.isArray(predicate[variant]) || predicate[variant].length === 0 || (predicate[variant] as unknown[]).some((item) => typeof item !== "string" || item.length === 0)) fail(`${path}.${variant}`, "must be a non-empty array of non-empty values");
  const allowed = predicateLeafEnums[variant];
  if (allowed && (predicate[variant] as string[]).some((item) => !allowed.includes(item))) fail(`${path}.${variant}`, "contains an unknown registered value");
}

function validatePipelineOperatorArguments(operator: string, argumentsValue: unknown, path: string, context: SchemaValidationContext, availableStageOutputs?: ReadonlyMap<string, PipelineStageOutputInfo>): readonly string[] | undefined {
  if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) fail(`${path}.arguments`, "must be a closed operator argument object");
  const args = argumentsValue as Record<string, unknown>;
  if (operator === "source.operation") {
    requireModelFields(args, ["operation", "operation_arguments"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["operation", "operation_arguments"], `${path}.arguments`);
    const selected = validateRegisteredOperationArguments(args["operation"], args["operation_arguments"], `${path}.arguments.operation_arguments`, context, undefined, true);
    validateStageOutputCrossReferences(args["operation_arguments"], `${path}.arguments.operation_arguments`, availableStageOutputs ?? new Map());
    return selected.operation.result_streams;
  }
  if (operator === "source.registry") {
    requireModelFields(args, ["matcher"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["matcher", "selector", "include_full_definitions"], `${path}.arguments`);
    validateModelReferenceValue("DefinitionMatcher", args["matcher"], `${path}.arguments.matcher`, context);
    if (args["selector"] !== undefined) validateModelReferenceValue("RegistrySelector", args["selector"], `${path}.arguments.selector`, context);
    if (args["include_full_definitions"] !== undefined && typeof args["include_full_definitions"] !== "boolean") fail(`${path}.arguments.include_full_definitions`, "must be boolean");
    return ["definitions", "definition_set"];
  }
  if (["set.union", "set.intersection", "set.difference"].includes(operator)) {
    rejectUnknownModelFields(args, [], `${path}.arguments`);
    return ["subjects"];
  }
  if (operator === "expand.relations") {
    requireModelFields(args, ["direction", "relations"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["relations", "direction", "min_depth", "max_depth", "path_policy", "filter"], `${path}.arguments`);
    if (!["inbound", "outbound", "both"].includes(String(args["direction"]))) fail(`${path}.arguments.direction`, "must be a registered direction");
    validateModelReferenceValue("RelationSelector", args["relations"], `${path}.arguments.relations`, context);
    for (const name of ["min_depth", "max_depth"]) if (args[name] !== undefined && (!Number.isSafeInteger(args[name]) || Number(args[name]) < 1)) fail(`${path}.arguments.${name}`, "must be a positive safe integer");
    const minDepth = args["min_depth"] === undefined ? 1 : Number(args["min_depth"]);
    const maxDepth = args["max_depth"] === undefined ? 1 : Number(args["max_depth"]);
    if (maxDepth < minDepth) fail(`${path}.arguments.max_depth`, "must be at least min_depth after applying defaults");
    if (args["path_policy"] !== undefined && !["simple_subjects", "simple_relations"].includes(String(args["path_policy"]))) fail(`${path}.arguments.path_policy`, "must be a registered path policy");
    if (args["filter"] !== undefined) validateModelReferenceValue("StructuralFilter", args["filter"], `${path}.arguments.filter`, context);
    return ["subjects", "relations", "paths"];
  }
  if (operator === "expand.operation") {
    requireModelFields(args, ["operation", "input_argument", "operation_arguments"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["operation", "input_argument", "operation_arguments"], `${path}.arguments`);
    if (typeof args["input_argument"] !== "string" || args["input_argument"].length === 0) fail(`${path}.arguments.input_argument`, "must be non-empty");
    const selected = validateRegisteredOperationArguments(args["operation"], args["operation_arguments"], `${path}.arguments.operation_arguments`, context, String(args["input_argument"]), true);
    if (!selected.operation.batchable_fields.includes(String(args["input_argument"]))) fail(`${path}.arguments.input_argument`, "must name a declared batchable operation argument");
    validateStageOutputCrossReferences(args["operation_arguments"], `${path}.arguments.operation_arguments`, availableStageOutputs ?? new Map());
    return selected.operation.result_streams;
  }
  if (operator === "filter") {
    requireModelFields(args, ["predicate"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["predicate"], `${path}.arguments`);
    validatePipelinePredicate(args["predicate"], `${path}.arguments.predicate`);
    return ["subjects"];
  }
  if (operator === "join") {
    requireModelFields(args, ["predicate", "output"], `${path}.arguments`);
    const predicate = String(args["predicate"]);
    if (!["same_subject", "same_entity", "same_artifact", "portable_key_equal", "relation_exists"].includes(predicate)) fail(`${path}.arguments.predicate`, "must be a registered join predicate");
    rejectUnknownModelFields(args, predicate === "relation_exists" ? ["predicate", "relation_selector", "direction", "output"] : ["predicate", "output"], `${path}.arguments`);
    if (!["pairs", "left", "right", "grouped"].includes(String(args["output"]))) fail(`${path}.arguments.output`, "must be a registered join output");
    if (predicate === "relation_exists") {
      requireModelFields(args, ["relation_selector", "direction"], `${path}.arguments`);
      validateModelReferenceValue("RelationSelector", args["relation_selector"], `${path}.arguments.relation_selector`, context);
      if (!["outbound", "inbound", "both"].includes(String(args["direction"]))) fail(`${path}.arguments.direction`, "must be a registered direction");
    }
    return [String(args["output"])] as const;
  }
  if (operator === "deduplicate") {
    requireModelFields(args, ["identity"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["identity", "include_possible"], `${path}.arguments`);
    if (!["subject", "entity", "artifact", "portable_key"].includes(String(args["identity"]))) fail(`${path}.arguments.identity`, "must be a registered deduplication identity");
    if (args["identity"] === "portable_key" && args["include_possible"] !== true) fail(`${path}.arguments.include_possible`, "must be true for portable_key deduplication");
    if (args["include_possible"] !== undefined && typeof args["include_possible"] !== "boolean") fail(`${path}.arguments.include_possible`, "must be boolean");
    return ["subjects"];
  }
  if (operator === "select") {
    requireModelFields(args, ["outputs"], `${path}.arguments`);
    rejectUnknownModelFields(args, ["outputs"], `${path}.arguments`);
    if (!Array.isArray(args["outputs"]) || args["outputs"].length === 0) fail(`${path}.arguments.outputs`, "must be a non-empty array");
    const names = new Set<string>();
    for (const [index, output] of (args["outputs"] as unknown[]).entries()) {
      if (output === null || typeof output !== "object" || Array.isArray(output)) fail(`${path}.arguments.outputs[${index}]`, "must be a closed select output");
      const candidate = output as Record<string, unknown>;
      requireModelFields(candidate, ["name", "input", "projection"], `${path}.arguments.outputs[${index}]`);
      rejectUnknownModelFields(candidate, ["name", "input", "projection", "filter"], `${path}.arguments.outputs[${index}]`);
      if (typeof candidate["name"] !== "string" || candidate["name"].length === 0 || names.has(candidate["name"])) fail(`${path}.arguments.outputs[${index}].name`, "must be a unique non-empty output name");
      names.add(candidate["name"]);
      validateStageOutputReferenceModel(candidate["input"], `${path}.arguments.outputs[${index}].input`);
      const projection = String(candidate["projection"]);
      const builtinProjection = ["subjects", "relations", "paths", "definitions"].includes(projection);
      const input = candidate["input"] as Record<string, unknown>;
      const upstream = availableStageOutputs?.get(String(input["stage_id"]));
      const upstreamProjection = upstream?.operator === "source.operation" && upstream.outputs?.includes(projection) === true;
      if (!builtinProjection && !upstreamProjection) fail(`${path}.arguments.outputs[${index}].projection`, "must be a registered result projection or exact upstream operation output");
      if (candidate["filter"] !== undefined) validateModelReferenceValue("StructuralFilter", candidate["filter"], `${path}.arguments.outputs[${index}].filter`, context);
    }
    return [...names];
  }
  if (operator === "bind.record_selector" || operator === "bind.subject_record_selector") {
    rejectUnknownModelFields(args, ["record_categories", "producer_ids", "filter"], `${path}.arguments`);
    if (args["record_categories"] !== undefined && (!Array.isArray(args["record_categories"]) || args["record_categories"].length === 0)) fail(`${path}.arguments.record_categories`, "must be a non-empty array");
    if (args["producer_ids"] !== undefined && (!Array.isArray(args["producer_ids"]) || args["producer_ids"].length === 0)) fail(`${path}.arguments.producer_ids`, "must be a non-empty array");
    if (args["filter"] !== undefined) validateModelReferenceValue("StructuralFilter", args["filter"], `${path}.arguments.filter`, context);
    return ["selector"];
  }
  fail(`${path}.operator`, "must name a registered core algebra operator");
}

function validateQueryExpressionModel(object: Record<string, unknown>, path: string, context: SchemaValidationContext): void {
  const expressionType = object["expression_type"];
  if (expressionType === "operation") {
    requireModelFields(object, ["expression_type", "operation", "arguments"], path);
    rejectUnknownModelFields(object, ["expression_type", "operation", "arguments"], path);
    validateRegisteredOperationArguments(object["operation"], object["arguments"], `${path}.arguments`, context);
    return;
  }
  if (expressionType === "pipeline") {
    requireModelFields(object, ["expression_type", "stages", "outputs"], path);
    rejectUnknownModelFields(object, ["expression_type", "stages", "outputs"], path);
    if (!Array.isArray(object["stages"]) || !Array.isArray(object["outputs"])) fail(path, "has invalid pipeline arrays");
    if (object["stages"].length < 1) fail(`${path}.stages`, "must be a non-empty array");
    if (object["outputs"].length < 1) fail(`${path}.outputs`, "must be a non-empty array");
    const stageIds = new Map<string, PipelineStageOutputInfo>();
    for (const [index, stage] of (object["stages"] as unknown[]).entries()) {
      const result = validateQueryStageModel(stage, `${path}.stages[${index}]`, context, stageIds);
      const stageId = (stage as Record<string, unknown>)["stage_id"];
      if (typeof stageId !== "string") fail(`${path}.stages[${index}].stage_id`, "must be non-empty");
      if (stageIds.has(stageId)) fail(`${path}.stages[${index}].stage_id`, "duplicate stage identifier");
      stageIds.set(stageId, result.outputNames === undefined ? { index, operator: result.operator } : { index, operator: result.operator, outputs: result.outputNames });
      for (const [inputIndex, input] of ((stage as Record<string, unknown>)["inputs"] as unknown[]).entries()) {
        const reference = input as Record<string, unknown>;
        const target = stageIds.get(String(reference["stage_id"]));
        if (!target) fail(`${path}.stages[${index}].inputs[${inputIndex}]`, "must reference an earlier pipeline stage");
        if (target.index >= index) fail(`${path}.stages[${index}].inputs[${inputIndex}]`, "must reference an earlier pipeline stage");
        if (target.outputs !== undefined && !target.outputs.includes(String(reference["output"]))) fail(`${path}.stages[${index}].inputs[${inputIndex}].output`, "is not a registered output of the referenced stage");
      }
      if (result.operator === "select") {
        const selectOutputs = ((stage as Record<string, unknown>)["arguments"] as Record<string, unknown>)["outputs"] as unknown[];
        const declaredInputs = new Set(((stage as Record<string, unknown>)["inputs"] as unknown[]).map((input) => `${String((input as Record<string, unknown>)["stage_id"])}\u0000${String((input as Record<string, unknown>)["output"])}`));
        for (const [outputIndex, selectedOutput] of selectOutputs.entries()) {
          const reference = (selectedOutput as Record<string, unknown>)["input"] as Record<string, unknown>;
          if (!declaredInputs.has(`${String(reference["stage_id"])}\u0000${String(reference["output"])}`)) fail(`${path}.stages[${index}].arguments.outputs[${outputIndex}].input`, "must reference a declared stage input");
          const target = stageIds.get(String(reference["stage_id"]));
          if (!target || target.index >= index) fail(`${path}.stages[${index}].arguments.outputs[${outputIndex}].input`, "must reference an earlier pipeline stage");
          if (target.outputs !== undefined && !target.outputs.includes(String(reference["output"]))) fail(`${path}.stages[${index}].arguments.outputs[${outputIndex}].input.output`, "is not a registered output of the referenced stage");
        }
      }
    }
    const outputReferences = new Set<string>();
    for (const [index, output] of (object["outputs"] as unknown[]).entries()) {
      validateStageOutputReferenceModel(output, `${path}.outputs[${index}]`);
      const reference = output as Record<string, unknown>;
      const outputKey = `${String(reference["stage_id"])}\u0000${String(reference["output"])}`;
      if (outputReferences.has(outputKey)) fail(`${path}.outputs[${index}]`, "must not contain duplicate output references");
      outputReferences.add(outputKey);
      const target = stageIds.get(String(reference["stage_id"]));
      if (!target) fail(`${path}.outputs[${index}].stage_id`, "must reference a declared pipeline stage");
      if (target.outputs !== undefined && !target.outputs.includes(String(reference["output"]))) fail(`${path}.outputs[${index}].output`, "is not a registered output of the referenced stage");
    }
    return;
  }
  if (expressionType === "recipe") {
    requireModelFields(object, ["expression_type", "recipe_id", "arguments"], path);
    rejectUnknownModelFields(object, ["expression_type", "recipe_id", "recipe_version", "arguments"], path);
    if (typeof object["recipe_id"] !== "string" || object["recipe_id"].length === 0) fail(`${path}.recipe_id`, "must be a registered recipe identifier");
    const recipe = recipeRegistry.find((candidate) => candidate.recipe_id === object["recipe_id"]);
    if (!recipe) fail(`${path}.recipe_id`, "must name a registered recipe");
    if (object["recipe_version"] !== undefined && object["recipe_version"] !== recipe.recipe_version) fail(`${path}.recipe_version`, "must match the registered recipe version");
    validateModelReferenceValue(modelNameFromSchemaId(recipe.argument_schema_id), object["arguments"], `${path}.arguments`, context);
    return;
  }
  fail(`${path}.expression_type`, "must be operation, pipeline, or recipe");
}

/** Validate the public query expression using the registry-owned closed model rules. */
export function validateQueryExpressionModelValue(value: unknown, path = "expression", context: SchemaValidationContext = {}): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a closed QueryExpression model");
  validateQueryExpressionModel(value as Record<string, unknown>, path, context);
}

/** Validate one operation's arguments using the registry-owned argument model rules. */
export function validateOperationArgumentsModelValue(operationId: unknown, value: unknown, path = "arguments", context: SchemaValidationContext = {}, allowStageOutput = false, omittedField?: string): void {
  validateRegisteredOperationArguments(operationId, value, path, context, omittedField, allowStageOutput);
}

function validateStageOutputReferenceModel(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a StageOutputReference object");
  const output = value as Record<string, unknown>;
  requireModelFields(output, ["stage_id", "output"], path);
  rejectUnknownModelFields(output, ["stage_id", "output"], path);
  if (typeof output["stage_id"] !== "string" || output["stage_id"].length === 0) fail(`${path}.stage_id`, "must be non-empty");
  if (typeof output["output"] !== "string" || output["output"].length === 0) fail(`${path}.output`, "must be non-empty");
}

function validateQueryStageModel(value: unknown, path: string, context: SchemaValidationContext, availableStageOutputs: ReadonlyMap<string, PipelineStageOutputInfo> = new Map()): QueryStageValidationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a QueryStage object");
  const stage = value as Record<string, unknown>;
  requireModelFields(stage, ["stage_id", "operator", "inputs", "arguments"], path);
  rejectUnknownModelFields(stage, ["stage_id", "operator", "inputs", "arguments"], path);
  if (typeof stage["stage_id"] !== "string" || stage["stage_id"].length === 0) fail(`${path}.stage_id`, "must be non-empty");
  if (typeof stage["operator"] !== "string" || stage["operator"].length === 0 || !registeredQueryOperators.has(stage["operator"])) fail(`${path}.operator`, "must name a registered core algebra operator");
  if (!Array.isArray(stage["inputs"])) fail(`${path}.inputs`, "must be an array");
  if (stage["arguments"] === null || typeof stage["arguments"] !== "object" || Array.isArray(stage["arguments"])) fail(`${path}.arguments`, "must be an arguments object");
  for (const [index, input] of (stage["inputs"] as unknown[]).entries()) validateStageOutputReferenceModel(input, `${path}.inputs[${index}]`);
  const operator = String(stage["operator"]);
  const inputCount = (stage["inputs"] as unknown[]).length;
  const minimumInputs: Readonly<Record<string, number>> = { "set.union": 2, "set.intersection": 2, deduplicate: 1, select: 1 };
  const exactInputs: Readonly<Record<string, number>> = { "set.difference": 2, "expand.relations": 1, "expand.operation": 1, filter: 1, join: 2, "bind.record_selector": 1, "bind.subject_record_selector": 1, "source.operation": 0, "source.registry": 0 };
  if (minimumInputs[operator] !== undefined && inputCount < minimumInputs[operator]) fail(`${path}.inputs`, `must contain at least ${minimumInputs[operator]} inputs for ${operator}`);
  if (exactInputs[operator] !== undefined && inputCount !== exactInputs[operator]) fail(`${path}.inputs`, `must contain exactly ${exactInputs[operator]} inputs for ${operator}`);
  if (operator === "bind.record_selector" && String(((stage["inputs"] as unknown[])[0] as Record<string, unknown>)?.["output"]) !== "definition_set") fail(`${path}.inputs[0].output`, "must reference a registry definition_set input");
  if (operator === "bind.record_selector" || operator === "bind.subject_record_selector") fail(`${path}.operator`, "is recipe-only and is not accepted in caller-authored pipelines");
  const outputNames = validatePipelineOperatorArguments(stage["operator"], stage["arguments"], path, context, availableStageOutputs);
  return outputNames === undefined ? { operator: stage["operator"] } : { operator: stage["operator"], outputNames };
}

const schemaBoundModelCoordinates: Readonly<Record<string, readonly [string, string]>> = {
  "AnalysisConfiguration.normalized_configuration": ["configuration_schema_id", "configuration_schema_version"],
  "WorkspaceConfigurationRevision.effective_configuration": ["effective_configuration_schema_id", "effective_configuration_schema_version"],
  "DefinitionValue.requirement_value": ["requirement_schema_id", "requirement_schema_version"],
  "PartialOperationArguments.partial_arguments": ["partial_arguments_schema_id", "partial_arguments_schema_version"],
};

function validateModelSchemaBoundCoordinates(typeName: string, fieldName: string, object: Record<string, unknown>, path: string, declaredCoordinates?: readonly [string, string]): void {
  const coordinates = declaredCoordinates ?? schemaBoundModelCoordinates[`${typeName}.${fieldName}`];
  if (!coordinates) fail(`${path}.${fieldName}`, "has no authoritative SchemaBoundBytes coordinate definition");
  const [idField, versionField] = coordinates;
  const schemaId = object[idField];
  if (typeof schemaId !== "string" || !/^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(schemaId)) fail(`${path}.${idField}`, "must be a non-empty NamespacedIdentifier coordinate");
  if (!Number.isSafeInteger(object[versionField]) || Number(object[versionField]) < 1) fail(`${path}.${versionField}`, "must be a positive schema version coordinate");
  const bytes = object[fieldName];
  if (typeof bytes !== "string" || !/^base64url:[A-Za-z0-9_-]+$/.test(bytes)) fail(`${path}.${fieldName}`, "must be non-empty SchemaBoundBytes");
}

function validatePublicQueryModel(typeName: string, object: Record<string, unknown>, path: string, context: SchemaValidationContext, allowStageOutput = false): void {
  const strings = (name: string): void => { const value = object[name]; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${path}.${name}`, "must be an array of strings"); };
  const optionalBoolean = (name: string): void => { if (name in object && typeof object[name] !== "boolean") fail(`${path}.${name}`, "must be boolean"); };
  if (typeName === "DefinitionMatcher") {
    rejectUnknownModelFields(object, ["text", "mode", "definition_types", "namespaces", "limit"], path);
    requireModelFields(object, ["text", "mode"], path);
    if (typeof object["text"] !== "string" || object["text"].length === 0) fail(`${path}.text`, "must be non-empty text");
    if (!["exact", "prefix", "contains", "semantic", "hybrid"].includes(String(object["mode"]))) fail(`${path}.mode`, "must be a closed matcher mode");
    for (const name of ["definition_types", "namespaces"]) if (name in object) strings(name);
    if ("limit" in object && (!Number.isSafeInteger(object["limit"]) || Number(object["limit"]) < 1)) fail(`${path}.limit`, "must be a positive safe integer");
    return;
  }
  if (typeName === "SubjectSelector") {
    const subjectType = object["subject_type"];
    if (subjectType === "entity") { requireModelFields(object, ["subject_type", "entity_id"], path); rejectUnknownModelFields(object, ["subject_type", "entity_id", "entity_record_id"], path); return; }
    if (subjectType === "record") { requireModelFields(object, ["subject_type", "record_id"], path); rejectUnknownModelFields(object, ["subject_type", "record_id"], path); return; }
    if (subjectType === "artifact") {
      const hasId = typeof object["artifact_id"] === "string";
      const hasPath = typeof object["path"] === "string";
      if (hasId === hasPath) fail(`${path}.artifact_id`, "artifact selector requires exactly one of artifact_id or path");
      rejectUnknownModelFields(object, ["subject_type", "artifact_id", "path", "artifact_version_id"], path); return;
    }
    if (subjectType === "symbol") { requireModelFields(object, ["subject_type", "name"], path); rejectUnknownModelFields(object, ["subject_type", "name", "context_artifact", "context_byte_offset", "kind_selector"], path); if ("context_byte_offset" in object && (!Number.isSafeInteger(object["context_byte_offset"]) || Number(object["context_byte_offset"]) < 0)) fail(`${path}.context_byte_offset`, "must be a non-negative safe integer"); if (object["kind_selector"] !== undefined) validateModelReferenceValue("KindSelector", object["kind_selector"], `${path}.kind_selector`, context); return; }
    if (subjectType === "stage_output") {
      if (!allowStageOutput) fail(`${path}.subject_type`, "stage_output selectors are legal only in pipeline arguments");
      requireModelFields(object, ["subject_type", "stage_id", "output"], path); rejectUnknownModelFields(object, ["subject_type", "stage_id", "output"], path); return;
    }
    fail(`${path}.subject_type`, "must be one of entity, record, artifact, symbol, or stage_output");
  }
  if (typeName === "KindSelector") { rejectUnknownModelFields(object, ["kinds", "universal_kinds", "all_facets", "any_facets", "excluded_facets"], path); for (const name of ["kinds", "universal_kinds", "all_facets", "any_facets", "excluded_facets"]) if (name in object) strings(name); return; }
  if (typeName === "StructuralFilter") { rejectUnknownModelFields(object, ["paths", "languages", "namespaces", "kind_selector", "subject_types", "include_external", "include_generated"], path); for (const name of ["paths", "languages", "namespaces"]) if (name in object) strings(name); if (object["kind_selector"] !== undefined) validateModelReferenceValue("KindSelector", object["kind_selector"], `${path}.kind_selector`, context); if (object["subject_types"] !== undefined) { strings("subject_types"); if ((object["subject_types"] as string[]).some((value) => !["entity", "record", "artifact"].includes(value))) fail(`${path}.subject_types`, "contains an unknown subject type"); } optionalBoolean("include_external"); optionalBoolean("include_generated"); return; }
  if (typeName === "RelationSelector") { rejectUnknownModelFields(object, ["relation_kinds", "universal_kinds", "roles", "evidence_class", "possible_confidence"], path); for (const name of ["relation_kinds", "universal_kinds", "roles", "possible_confidence"]) if (name in object) strings(name); if (object["evidence_class"] !== undefined && !["confirmed", "possible", "both"].includes(String(object["evidence_class"]))) fail(`${path}.evidence_class`, "must be confirmed, possible, or both"); if (Array.isArray(object["possible_confidence"]) && (object["possible_confidence"] as string[]).some((value) => !["high", "medium", "low"].includes(value))) fail(`${path}.possible_confidence`, "contains an unknown confidence tier"); return; }
  if (typeName === "RegistrySelector") { rejectUnknownModelFields(object, ["definition_types", "namespaces", "plugin_ids", "lifecycle_states"], path); for (const name of ["definition_types", "namespaces", "plugin_ids"]) if (name in object) strings(name); if (object["lifecycle_states"] !== undefined) { strings("lifecycle_states"); if ((object["lifecycle_states"] as string[]).some((value) => !["active", "deprecated", "retired"].includes(value))) fail(`${path}.lifecycle_states`, "contains an unknown lifecycle state"); } return; }
  if (typeName === "RecordStructuralSelector") { rejectUnknownModelFields(object, ["record_categories", "kind_selector", "producer_ids", "filter"], path); const present = ["record_categories", "kind_selector", "producer_ids", "filter"].filter((name) => object[name] !== undefined); if (present.length === 0) fail(path, "must contain at least one selector dimension"); if (object["record_categories"] !== undefined) { strings("record_categories"); if ((object["record_categories"] as string[]).length === 0) fail(`${path}.record_categories`, "must be a non-empty array"); if ((object["record_categories"] as string[]).some((value) => !["entity", "relation", "fact", "evidence", "diagnostic"].includes(value))) fail(`${path}.record_categories`, "contains an unknown record category"); if (new Set(object["record_categories"] as string[]).size !== (object["record_categories"] as string[]).length) fail(`${path}.record_categories`, "must not contain duplicates"); } if (object["kind_selector"] !== undefined) validateModelReferenceValue("KindSelector", object["kind_selector"], `${path}.kind_selector`, context); if (object["producer_ids"] !== undefined) { strings("producer_ids"); if ((object["producer_ids"] as string[]).length === 0) fail(`${path}.producer_ids`, "must be a non-empty array"); } if (object["filter"] !== undefined) validateModelReferenceValue("StructuralFilter", object["filter"], `${path}.filter`, context); return; }
  const changeType = object["change_type"];
  const changeFields: Record<string, readonly string[]> = { delete: ["change_type"], rename: ["change_type", "new_name"], move: ["change_type", "new_artifact_path", "new_container"], signature: ["change_type", "new_signature", "compatibility_assumptions"], type: ["change_type", "new_type", "compatibility_assumptions"], visibility: ["change_type", "new_visibility"], contract: ["change_type", "contract_change_code", "new_contract", "compatibility_assumptions"], behavior: ["change_type", "behavior_change_code", "description", "affected_effects"] };
  const allowed = changeFields[String(changeType)]; if (!allowed) fail(`${path}.change_type`, "must be a closed ChangeDescriptor variant"); requireModelFields(object, allowed.filter((name) => !["new_container", "compatibility_assumptions", "affected_effects"].includes(name)), path); rejectUnknownModelFields(object, allowed, path); for (const name of ["compatibility_assumptions", "affected_effects"]) if (name in object) strings(name);
}

function logicalTypeExpression(logicalType: string): CanonicalTypeExpression {
  const sequence = logicalType.match(/^Sequence<(.+)>$/);
  if (sequence) return { type_kind: "sequence", element_type: logicalTypeExpression(sequence[1] ?? "") };
  const set = logicalType.match(/^Set<(.+)>$/);
  if (set) return { type_kind: "set", element_type: logicalTypeExpression(set[1] ?? "") };
  const orderedSet = logicalType.match(/^OrderedSet<(.+),\s*([^>]+)>$/);
  if (orderedSet) return { type_kind: "ordered_set", element_type: logicalTypeExpression(orderedSet[1] ?? ""), comparator_id: (orderedSet[2] ?? "").replace(/@\d+$/, ""), comparator_version: 1 };
  const enumValues = logicalType.split("|").map((value) => value.trim()).filter(Boolean);
  if (enumValues.length > 1) return { type_kind: "enum", values: enumValues };
  if (logicalType === "Boolean") return { type_kind: "boolean" };
  if (logicalType === "PositiveInteger") return { type_kind: "safe_integer", minimum: 1 };
  if (logicalType === "Count") return { type_kind: "safe_integer", minimum: 0 };
  if (logicalType === "Identifier") return { type_kind: "text", identifier_kind: "identifier" };
  if (logicalType === "NamespacedIdentifier") return { type_kind: "text", identifier_kind: "namespaced_identifier" };
  if (logicalType === "SemVer") return { type_kind: "text", identifier_kind: "semver" };
  if (logicalType === "URI") return { type_kind: "text", identifier_kind: "uri" };
  if (logicalType === "Text") return { type_kind: "text" };
  if (logicalType === "Digest") return { type_kind: "digest", allowed_hash_algorithms: ["sha256"] };
  if (logicalType === "Bytes" || logicalType === "SchemaBoundBytes") return { type_kind: "bytes" };
  if (/^[a-z][a-z0-9_]*$/.test(logicalType)) return { type_kind: "enum", values: [logicalType] };
  if (logicalType === "JsonValue") return { type_kind: "schema_reference", reference_scope: "external", type_name: "JsonValue", schema_id: "core:JsonValue", schema_version: 1 };
  if (authoritativeModelNames.includes(logicalType as (typeof authoritativeModelNames)[number])) return { type_kind: "schema_reference", reference_scope: "external", type_name: logicalType, schema_id: `core:${logicalType}`, schema_version: 1 };
  throw new Error(`missing authoritative logical type ${logicalType}`);
}

function requireModelFields(object: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) if (!(field in object)) fail(`${path}.${field}`, "is required");
}

function rejectUnknownModelFields(object: Record<string, unknown>, fields: readonly string[], path: string): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(object)) if (!allowed.has(field)) fail(`${path}.${field}`, "unknown field");
}

function validateCollection(type: SequenceTypeExpression | SetTypeExpression | OrderedSetTypeExpression, value: unknown, path: string, context: SchemaValidationContext, activeReferences: Set<string>): void {
  if (!Array.isArray(value)) fail(path, "must be an array");
  checkCountBounds(type.minimum_item_count, type.maximum_item_count, value.length, path);
  for (const [index, item] of value.entries()) validateType(type.element_type, item, `${path}[${index}]`, context, activeReferences);
  if (type.type_kind !== "sequence") {
    const serialized = value.map((item) => JSON.stringify(item));
    if (new Set(serialized).size !== serialized.length) fail(path, "must not contain duplicates");
  }
}

function validateMap(type: MapTypeExpression, value: unknown, path: string, context: SchemaValidationContext, activeReferences: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a map");
  const entries = Object.entries(value);
  checkCountBounds(type.minimum_entry_count, type.maximum_entry_count, entries.length, path);
  for (const [key, item] of entries) validateType(type.value_type, item, `${path}.${key}`, context, activeReferences);
}

function validateRecord(fields: ReadonlyArray<SchemaFieldDefinition>, value: unknown, path: string, context: SchemaValidationContext, activeReferences: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a record");
  const object = value as Record<string, unknown>;
  const byName = new Map(fields.map((field) => [field.field_name, field]));
  for (const key of Object.keys(object)) if (!byName.has(key)) fail(`${path}.${key}`, "unknown field");
  for (const field of fields) {
    if (!(field.field_name in object)) {
      if (field.presence === "required") fail(`${path}.${field.field_name}`, "is required");
      continue;
    }
    if (field.value_type.type_kind === "bytes" && field.value_type.bound_schema_id_field !== undefined && field.value_type.bound_schema_version_field !== undefined) {
      if (typeof object[field.value_type.bound_schema_id_field] !== "string" || object[field.value_type.bound_schema_id_field] === "") fail(`${path}.${field.value_type.bound_schema_id_field}`, "is required by SchemaBoundBytes");
      if (!Number.isSafeInteger(object[field.value_type.bound_schema_version_field]) || Number(object[field.value_type.bound_schema_version_field]) < 1) fail(`${path}.${field.value_type.bound_schema_version_field}`, "is required as a positive schema version by SchemaBoundBytes");
    }
    validateType(field.value_type, object[field.field_name], `${path}.${field.field_name}`, context, activeReferences);
  }
}

function validateUnion(type: UnionTypeExpression, value: unknown, path: string, context: SchemaValidationContext, activeReferences: Set<string>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a union object");
  const object = value as Record<string, unknown>;
  const discriminator = object[type.discriminator_field];
  if (typeof discriminator !== "string") fail(`${path}.${type.discriminator_field}`, "discriminator is required");
  const variant = type.variants.find((candidate) => candidate.discriminator_value === discriminator);
  if (!variant) fail(`${path}.${type.discriminator_field}`, "unknown discriminator");
  validateRecord([{ field_name: type.discriminator_field, description: type.discriminator_description, presence: "required", value_type: { type_kind: "enum", values: [variant.discriminator_value] } }, ...variant.fields], value, path, context, activeReferences);
}

function checkNumberBounds(type: { minimum?: number; maximum?: number }, value: number, path: string): void {
  if (type.minimum !== undefined && value < type.minimum) fail(path, "is below minimum");
  if (type.maximum !== undefined && value > type.maximum) fail(path, "is above maximum");
}

function checkLengthBounds(minimum: number | undefined, maximum: number | undefined, value: string, path: string): void {
  checkCountBounds(minimum, maximum, [...value].length, path);
}

function validateConstrainedText(type: TextTypeExpression, value: string, path: string): void {
  checkLengthBounds(type.minimum_code_point_count, type.maximum_code_point_count, value, path);
  const patterns: Readonly<Record<NonNullable<TextTypeExpression["identifier_kind"]>, RegExp>> = {
    identifier: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    namespaced_identifier: /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/,
    semver: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    uri: /^\S+$/,
  };
  if (type.identifier_kind !== undefined && !patterns[type.identifier_kind].test(value)) fail(path, `must be a valid ${type.identifier_kind}`);
}

function checkCountBounds(minimum: number | undefined, maximum: number | undefined, value: number, path: string): void {
  if (minimum !== undefined && value < minimum) fail(path, "is below minimum");
  if (maximum !== undefined && value > maximum) fail(path, "is above maximum");
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

const BIG_INTEGER_PATTERN = /^bigint:(?:0|-?[1-9][0-9]*)$/;
const EXACT_DECIMAL_PATTERN = /^decimal:(?:0|-?[1-9][0-9]*)(\.[0-9]+)?$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$/;
const SNAKE_CASE_FIELD_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DIGEST_LENGTHS: Readonly<Record<string, number>> = { sha256: 64 };

function validateJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be a JSON number");
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) validateJsonValue(item, `${path}[${index}]`);
    return;
  }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(path, "must be a JSON value");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) validateJsonValue(item, `${path}.${key}`);
}

function digestPattern(algorithms: readonly string[]): RegExp {
  return new RegExp(`^(?:${algorithms.map((algorithm) => `${escapeRegExp(algorithm)}:[0-9a-f]{${DIGEST_LENGTHS[algorithm] ?? 0}}`).join("|")})$`);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function validateTimestamp(value: string, path: string): void {
  if (!TIMESTAMP_PATTERN.test(value)) fail(path, "must be a canonical UTC timestamp");
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13)); const minute = Number(value.slice(14, 16)); const second = Number(value.slice(17, 19));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) fail(path, "has invalid calendar or clock fields");
}

function validateBigIntegerDefinitionBounds(minimum: string | undefined, maximum: string | undefined, path: string): void {
  if (minimum !== undefined && !BIG_INTEGER_PATTERN.test(minimum)) fail(path, "minimum must be a canonical BigInteger");
  if (maximum !== undefined && !BIG_INTEGER_PATTERN.test(maximum)) fail(path, "maximum must be a canonical BigInteger");
  if (minimum !== undefined && maximum !== undefined && BigInt(minimum.slice("bigint:".length)) > BigInt(maximum.slice("bigint:".length))) fail(path, "minimum exceeds maximum");
}

function validateDecimalDefinitionBounds(minimum: string | undefined, maximum: string | undefined, path: string): void {
  if (minimum !== undefined && !EXACT_DECIMAL_PATTERN.test(minimum)) fail(path, "minimum must be a canonical ExactDecimal");
  if (maximum !== undefined && !EXACT_DECIMAL_PATTERN.test(maximum)) fail(path, "maximum must be a canonical ExactDecimal");
  if (minimum !== undefined && maximum !== undefined && compareDecimal(minimum, maximum) > 0) fail(path, "minimum exceeds maximum");
}

function validateDecimalValue(type: ExactDecimalTypeExpression, value: string, path: string): void {
  if (type.scale_policy === "insignificant" && value.includes(".") && value.endsWith("0")) fail(path, "has insignificant trailing zero scale");
  if (type.minimum !== undefined && compareDecimal(value, type.minimum) < 0) fail(path, "is below minimum");
  if (type.maximum !== undefined && compareDecimal(value, type.maximum) > 0) fail(path, "is above maximum");
}

function compareDecimal(left: string, right: string): number {
  const normalize = (raw: string) => { const value = raw.slice("decimal:".length); const negative = value.startsWith("-"); const unsigned = negative ? value.slice(1) : value; const [whole = "0", fraction = ""] = unsigned.split("."); const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, ""); return { negative, digits: digits || "0", scale: fraction.length }; };
  const a = normalize(left); const b = normalize(right); if (a.negative !== b.negative) return a.negative ? -1 : 1; const scale = Math.max(a.scale, b.scale); const ad = a.digits.padEnd(a.digits.length + scale - a.scale, "0"); const bd = b.digits.padEnd(b.digits.length + scale - b.scale, "0"); const cmp = ad.length === bd.length ? ad.localeCompare(bd) : ad.length - bd.length; return a.negative ? -cmp : cmp;
}

function checkBigIntegerBounds(type: BigIntegerTypeExpression, value: string, path: string): void { const normalized = value.slice("bigint:".length); const minimum = type.minimum?.slice("bigint:".length); const maximum = type.maximum?.slice("bigint:".length); if (minimum !== undefined && BigInt(normalized) < BigInt(minimum)) fail(path, "is below minimum"); if (maximum !== undefined && BigInt(normalized) > BigInt(maximum)) fail(path, "is above maximum"); }

function byteLength(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value !== "string" || !/^base64url:[A-Za-z0-9_-]*$/.test(value)) fail("value", "must be bytes");
  const encoded = value.slice("base64url:".length); if (encoded.length % 4 === 1) fail("value", "has invalid base64url length"); return Math.floor(encoded.length * 3 / 4);
}

function validateLocalReferences(schema: CanonicalSchemaDefinition, context: SchemaValidationContext): void {
  const definitions = new Map(schema.type_definitions.map((definition) => [definition.type_name, definition.type_expression]));
  const visit = (type: CanonicalTypeExpression, path: string, active: Set<string>): void => {
    if (type.type_kind === "schema_reference") {
      if (type.reference_scope === "local") {
        const target = definitions.get(type.type_name);
        if (!target) fail(path, `references unknown local type ${type.type_name}`);
        const key = `local:${type.type_name}`;
        if (active.has(key)) fail(path, `reference cycle at ${type.type_name}`);
        const next = new Set(active); next.add(key); visit(target, `${path}->${type.type_name}`, next);
      } else {
        // External dependencies are traversed by validateSchemaReferenceGraph,
        // which owns the cross-schema visiting set and cycle diagnostics.
        resolveExternalSchema(type, context);
      }
      return;
    }
    if (type.type_kind === "sequence" || type.type_kind === "set" || type.type_kind === "ordered_set") visit(type.element_type, `${path}.element_type`, active);
    if (type.type_kind === "map") visit(type.value_type, `${path}.value_type`, active);
    if (type.type_kind === "record") for (const field of type.fields) visit(field.value_type, `${path}.${field.field_name}`, active);
    if (type.type_kind === "union") for (const variant of type.variants) for (const field of variant.fields) visit(field.value_type, `${path}.${variant.discriminator_value}.${field.field_name}`, active);
  };
  for (const definition of schema.type_definitions) visit(definition.type_expression, `schema.type_definitions.${definition.type_name}`, new Set([`local:${definition.type_name}`]));
  visit(schema.root_type, "schema.root_type", new Set());
}

export function validateSchemaReferenceGraph(schemas: readonly CanonicalSchemaDefinition[], context: SchemaValidationContext = {}): void {
  const scopedContext = { ...context, schemas };
  const coordinates = new Set(schemas.map((schema) => `${schema.schema_id}@${schema.schema_version}`));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitSchema = (schema: CanonicalSchemaDefinition): void => {
    const coordinate = `${schema.schema_id}@${schema.schema_version}`;
    if (visiting.has(coordinate)) fail("schema.references", `reference cycle at ${coordinate}`);
    if (visited.has(coordinate)) return;
    visiting.add(coordinate);
    validateSchemaDefinition(schema, scopedContext);
    const visitType = (type: CanonicalTypeExpression): void => {
      if (type.type_kind === "schema_reference" && type.reference_scope === "external" && !isAuthoritativeModelReference(type)) {
        const target = resolveExternalSchema(type, scopedContext);
        if (target && coordinates.has(`${target.schema_id}@${target.schema_version}`)) visitSchema(target);
      }
      if (type.type_kind === "sequence" || type.type_kind === "set" || type.type_kind === "ordered_set") visitType(type.element_type);
      if (type.type_kind === "map") visitType(type.value_type);
      if (type.type_kind === "record") for (const field of type.fields) visitType(field.value_type);
      if (type.type_kind === "union") for (const variant of type.variants) for (const field of variant.fields) visitType(field.value_type);
    };
    visitType(schema.root_type);
    for (const definition of schema.type_definitions) visitType(definition.type_expression);
    visiting.delete(coordinate); visited.add(coordinate);
  };
  for (const schema of schemas) visitSchema(schema);
}

function contextSchemas(context: SchemaValidationContext): readonly CanonicalSchemaDefinition[] {
  if (!context.schemas) return [];
  return Array.isArray(context.schemas) ? context.schemas : [...context.schemas.values()];
}

function resolveExternalSchema(reference: SchemaReferenceTypeExpression, context: SchemaValidationContext): CanonicalSchemaDefinition | undefined {
  const coordinate = `${reference.schema_id}@${reference.schema_version}`;
  const target = contextSchemas(context).find((schema) => `${schema.schema_id}@${schema.schema_version}` === coordinate);
  if (target) {
    const named = target.type_definitions.some((definition) => definition.type_name === reference.type_name);
    const rootName = target.schema_id.replace(/^core:/, "");
    if (!named && target.type_definitions.length > 0) fail("schema_reference", `target type ${reference.type_name} is not defined by ${coordinate}`);
    if (!named && target.type_definitions.length === 0 && reference.type_name !== rootName) fail("schema_reference", `target type ${reference.type_name} does not match ${coordinate}`);
    return target;
  }
  if (!knownExternalCoordinate(reference.schema_id ?? "", reference.schema_version ?? 0)) fail("schema_reference", `missing external target ${coordinate}`);
  return undefined;
}

function resolveReferenceType(reference: SchemaReferenceTypeExpression, context: SchemaValidationContext): CanonicalTypeExpression {
  if (reference.reference_scope === "local") {
    const target = context.localDefinitions?.get(reference.type_name);
    if (!target) fail("schema_reference", `missing local target ${reference.type_name}`);
    return target;
  }
  const schema = resolveExternalSchema(reference, context);
  if (!schema) fail("schema_reference", `unresolved external target ${reference.schema_id}@${reference.schema_version}`);
  return schema.type_definitions.find((definition) => definition.type_name === reference.type_name)?.type_expression ?? schema.root_type;
}

function referenceKeyFor(reference: SchemaReferenceTypeExpression): string {
  return reference.reference_scope === "local" ? `local:${reference.type_name}` : `external:${reference.schema_id}@${reference.schema_version}#${reference.type_name}`;
}

function knownExternalCoordinate(schemaId: string, version: number): boolean {
  if (version !== 1) return false;
  if (schemaId === "core:JsonValue") return true;
  if (authoritativeModelNames.some((name) => schemaId === `core:${name}`)) return true;
  return false;
}

function isAuthoritativeModelReference(reference: SchemaReferenceTypeExpression): boolean {
  return reference.reference_scope === "external" && reference.schema_version === 1 && reference.schema_id === `core:${reference.type_name}` && authoritativeModelNames.includes(reference.type_name as (typeof authoritativeModelNames)[number]);
}

function findComparator(comparatorId: string, comparatorVersion: number, context: SchemaValidationContext): { sort_keys?: readonly { value_path: string; comparison_mode: string }[] } | undefined {
  const override = context.comparators?.find((entry) => entry.comparator_id === comparatorId && entry.comparator_version === comparatorVersion);
  if (override) return override;
  return comparatorRegistry.find((entry) => entry.comparator_id === comparatorId && entry.comparator_version === comparatorVersion);
}

function validateComparatorCompatibility(element: CanonicalTypeExpression, keys: readonly { value_path: string; comparison_mode: string }[], path: string, context: SchemaValidationContext): void {
  if (keys.length === 0) fail(path, "ordered-set comparator requires sort keys");
  for (const key of keys) {
    const target = comparatorPathType(element, key.value_path, context);
    if (!target) fail(`${path}.${key.value_path}`, "comparator sort-key path does not resolve on the ordered-set element");
    const compatible = key.comparison_mode === "text_utf8" && (target.type_kind === "text" || target.type_kind === "enum")
      || key.comparison_mode === "safe_integer_numeric" && target.type_kind === "safe_integer"
      || key.comparison_mode === "big_integer_numeric" && target.type_kind === "big_integer"
      || key.comparison_mode === "float64_numeric" && target.type_kind === "float64"
      || key.comparison_mode === "exact_decimal_numeric" && target.type_kind === "exact_decimal"
      || key.comparison_mode === "timestamp_chronological" && target.type_kind === "timestamp"
      || key.comparison_mode === "digest_bytes" && target.type_kind === "digest"
      || key.comparison_mode === "uce_bytes" && (target.type_kind === "bytes" || target.type_kind === "schema_reference" || target.type_kind === "text")
      || key.comparison_mode === "bytes_lexicographic" && target.type_kind === "bytes";
    if (!compatible) fail(`${path}.${key.value_path}`, `comparator mode ${key.comparison_mode} is incompatible with ${target.type_kind}`);
  }
}

function comparatorPathType(type: CanonicalTypeExpression, valuePath: string, context: SchemaValidationContext): CanonicalTypeExpression | undefined {
  if (valuePath === "" || valuePath === "/") return type;
  const segments = valuePath.split("/").filter(Boolean);
  let current: CanonicalTypeExpression | undefined = type;
  for (const segment of segments) {
    if (current?.type_kind === "record") current = current.fields.find((field) => field.field_name === segment)?.value_type;
    else if (current?.type_kind === "schema_reference" && current.reference_scope === "local") current = context.localDefinitions?.get(current.type_name);
    else if (current?.type_kind === "schema_reference" && current.reference_scope === "external" && authoritativeModelNames.includes(current.type_name as (typeof authoritativeModelNames)[number])) {
      const reference = current;
      const field = modelContractRegistry.find((candidate) => candidate.name === reference.type_name)?.fields.find((candidate) => candidate.name === segment);
      const numericField = field ? ["operation_version", "recipe_version", "schema_version", "definition_revision", "participant_ordinal", "package_format_version", "contract_version"].includes(field.name) : false;
      current = field ? comparatorLogicalTypeExpression(field.logical_type === "Text" && field.name.endsWith("digest") ? "Digest" : field.logical_type === "Text" && (numericField || /(ordinal|count|length)$/.test(field.name)) ? "Count" : field.logical_type) : undefined;
    }
    else return undefined;
  }
  return current;
}

function comparatorLogicalTypeExpression(logicalType: string): CanonicalTypeExpression {
  const sequence = logicalType.match(/^Sequence<(.+)>$/);
  if (sequence) return { type_kind: "sequence", element_type: comparatorLogicalTypeExpression(sequence[1] ?? "") };
  const set = logicalType.match(/^Set<(.+)>$/);
  if (set) return { type_kind: "set", element_type: comparatorLogicalTypeExpression(set[1] ?? "") };
  const values = logicalType.split("|").map((value) => value.trim()).filter(Boolean);
  if (values.length > 1) return { type_kind: "enum", values };
  if (logicalType === "Boolean") return { type_kind: "boolean" };
  if (logicalType === "PositiveInteger") return { type_kind: "safe_integer", minimum: 1 };
  if (logicalType === "Count") return { type_kind: "safe_integer", minimum: 0 };
  if (logicalType === "Digest") return { type_kind: "digest", allowed_hash_algorithms: ["sha256"] };
  if (logicalType === "Bytes" || logicalType === "SchemaBoundBytes") return { type_kind: "bytes" };
  return { type_kind: "text" };
}

function assertClosedObject(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
}
