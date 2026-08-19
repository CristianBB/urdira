import { createHash } from "node:crypto";
import { coreSchemaDefinitions, validateSchemaValue, type CanonicalSchemaDefinition, type CanonicalTypeExpression, type DigestComputationContext, type DigestPayloadBinding, type DigestPayloadFieldBinding, type DigestRecipeDefinition, type SchemaFieldDefinition } from "@urdira/contracts";
import { digestDomainRegistry, digestPayloadSchemaDefinitions, digestRecipeDefinitions, digestRecipeVariantDefinitions, documentedDigestRecipeCoordinates } from "./registries.js";
import { isWholeVerifiedInput, payloadBindingFor, payloadSchemaIdFor } from "./digest-payload-schemas.js";
import { compareCanonicalValues, readCanonicalPointer } from "./comparators.js";
import { canonicalBytes, compareBytes, decodeCanonical, encodeArrayHeader, encodeCanonical, encodeMapHeader, type CanonicalEncodingLimits } from "./cbor.js";
import { fail } from "./errors.js";

export type DigestText = `sha256:${string}`;

export interface DigestRecipe {
  readonly digest_recipe_id: string;
  readonly recipe_version: number;
  readonly digest_domain: string;
  readonly payload_schema_id: string;
  readonly payload_schema_version: number;
  readonly payload_binding?: DigestPayloadBinding | string;
  readonly canonical_encoding_version?: number;
  readonly hash_algorithm?: "sha256";
  readonly target_schema_id?: string;
  readonly target_schema_version?: number;
  readonly target_field?: string;
}

export interface DigestOptions {
  readonly canonical_encoding_version?: number;
  readonly hash_algorithm?: "sha256";
}

export interface DigestEnvelopeValidationContext {
  readonly digest_domains?: readonly string[];
  readonly digest_recipes?: readonly { readonly digest_recipe_id: string; readonly recipe_version: number }[];
  readonly schemas?: readonly { readonly schema_id: string; readonly schema_version: number }[];
}

export interface DigestRecipeGraphResult {
  readonly recipes: readonly DigestRecipe[];
}

export function digestBytes(bytes: Uint8Array): DigestText {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * SHA-256 over the canonical CBOR encoding of `elements` as an array, without
 * ever materializing the concatenated encoding. Byte-identical to
 * `digestBytes(encodeCanonical(elements, limits))`, computed instead by
 * hashing the canonical array header followed by each element's own
 * `encodeCanonical` bytes, incrementally.
 *
 * Every element is encoded under the caller-supplied `limits` applied
 * per-element (the same limits `encodeCanonical` would apply to that element
 * inside a normal array encode) -- so no *aggregate* size, byte count, or
 * text length across the whole array can ever trip a resource limit; only one
 * element's own encoded size can. This is the entire point: a materialization
 * with many (or large) elements is bounded by its single largest element, not
 * by the sum of all of them. The number of elements consumed still counts
 * against each call's own `max_elements` budget exactly as array encoding
 * does, so pass a `limits.max_elements` large enough for the element count if
 * the default (1,000,000) is insufficient.
 */
export function digestCanonicalArray(elements: readonly unknown[], limits: CanonicalEncodingLimits = {}): DigestText {
  const hash = createHash("sha256");
  hash.update(encodeArrayHeader(elements.length));
  for (const element of elements) hash.update(canonicalBytes(element, limits));
  return `sha256:${hash.digest("hex")}`;
}

export function digestEnvelope(
  digestDomain: string,
  digestRecipeId: string,
  recipeVersion: number,
  payloadSchemaId: string,
  payloadSchemaVersion: number,
  payload: unknown,
  options: DigestOptions = {},
): readonly ["urdira", number, string, string, number, string, number, "sha256", unknown] {
  const encodingVersion = options.canonical_encoding_version ?? 1;
  const algorithm = options.hash_algorithm ?? "sha256";
  if (encodingVersion !== 1) fail("uce:unsupported_encoding_version", "recipe_validation", { canonical_encoding_version: encodingVersion, supported_encoding_versions: [1] });
  if (algorithm !== "sha256") fail("uce:unsupported_hash_algorithm", "recipe_validation", { hash_algorithm: algorithm, supported_hash_algorithms: ["sha256"] });
  if (!digestDomain || !digestRecipeId || !payloadSchemaId || !Number.isSafeInteger(recipeVersion) || recipeVersion < 1 || !Number.isSafeInteger(payloadSchemaVersion) || payloadSchemaVersion < 1) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID" });
  return ["urdira", encodingVersion, digestDomain, digestRecipeId, recipeVersion, payloadSchemaId, payloadSchemaVersion, algorithm, payload];
}

export function computeDigest(
  digestDomain: string,
  digestRecipeId: string,
  recipeVersion: number,
  payloadSchemaId: string,
  payloadSchemaVersion: number,
  payload: unknown,
  options: DigestOptions = {},
): DigestText {
  return digestBytes(canonicalBytes(digestEnvelope(digestDomain, digestRecipeId, recipeVersion, payloadSchemaId, payloadSchemaVersion, payload, options)));
}

/**
 * `computeDigest` for an ARRAY payload, hashed incrementally: byte-identical to
 * `computeDigest(..., payloadElements)` (the envelope is a 9-element canonical
 * array whose final element is the payload, and a canonical array's bytes are
 * its header followed by each element's own canonical bytes), but no single
 * `encodeCanonical` call ever sees more than one payload element — so the
 * aggregate never trips `max_bytes`/`max_elements` limits sized for individual
 * values. Use this for set digests that scale with workspace size (e.g. the
 * snapshot record-set digest over every visible record).
 */
/**
 * `computeDigest` for a MAP payload whose single large field is an array,
 * hashed incrementally: byte-identical to
 * `computeDigest(..., { ...scalarFields, [arrayField]: arrayElements })`,
 * but no single `encodeCanonical` call ever sees more than one array element.
 * Canonical map framing is reproduced exactly: entries sorted by encoded key
 * bytes, the array field's value emitted as its header followed by each
 * element's own canonical bytes.
 */
export function computeDigestOverMapPayloadWithArrayField(
  digestDomain: string,
  digestRecipeId: string,
  recipeVersion: number,
  payloadSchemaId: string,
  payloadSchemaVersion: number,
  scalarFields: Readonly<Record<string, unknown>>,
  arrayField: string,
  arrayElements: readonly unknown[],
  options: DigestOptions = {},
): DigestText {
  if (Object.hasOwn(scalarFields, arrayField)) fail("uce:duplicate_map_key", "normalize", { byte_offset: 0, duplicate_key: arrayField });
  const envelope = digestEnvelope(digestDomain, digestRecipeId, recipeVersion, payloadSchemaId, payloadSchemaVersion, null, options);
  const hash = createHash("sha256");
  hash.update(encodeArrayHeader(envelope.length));
  for (let index = 0; index < envelope.length - 1; index += 1) hash.update(canonicalBytes(envelope[index]));
  const fields: Array<{ keyBytes: Uint8Array; emit: () => void }> = Object.entries(scalarFields).map(([key, value]) => ({
    keyBytes: canonicalBytes(key),
    emit: () => hash.update(canonicalBytes(value)),
  }));
  fields.push({
    keyBytes: canonicalBytes(arrayField),
    emit: () => {
      hash.update(encodeArrayHeader(arrayElements.length));
      for (const element of arrayElements) hash.update(canonicalBytes(element));
    },
  });
  fields.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
  hash.update(encodeMapHeader(fields.length));
  for (const field of fields) { hash.update(field.keyBytes); field.emit(); }
  return `sha256:${hash.digest("hex")}`;
}

export function computeDigestOverArrayPayload(
  digestDomain: string,
  digestRecipeId: string,
  recipeVersion: number,
  payloadSchemaId: string,
  payloadSchemaVersion: number,
  payloadElements: readonly unknown[],
  options: DigestOptions = {},
): DigestText {
  const envelope = digestEnvelope(digestDomain, digestRecipeId, recipeVersion, payloadSchemaId, payloadSchemaVersion, null, options);
  const hash = createHash("sha256");
  hash.update(encodeArrayHeader(envelope.length));
  for (let index = 0; index < envelope.length - 1; index += 1) hash.update(canonicalBytes(envelope[index]));
  hash.update(encodeArrayHeader(payloadElements.length));
  for (const element of payloadElements) hash.update(canonicalBytes(element));
  return `sha256:${hash.digest("hex")}`;
}

export const digestCanonical = computeDigest;

export function encodeDigest(value: string): Uint8Array {
  const bytes = digestToBytes(value);
  return encodeCanonical(["sha256", bytes]);
}

export function decodeDigest(bytes: Uint8Array): DigestText {
  const value = decodeCanonical(bytes);
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "sha256" || !(value[1] instanceof Uint8Array) || value[1].length !== 32) {
    fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "Digest" });
  }
  return `sha256:${Buffer.from(value[1]).toString("hex")}`;
}

export function digestToBytes(value: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "Digest" });
  return Uint8Array.from(Buffer.from(value.slice(7), "hex"));
}

export function computeDigestRecipe(
  recipe: DigestRecipe | DigestRecipeDefinition,
  context: DigestComputationContext,
  resolveReferencedDigest?: (recipeId: string, recipeVersion: number, context: DigestComputationContext) => string,
): DigestText {
  const rawBinding = recipe.payload_binding;
  if (typeof rawBinding === "string" && rawBinding !== "direct_value" && rawBinding !== "verified_input" && rawBinding !== "record" && rawBinding !== "scalar") {
    fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID", payload_binding: rawBinding });
  }
  const recipeId = "digest_recipe_id" in recipe ? recipe.digest_recipe_id : "";
  const recipeVersion = typeof recipe.recipe_version === "number" ? recipe.recipe_version : Number(recipe.recipe_version);
  const domain = recipe.digest_domain;
  const payloadSchemaId = recipe.payload_schema_id;
  const payloadSchemaVersion = typeof recipe.payload_schema_version === "number" ? recipe.payload_schema_version : Number(recipe.payload_schema_version);
  if (!domain || !payloadSchemaId || !Number.isSafeInteger(recipeVersion) || recipeVersion < 1 || !Number.isSafeInteger(payloadSchemaVersion) || payloadSchemaVersion < 1) {
    fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID" });
  }
  const coordinate = documentedDigestRecipeCoordinates.find((candidate) => {
    if (candidate.digest_recipe_id !== recipeId || candidate.digest_domain !== domain) return false;
    try {
      return payloadSchemaIdFor(candidate) === payloadSchemaId && (candidate.payload_schema_version ?? 1) === payloadSchemaVersion;
    } catch {
      return false;
    }
  }) ?? documentedDigestRecipeCoordinates.find((candidate) => candidate.digest_recipe_id === recipeId && candidate.digest_domain === domain);
  if (!coordinate) {
    fail("uce:unknown_digest_recipe", "recipe_validation", { digest_recipe_id: recipeId, recipe_version: recipeVersion });
  }
  if (recipeVersion !== 1) fail("uce:unsupported_digest_recipe_version", "recipe_validation", { digest_recipe_id: recipeId, recipe_version: recipeVersion, available_recipe_versions: [1] });
  if (!digestDomainRegistry.some((entry) => entry.digest_domain === domain)) {
    fail("uce:unknown_digest_domain", "recipe_validation", { digest_domain: domain, registry_snapshot_id: "core" });
  }
  const authoritativeDefinition = digestRecipeVariantDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId && candidate.digest_domain === domain && candidate.payload_schema_id === payloadSchemaId && Number(candidate.payload_schema_version) === payloadSchemaVersion)
    ?? digestRecipeDefinitions.find((candidate) => candidate.digest_recipe_id === recipeId && candidate.digest_domain === domain);
  if (!authoritativeDefinition) fail("uce:unknown_digest_recipe", "recipe_validation", { digest_recipe_id: recipeId, registry_snapshot_id: "core" });
  const authoritativePayloadSchemaId = authoritativeDefinition.payload_schema_id;
  const authoritativePayloadSchemaVersion = Number(authoritativeDefinition.payload_schema_version);
  if (payloadSchemaId !== authoritativePayloadSchemaId || payloadSchemaVersion !== authoritativePayloadSchemaVersion) {
    fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SCHEMA_COORDINATE_MISMATCH", payload_schema_id: payloadSchemaId, payload_schema_version: payloadSchemaVersion });
  }
  if (!schemaCoordinateExists(payloadSchemaId, payloadSchemaVersion)) fail("uce:unknown_schema", "recipe_validation", { schema_id: payloadSchemaId, schema_version: payloadSchemaVersion, registry_snapshot_id: "core" });
  const targetField = "target_field" in recipe && typeof recipe.target_field === "string" ? recipe.target_field : coordinate.target_field;
  const authoritativeMode = authoritativeDefinition.payload_binding;
  const authoritativeBinding = ((authoritativeMode === "record" || authoritativeMode === "scalar") ? payloadBindingFor(coordinate) : authoritativeMode) as DigestPayloadBinding | string;
  const binding = rawBinding === "record" || rawBinding === "scalar" ? authoritativeBinding : rawBinding ?? authoritativeBinding;
  if (rawBinding !== undefined && !sameBinding(rawBinding, authoritativeBinding)) {
    fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID", expected_binding: typeof authoritativeBinding === "string" ? authoritativeBinding : authoritativeBinding.binding_kind });
  }
  const expectsVerifiedInput = coordinate.contract_kind === "terminal_recipe" || isWholeVerifiedInput(coordinate);
  assertNoTargetSelfReference(binding, targetField);
  if (expectsVerifiedInput && binding !== "verified_input") {
    fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID", expected_binding: "verified_input" });
  }
  const verifiedInputSchemaId = authoritativeDefinition.verified_input_schema_id;
  if (verifiedInputSchemaId) {
    if (context.verified_input === undefined) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SOURCE_PATH_INVALID", source_path: "/verified_input" });
    validateDigestPayload(context.verified_input, verifiedInputSchemaId, Number(authoritativeDefinition.verified_input_schema_version));
  }
  const payload = buildPayload(binding, context, resolveReferencedDigest, targetField);
  validateDigestPayload(payload, payloadSchemaId, payloadSchemaVersion);
  return computeDigest(domain, recipeId, recipeVersion, payloadSchemaId, payloadSchemaVersion, payload);
}

function sameBinding(left: DigestPayloadBinding | string, right: DigestPayloadBinding | string): boolean {
  if (typeof left === "string" || typeof right === "string") {
    if (typeof left === "string" && typeof right === "object") return (left === "record" || left === "scalar") && right.binding_kind === left;
    if (typeof right === "string" && typeof left === "object") return (right === "record" || right === "scalar") && left.binding_kind === right;
    return left === right;
  }
  if (left.binding_kind !== right.binding_kind) return false;
  if (!("field_bindings" in left) || !("field_bindings" in right)) {
    return "source_path" in left && "source_path" in right && left.source_path === right.source_path;
  }
  if (left.field_bindings.length !== right.field_bindings.length) return false;
  return left.field_bindings.every((leftField, index) => {
    const rightField = right.field_bindings[index];
    return rightField !== undefined
      && leftField.payload_field === rightField.payload_field
      && leftField.source_path === rightField.source_path
      && leftField.value_mode === rightField.value_mode
      && leftField.referenced_digest_recipe_id === rightField.referenced_digest_recipe_id
      && leftField.referenced_digest_recipe_version === rightField.referenced_digest_recipe_version;
  });
}

export function verifyDigest(expected: string, actual: string, recipeId?: string, recipeVersion?: number): void {
  if (expected !== actual) fail("uce:digest_mismatch", "verify", { digest_recipe_id: recipeId, recipe_version: recipeVersion, expected_digest: expected, actual_digest: actual });
}

export function validateDigestRecipeGraph(recipes: readonly DigestRecipe[]): DigestRecipeGraphResult {
  const byCoordinate = new Map<string, DigestRecipe>();
  for (const recipe of recipes) {
    const coordinate = `${recipe.digest_recipe_id}@${recipe.recipe_version}`;
    if (byCoordinate.has(coordinate)) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "REFERENCED_RECIPE_INVALID", digest_recipe_id: recipe.digest_recipe_id, recipe_version: recipe.recipe_version });
    byCoordinate.set(coordinate, recipe);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (recipe: DigestRecipe, path: string[]): void => {
    const coordinate = `${recipe.digest_recipe_id}@${recipe.recipe_version}`;
    if (visiting.has(coordinate)) fail("uce:digest_recipe_cycle", "recipe_validation", { cycle_path: [...path, coordinate] });
    if (visited.has(coordinate)) return;
    visiting.add(coordinate);
    const binding = recipe.payload_binding;
    if (binding && typeof binding !== "string" && binding.binding_kind === "record") {
      for (const field of (binding as unknown as { field_bindings?: readonly DigestPayloadFieldBinding[] }).field_bindings ?? []) {
        if (field.value_mode !== "referenced_digest" || !field.referenced_digest_recipe_id) continue;
        const reference = byCoordinate.get(`${field.referenced_digest_recipe_id}@${Number(field.referenced_digest_recipe_version)}`);
        if (!reference) fail("uce:unknown_digest_recipe", "recipe_validation", { digest_recipe_id: field.referenced_digest_recipe_id });
        visit(reference, [...path, coordinate]);
      }
    }
    visiting.delete(coordinate);
    visited.add(coordinate);
  };
  for (const recipe of recipes) visit(recipe, []);
  return { recipes };
}

export function validateDigestEnvelope(bytes: Uint8Array, context: DigestEnvelopeValidationContext = {}): readonly unknown[] {
  const value = decodeCanonical(bytes);
  if (!Array.isArray(value) || value.length !== 9 || value[0] !== "urdira" || value[1] !== 1 || typeof value[2] !== "string" || typeof value[3] !== "string" || typeof value[4] !== "number" || !Number.isSafeInteger(value[4]) || value[4] < 1 || typeof value[5] !== "string" || typeof value[6] !== "number" || !Number.isSafeInteger(value[6]) || value[6] < 1 || value[7] !== "sha256") {
    fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "DigestEnvelope" });
  }
  if (!(context.digest_domains ?? digestDomainRegistry.map((entry) => entry.digest_domain)).includes(value[2] as string)) fail("uce:unknown_digest_domain", "verify", { digest_domain: value[2], registry_snapshot_id: "pinned" });
  const coordinate = documentedDigestRecipeCoordinates.find((recipe) => recipe.digest_recipe_id === value[3] && recipe.digest_domain === value[2]);
  if (!coordinate) fail("uce:unknown_digest_recipe", "verify", { digest_recipe_id: value[3], digest_domain: value[2] });
  const authoritativeDefinition = digestRecipeVariantDefinitions.find((recipe) => recipe.digest_recipe_id === value[3] && recipe.digest_domain === value[2] && recipe.payload_schema_id === value[5] && Number(recipe.payload_schema_version) === value[6])
    ?? digestRecipeDefinitions.find((recipe) => recipe.digest_recipe_id === value[3] && recipe.digest_domain === value[2]);
  if (!authoritativeDefinition) fail("uce:unknown_digest_recipe", "verify", { digest_recipe_id: value[3], registry_snapshot_id: "pinned" });
  const authoritativeRecipeVersion = Number(authoritativeDefinition.recipe_version);
  if (value[4] !== authoritativeRecipeVersion) fail("uce:unsupported_digest_recipe_version", "verify", { digest_recipe_id: value[3], recipe_version: value[4], available_recipe_versions: [authoritativeRecipeVersion] });
  if (context.digest_recipes && !context.digest_recipes.some((recipe) => recipe.digest_recipe_id === value[3] && recipe.recipe_version === value[4])) fail("uce:unsupported_digest_recipe_version", "verify", { digest_recipe_id: value[3], recipe_version: value[4], available_recipe_versions: [authoritativeRecipeVersion] });
  if (value[5] !== authoritativeDefinition.payload_schema_id || value[6] !== Number(authoritativeDefinition.payload_schema_version)) fail("uce:digest_binding_invalid", "verify", { binding_failure_kind: "SCHEMA_COORDINATE_MISMATCH", payload_schema_id: value[5], payload_schema_version: value[6] });
  if (!schemaCoordinateExists(authoritativeDefinition.payload_schema_id, Number(authoritativeDefinition.payload_schema_version))) fail("uce:unknown_schema", "verify", { schema_id: authoritativeDefinition.payload_schema_id, schema_version: Number(authoritativeDefinition.payload_schema_version), registry_snapshot_id: "core" });
  const availableSchemas = context.schemas ?? [...coreSchemaDefinitions, ...digestPayloadSchemaDefinitions].map((schema) => ({ schema_id: schema.schema_id, schema_version: schema.schema_version }));
  if (!availableSchemas.some((schema) => schema.schema_id === value[5] && schema.schema_version === value[6])) fail("uce:unsupported_schema_version", "verify", { schema_id: value[5], schema_version: value[6], available_schema_versions: [] });
  validateDigestPayload(value[8], value[5] as string, value[6] as number);
  return value;
}

function validateDigestPayload(payload: unknown, schemaId: string, schemaVersion: number): void {
  const schemas = [...coreSchemaDefinitions, ...digestPayloadSchemaDefinitions];
  const schema = schemas.find((candidate) => candidate.schema_id === schemaId && candidate.schema_version === schemaVersion);
  if (!schema) fail("uce:unknown_schema", "recipe_validation", { schema_id: schemaId, schema_version: schemaVersion, registry_snapshot_id: "core" });
  try {
    validateSchemaValue(schema, payload, { schemas: [...coreSchemaDefinitions, schema] });
  } catch (error) {
    fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "PAYLOAD_SCHEMA_MISMATCH" }, error instanceof Error ? error.message : "Digest payload does not match its schema");
  }
  validateSchemaBoundPayload(schema, payload, schemas);
}

/**
 * The contracts validator checks the adjacent coordinate fields and the
 * non-empty byte requirement. Digest payloads additionally require those
 * bytes to be one canonical UCE item conforming to the selected coordinate.
 * Keep this walk separate from ordinary typed encoding because model-backed
 * schema references are validated by the contracts package and are not
 * executable local type expressions.
 */
function validateSchemaBoundPayload(schema: CanonicalSchemaDefinition, value: unknown, schemas: readonly CanonicalSchemaDefinition[]): void {
  visitBoundType(schema.root_type, value, schema, schemas, new Set());
}

function visitBoundType(
  type: CanonicalTypeExpression,
  value: unknown,
  ownerSchema: CanonicalSchemaDefinition,
  schemas: readonly CanonicalSchemaDefinition[],
  activeSchemas: Set<string>,
): void {
  if (type.type_kind === "schema_reference") {
    if (type.reference_scope === "local") {
      const local = ownerSchema.type_definitions.find((definition) => definition.type_name === type.type_name)?.type_expression;
      if (local) visitBoundType(local, value, ownerSchema, schemas, activeSchemas);
      return;
    }
    if (type.type_name === "JsonValue") return;
    const referenced = schemas.find((candidate) => candidate.schema_id === type.schema_id && candidate.schema_version === type.schema_version);
    if (!referenced) fail("uce:unknown_schema", "schema_validation", { schema_id: type.schema_id, schema_version: type.schema_version, registry_snapshot_id: "core" });
    const coordinate = `${referenced.schema_id}@${referenced.schema_version}`;
    if (activeSchemas.has(coordinate)) return;
    if (referenced.root_type.type_kind === "schema_reference" && referenced.root_type.schema_id === referenced.schema_id && referenced.root_type.schema_version === referenced.schema_version) return;
    activeSchemas.add(coordinate);
    visitBoundType(referenced.root_type, value, referenced, schemas, activeSchemas);
    activeSchemas.delete(coordinate);
    return;
  }
  switch (type.type_kind) {
    case "record":
      if (!isObjectRecord(value)) return;
      for (const field of type.fields) {
        if (!Object.hasOwn(value, field.field_name)) continue;
        const fieldValue = value[field.field_name];
        if (field.value_type.type_kind === "bytes" && field.value_type.bound_schema_id_field && field.value_type.bound_schema_version_field) {
          validateBoundField(field, fieldValue, value, field.value_type.bound_schema_id_field, field.value_type.bound_schema_version_field, schemas);
        }
        visitBoundType(field.value_type, fieldValue, ownerSchema, schemas, activeSchemas);
      }
      return;
    case "sequence":
    case "set":
    case "ordered_set":
      if (Array.isArray(value)) for (const entry of value) visitBoundType(type.element_type, entry, ownerSchema, schemas, activeSchemas);
      return;
    case "map":
      if (isObjectRecord(value)) for (const entry of Object.values(value)) visitBoundType(type.value_type, entry, ownerSchema, schemas, activeSchemas);
      return;
    case "union":
      if (!isObjectRecord(value) || typeof value[type.discriminator_field] !== "string") return;
      for (const variant of type.variants) {
        if (variant.discriminator_value !== value[type.discriminator_field]) continue;
        visitBoundType({ type_kind: "record", fields: [{ field_name: type.discriminator_field, description: type.discriminator_description, presence: "required", value_type: { type_kind: "enum", values: [variant.discriminator_value] } }, ...variant.fields] }, value, ownerSchema, schemas, activeSchemas);
        return;
      }
      return;
    default:
      return;
  }
}

function validateBoundField(
  field: SchemaFieldDefinition,
  value: unknown,
  record: Record<string, unknown>,
  schemaIdField: string,
  schemaVersionField: string,
  schemas: readonly CanonicalSchemaDefinition[],
): void {
  if (!(value instanceof Uint8Array)) return;
  const schemaId = record[schemaIdField];
  const schemaVersion = record[schemaVersionField];
  if (typeof schemaId !== "string" || typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) return;
  const boundSchema = schemas.find((candidate) => candidate.schema_id === schemaId && candidate.schema_version === schemaVersion);
  if (!boundSchema) fail("uce:unknown_schema", "schema_validation", { schema_id: schemaId, schema_version: schemaVersion, value_path: `/${field.field_name}` });
  const decoded = decodeCanonical(value);
  try {
    validateSchemaValue(boundSchema, decoded, { schemas: [...coreSchemaDefinitions, boundSchema] });
  } catch (error) {
    fail("uce:schema_validation_failed", "schema_validation", { schema_id: schemaId, schema_version: schemaVersion, value_path: `/${field.field_name}`, validation_kind: "PAYLOAD_SCHEMA_MISMATCH" }, error instanceof Error ? error.message : "SchemaBoundBytes does not conform to its bound schema");
  }
  validateSchemaBoundPayload(boundSchema, decoded, schemas);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function buildPayload(
  binding: DigestPayloadBinding | string | undefined,
  context: DigestComputationContext,
  resolveReferencedDigest?: (recipeId: string, recipeVersion: number, context: DigestComputationContext) => string,
  targetField?: string,
): unknown {
  if (!binding || binding === "direct_value") return omitTargetField(context.target, targetField);
  if (typeof binding === "string") {
    if (binding === "verified_input") {
      if (context.verified_input === undefined) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SOURCE_PATH_INVALID", source_path: "/verified_input" });
      return context.verified_input;
    }
    return omitTargetField(context.target, targetField);
  }
  const typedBinding = binding as unknown as { binding_kind: string; source_path?: string; field_bindings?: readonly DigestPayloadFieldBinding[] };
  if (typedBinding.binding_kind === "scalar") {
    if (!typedBinding.source_path) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SOURCE_PATH_INVALID" });
    return sourceValue(typedBinding.source_path, context);
  }
  if (typedBinding.binding_kind !== "record" || !typedBinding.field_bindings) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID" });
  const payload: Record<string, unknown> = {};
  const bindings = typedBinding.field_bindings;
  const seen = new Set<string>();
  for (const fieldBinding of bindings) {
    if (seen.has(fieldBinding.payload_field)) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "PAYLOAD_FIELD_DUPLICATE", payload_field: fieldBinding.payload_field });
    seen.add(fieldBinding.payload_field);
    if (fieldBinding.value_mode === "direct_value") {
      if (fieldBinding.source_path.startsWith("/target/") && !hasCanonicalPath(context.target, fieldBinding.source_path.slice("/target".length))) continue;
      payload[fieldBinding.payload_field] = sourceValue(fieldBinding.source_path, context);
    }
    else if (fieldBinding.value_mode === "referenced_digest") {
      if (!fieldBinding.referenced_digest_recipe_id || !fieldBinding.referenced_digest_recipe_version || !resolveReferencedDigest) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "REFERENCED_RECIPE_INVALID" });
      payload[fieldBinding.payload_field] = resolveReferencedDigest(fieldBinding.referenced_digest_recipe_id, Number(fieldBinding.referenced_digest_recipe_version), context);
    } else fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "VALUE_MODE_INVALID", payload_field: fieldBinding.payload_field });
  }
  return payload;
}

function omitTargetField(target: unknown, targetField?: string): unknown {
  if (!targetField || target === null || typeof target !== "object" || Array.isArray(target)) return target;
  const segments = targetPathSegments(targetField);
  if (segments.length === 0) return target;
  const omit = (value: unknown, index: number): unknown => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    const segment = segments[index]!;
    if (index === segments.length - 1) delete copy[segment];
    else if (Object.hasOwn(copy, segment)) copy[segment] = omit(copy[segment], index + 1);
    return copy;
  };
  return omit(target, 0);
}

function sourceValue(path: string, context: DigestComputationContext): unknown {
  if (path === "/verified_input") {
    if (context.verified_input === undefined) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SOURCE_PATH_INVALID", source_path: path });
    return context.verified_input;
  }
  if (path.startsWith("/target")) return readCanonicalPointer(context.target, path.slice("/target".length) || "");
  return readCanonicalPointer(context, path);
}

function hasCanonicalPath(value: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  let current: unknown = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) return false;
      current = current[Number(key)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else return false;
  }
  return true;
}

function assertNoTargetSelfReference(binding: DigestPayloadBinding | string | undefined, targetField: string | undefined): void {
  if (!binding || typeof binding === "string") return;
  const normalizedTarget = normalizeTargetPath(targetField);
  const paths = binding.binding_kind === "record"
    ? (binding as { field_bindings: readonly DigestPayloadFieldBinding[] }).field_bindings.map((field) => field.source_path)
    : [((binding as { source_path?: string }).source_path ?? "")];
  for (const sourcePath of paths) {
    const path = normalizeSourcePath(sourcePath);
    const targetsWholeRecord = path.length === 0;
    const targetsField = normalizedTarget !== undefined && path.length === normalizedTarget.length && path.every((segment, index) => segment === normalizedTarget[index]);
    if (targetsWholeRecord || targetsField) fail("uce:digest_binding_invalid", "recipe_validation", { binding_failure_kind: "SELF_REFERENCE", source_path: sourcePath, target_field: targetField });
  }
}

function targetPathSegments(targetField: string): readonly string[] {
  const withoutModel = targetField.includes(".") && !targetField.startsWith("/") ? targetField.slice(targetField.indexOf(".") + 1) : targetField;
  const rawSegments = withoutModel.startsWith("/") ? withoutModel.split("/").slice(1) : withoutModel.split(".");
  return rawSegments.filter(Boolean).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function normalizeTargetPath(targetField: string | undefined): readonly string[] | undefined {
  if (!targetField) return undefined;
  const segments = targetPathSegments(targetField);
  return segments.length > 0 ? segments : undefined;
}

function normalizeSourcePath(sourcePath: string): readonly string[] {
  const segments = sourcePath.startsWith("/") ? sourcePath.split("/").slice(1) : sourcePath.split(".");
  if (segments[0] === "target") segments.shift();
  return segments.filter(Boolean).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function digestPayloadBytes(payload: unknown): Uint8Array { return encodeCanonical(payload); }

export function compareDigestPayloads(left: unknown, right: unknown): number {
  return compareCanonicalValues(left, right, { comparator_id: "core:payload", comparator_version: 1, sort_keys: [{ value_path: "", comparison_mode: "uce_bytes", direction: "ascending", absent_order: "forbidden" }] });
}

export function schemaCoordinateExists(schemaId: string, version: number): boolean {
  return [...coreSchemaDefinitions, ...digestPayloadSchemaDefinitions].some((schema) => schema.schema_id === schemaId && schema.schema_version === version);
}
