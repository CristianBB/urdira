import {
  coreSchemaDefinitions,
  type CanonicalSchemaDefinition,
  type CanonicalTypeExpression,
  type SchemaFieldDefinition,
  type SchemaValidationContext,
  validateSchemaValue,
} from "@urdira/contracts";
import { canonicalComparatorRegistry } from "./registries.js";
import { sortCanonicalValues, type CanonicalComparator } from "./comparators.js";
import { compareBytes, decodeCanonical, encodeCanonical, encodeDecimalFraction, encodeFloat64 } from "./cbor.js";
import { fail } from "./errors.js";
import { digestToBytes } from "./digests.js";
import { normalizeBigInteger, normalizeBytes, normalizeDigest, normalizeExactDecimal, normalizeText, normalizeTimestamp, timestampFromNanoseconds, timestampNanoseconds } from "./scalars.js";

export function encodeTypedValue(value: unknown, type: CanonicalTypeExpression, context: SchemaValidationContext = {}): Uint8Array {
  if (type.type_kind === "schema_reference" && type.type_name === "JsonValue") return encodeJsonValue(value);
  const resolved = resolveType(type, context);
  switch (resolved.type_kind) {
    case "null": if (value !== null) typeError("null"); return encodeCanonical(null);
    case "boolean": if (typeof value !== "boolean") typeError("boolean"); return encodeCanonical(value);
    case "safe_integer": if (typeof value !== "number" || !Number.isSafeInteger(value) || (resolved.minimum !== undefined && value < resolved.minimum) || (resolved.maximum !== undefined && value > resolved.maximum)) rangeError("safe_integer"); return encodeCanonical(value);
    case "big_integer": {
      const parsed = normalizeBigInteger(value);
      checkBigIntegerBounds(resolved.minimum, resolved.maximum, parsed);
      return encodeCanonical(parsed);
    }
    case "float64": if (typeof value !== "number" || !Number.isFinite(value)) rangeError("float64"); checkNumberBounds(resolved.minimum, resolved.maximum, value, "float64"); return encodeFloat64(Object.is(value, -0) ? 0 : value);
    case "exact_decimal": return encodeDecimal(value, resolved);
    case "text": { const normalized = normalizeText(value); checkTextBounds(resolved.minimum_code_point_count, resolved.maximum_code_point_count, normalized); return encodeCanonical(normalized); }
    case "bytes": { const bytes = normalizeBytes(value); checkByteBounds(resolved.minimum_byte_length, resolved.maximum_byte_length, bytes.byteLength); return encodeCanonical(bytes); }
    case "timestamp": { const normalized = normalizeTimestamp(value); checkTimestampBounds(resolved.earliest, resolved.latest, normalized); return encodeCanonical(timestampNanoseconds(normalized)); }
    case "digest": return encodeCanonical(["sha256", digestToBytes(normalizeDigest(value))]);
    case "enum": if (typeof value !== "string" || !resolved.values.includes(value)) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "ENUM_VALUE_INVALID" }); return encodeCanonical(value);
    case "sequence": return encodeSequence(value, resolved, context);
    case "set": return encodeSet(value, resolved, context);
    case "ordered_set": return encodeOrderedSet(value, resolved, context);
    case "map": return encodeMap(value, resolved, context);
    case "record": return encodeRecord(value, resolved.fields, context);
    case "union": return encodeUnion(value, resolved, context);
    case "schema_reference": return encodeTypedValue(value, resolveType(resolved, context), context);
  }
}

export function encodeSchemaValueTyped(value: unknown, schema: CanonicalSchemaDefinition, context: SchemaValidationContext = {}): Uint8Array {
  const resolvedContext: SchemaValidationContext = { schemas: context.schemas ?? coreSchemaDefinitions, comparators: context.comparators ?? canonicalComparatorRegistry };
  if (context.localDefinitions) resolvedContext.localDefinitions = context.localDefinitions;
  return encodeTypedValue(value, schema.root_type, resolvedContext);
}

export function decodeTypedValue(bytes: Uint8Array, type: CanonicalTypeExpression, context: SchemaValidationContext = {}): unknown {
  if (type.type_kind === "schema_reference" && type.type_name === "JsonValue") return decodeJsonValue(decodeCanonical(bytes));
  const resolvedType = resolveType(type, context);
  if (resolvedType.type_kind === "float64") assertFloatEncoding(bytes);
  const decoded = decodeCanonical(bytes);
  return decodeTyped(decoded, resolvedType, context);
}

function decodeTyped(value: unknown, type: CanonicalTypeExpression, context: SchemaValidationContext): unknown {
  switch (type.type_kind) {
    case "null": if (value !== null) typeError("null"); return null;
    case "boolean": if (typeof value !== "boolean") typeError("boolean"); return value;
    case "safe_integer": if (typeof value !== "number" || !Number.isSafeInteger(value) || (type.minimum !== undefined && value < type.minimum) || (type.maximum !== undefined && value > type.maximum)) rangeError("safe_integer"); return value;
    case "float64": if (typeof value !== "number" || !Number.isFinite(value) || (type.minimum !== undefined && value < type.minimum) || (type.maximum !== undefined && value > type.maximum)) rangeError("float64"); return Object.is(value, -0) ? 0 : value;
    case "text": if (typeof value !== "string") typeError("text"); normalizeText(value); checkTextBounds(type.minimum_code_point_count, type.maximum_code_point_count, value); return value;
    case "enum": if (typeof value !== "string" || !type.values.includes(value)) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "ENUM_VALUE_INVALID" }); return value;
    case "digest": {
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== "sha256" || !(value[1] instanceof Uint8Array) || value[1].length !== 32) typeError("Digest");
      return `sha256:${Buffer.from(value[1]).toString("hex")}`;
    }
    case "timestamp": if (typeof value !== "bigint" && typeof value !== "number") typeError("Timestamp"); { const normalized = timestampFromNanoseconds(value); checkTimestampBounds(type.earliest, type.latest, normalized); return normalized; }
    case "exact_decimal": if (!isDecimalFraction(value)) typeError("ExactDecimal"); { const normalized = decimalFromFraction(value.value as readonly [number | bigint, number | bigint], type.scale_policy); checkDecimalBounds(type.minimum, type.maximum, normalized); return normalized; }
    case "big_integer": if (typeof value !== "bigint" && typeof value !== "number") typeError("BigInteger"); { const parsed = BigInt(value); checkBigIntegerBounds(type.minimum, type.maximum, parsed); return `bigint:${parsed.toString()}`; }
    case "bytes": if (!(value instanceof Uint8Array)) typeError("Bytes"); checkByteBounds(type.minimum_byte_length, type.maximum_byte_length, value.byteLength); return value;
    case "sequence": if (!Array.isArray(value)) typeError("Sequence"); checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "sequence"); return value.map((entry) => decodeTyped(entry, resolveType(type.element_type, context), context));
    case "set": {
      if (!Array.isArray(value)) typeError("Set");
      checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "set");
      const elementType = resolveType(type.element_type, context);
      const encoded = value.map((entry) => encodeTypedValue(entry, elementType, context));
      for (let index = 1; index < encoded.length; index += 1) {
        if (compareBytes(encoded[index - 1]!, encoded[index]!) >= 0) fail("uce:non_canonical_encoding", "decode", { value_path: "", canonicality_kind: "SET_ORDER" });
      }
      return value.map((entry) => decodeTyped(entry, elementType, context));
    }
    case "ordered_set": {
      if (!Array.isArray(value)) typeError("OrderedSet");
      checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "ordered_set");
      const comparator = (context.comparators ?? canonicalComparatorRegistry).find((candidate) => candidate.comparator_id === type.comparator_id && candidate.comparator_version === type.comparator_version);
      if (!comparator) fail("uce:unknown_canonical_comparator", "schema_validation", { comparator_id: type.comparator_id, comparator_version: type.comparator_version });
      const elementType = resolveType(type.element_type, context);
      const decoded = value.map((entry) => decodeTyped(entry, elementType, context));
      const sorted = sortCanonicalValues(decoded, comparator as CanonicalComparator);
      if (sorted.length !== decoded.length || sorted.some((entry, index) => compareBytes(encodeTypedValue(entry, elementType, context), encodeTypedValue(decoded[index]!, elementType, context)) !== 0)) {
        fail("uce:non_canonical_encoding", "decode", { value_path: "", canonicality_kind: "ORDERED_SET_ORDER" });
      }
      const encoded = decoded.map((entry) => encodeTypedValue(entry, elementType, context));
      for (let index = 1; index < encoded.length; index += 1) if (compareBytes(encoded[index - 1]!, encoded[index]!) === 0) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "DUPLICATE_SET_ELEMENT" });
      return decoded;
    }
    case "map": {
      if (!isRecord(value)) typeError("Map");
      checkCollectionBounds(type.minimum_entry_count, type.maximum_entry_count, Object.keys(value).length, "map");
      const valueType = resolveType(type.value_type, context);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeTyped(entry, valueType, context)]));
    }
    case "record": {
      if (!isRecord(value)) typeError("Record");
      const allowed = new Set(type.fields.map((field) => field.field_name));
      for (const key of Object.keys(value)) if (!allowed.has(key)) fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${key}`, validation_kind: "UNKNOWN_FIELD" });
      const decodedFields: Record<string, unknown> = {};
      for (const field of type.fields) {
        if (!Object.hasOwn(value, field.field_name)) {
          if (field.presence === "required") fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${field.field_name}`, validation_kind: "REQUIRED_FIELD_MISSING" });
          continue;
        }
        decodedFields[field.field_name] = decodeFieldValue(value, field, context);
      }
      return decodedFields;
    }
    case "union": {
      if (!isRecord(value) || typeof value[type.discriminator_field] !== "string") typeError("Union");
      const variant = type.variants.find((candidate) => candidate.discriminator_value === value[type.discriminator_field]);
      if (!variant) fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${type.discriminator_field}`, validation_kind: "ENUM_VALUE_INVALID" });
      return decodeTyped(value, { type_kind: "record", fields: [{ field_name: type.discriminator_field, description: type.discriminator_description, presence: "required", value_type: { type_kind: "enum", values: [variant.discriminator_value] } }, ...variant.fields] }, context);
    }
    default: return value;
  }
}

function encodeDecimal(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "exact_decimal" }>): Uint8Array {
  const normalizedValue = normalizeExactDecimal(value, type.scale_policy);
  checkDecimalBounds(type.minimum, type.maximum, normalizedValue);
  const normalized = normalizedValue.slice(8);
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ""] = unsigned.split(".");
  const mantissaText = `${integer}${fraction}`;
  const mantissa = BigInt(`${negative && BigInt(mantissaText) !== 0n ? "-" : ""}${mantissaText}`);
  return encodeDecimalFraction(BigInt(-fraction.length), mantissa);
}

function encodeJsonValue(value: unknown): Uint8Array {
  if (value === null || typeof value === "string" || typeof value === "boolean") return encodeCanonical(value);
  if (typeof value === "number" && Number.isFinite(value)) return encodeCanonical(value);
  if (Array.isArray(value)) return concatHeaderAndValues(4, value.map((entry) => encodeJsonValue(entry)));
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, entry]) => [encodeCanonical(key), encodeJsonValue(entry)] as const).sort(([left], [right]) => compareBytes(left, right));
    return concatHeaderAndValues(5, entries.flat(), entries.length);
  }
  fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "JsonValue" });
}

function encodeSequence(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "sequence" }>, context: SchemaValidationContext): Uint8Array {
  if (!Array.isArray(value)) typeError("Sequence");
  checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "sequence");
  return concatHeaderAndValues(4, value.map((entry) => encodeTypedValue(entry, resolveType(type.element_type, context), context)));
}

function encodeSet(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "set" }>, context: SchemaValidationContext): Uint8Array {
  if (!Array.isArray(value)) typeError("Set");
  checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "set");
  const encoded = value.map((entry) => encodeTypedValue(entry, resolveType(type.element_type, context), context));
  assertUnique(encoded);
  encoded.sort(compareBytes);
  return concatHeaderAndValues(4, encoded);
}

function encodeOrderedSet(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "ordered_set" }>, context: SchemaValidationContext): Uint8Array {
  if (!Array.isArray(value)) typeError("OrderedSet");
  checkCollectionBounds(type.minimum_item_count, type.maximum_item_count, value.length, "ordered_set");
  const comparator = (context.comparators ?? canonicalComparatorRegistry).find((candidate) => candidate.comparator_id === type.comparator_id && candidate.comparator_version === type.comparator_version);
  if (!comparator) fail("uce:unknown_canonical_comparator", "schema_validation", { comparator_id: type.comparator_id, comparator_version: type.comparator_version });
  const normalized = sortCanonicalValues(value, comparator as CanonicalComparator);
  assertUnique(normalized.map((entry) => encodeTypedValue(entry, resolveType(type.element_type, context), context)));
  return concatHeaderAndValues(4, normalized.map((entry) => encodeTypedValue(entry, resolveType(type.element_type, context), context)));
}

function encodeMap(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "map" }>, context: SchemaValidationContext): Uint8Array {
  if (!isRecord(value)) typeError("Map");
  checkCollectionBounds(type.minimum_entry_count, type.maximum_entry_count, Object.keys(value).length, "map");
  const encoded = Object.entries(value).map(([key, entry]) => [encodeCanonical(key), encodeTypedValue(entry, resolveType(type.value_type, context), context)] as const).sort(([left], [right]) => compareBytes(left, right));
  return concatHeaderAndValues(5, encoded.flat(), encoded.length);
}

function encodeRecord(value: unknown, fields: readonly SchemaFieldDefinition[], context: SchemaValidationContext): Uint8Array {
  if (!isRecord(value)) typeError("Record");
  const allowed = new Set(fields.map((field) => field.field_name));
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${key}`, validation_kind: "UNKNOWN_FIELD" });
  const entries = fields.flatMap((field) => {
    if (!Object.hasOwn(value, field.field_name)) {
      if (field.presence === "required") fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${field.field_name}`, validation_kind: "REQUIRED_FIELD_MISSING" });
      return [];
    }
    return [[encodeCanonical(field.field_name), encodeFieldValue(value, field, context)]] as const;
  }).sort(([left], [right]) => compareBytes(left, right));
  return concatHeaderAndValues(5, entries.flat(), entries.length);
}

function encodeUnion(value: unknown, type: Extract<CanonicalTypeExpression, { type_kind: "union" }>, context: SchemaValidationContext): Uint8Array {
  if (!isRecord(value) || typeof value[type.discriminator_field] !== "string") fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${type.discriminator_field}`, validation_kind: "REQUIRED_FIELD_MISSING" });
  const variant = type.variants.find((candidate) => candidate.discriminator_value === value[type.discriminator_field]);
  if (!variant) fail("uce:schema_validation_failed", "schema_validation", { value_path: `/${type.discriminator_field}`, validation_kind: "ENUM_VALUE_INVALID" });
  return encodeRecord({ ...value, [type.discriminator_field]: value[type.discriminator_field] }, [{ field_name: type.discriminator_field, description: type.discriminator_description, presence: "required", value_type: { type_kind: "enum", values: [variant.discriminator_value] } }, ...variant.fields], context);
}

function resolveType(type: CanonicalTypeExpression, context: SchemaValidationContext): CanonicalTypeExpression {
  if (type.type_kind !== "schema_reference") return type;
  if (type.reference_scope === "local") {
    const local = context.localDefinitions?.get(type.type_name);
    if (!local) fail("uce:unknown_schema", "schema_validation", { schema_id: type.schema_id, schema_version: type.schema_version });
    return resolveType(local, context);
  }
  const schemas = context.schemas ?? coreSchemaDefinitions;
  const schema = Array.isArray(schemas)
    ? schemas.find((candidate) => candidate.schema_id === type.schema_id && candidate.schema_version === type.schema_version)
    : (schemas as ReadonlyMap<string, CanonicalSchemaDefinition>).get(`${type.schema_id}@${type.schema_version}`);
  if (schema && !(schema.root_type.type_kind === "schema_reference" && schema.root_type.schema_id === schema.schema_id)) return resolveType(schema.root_type, context);
  fail("uce:unknown_schema", "schema_validation", { schema_id: type.schema_id, schema_version: type.schema_version, registry_snapshot_id: "pinned" });
}

function parseLogicalType(logicalType: string): CanonicalTypeExpression {
  const sequence = logicalType.match(/^Sequence<(.+)>$/);
  if (sequence) return { type_kind: "sequence", element_type: parseLogicalType(sequence[1]!) };
  const set = logicalType.match(/^Set<(.+)>$/);
  if (set) return { type_kind: "set", element_type: parseLogicalType(set[1]!) };
  if (logicalType === "Boolean") return { type_kind: "boolean" };
  if (logicalType === "Digest") return { type_kind: "digest", allowed_hash_algorithms: ["sha256"] };
  if (logicalType === "Bytes" || logicalType === "SchemaBoundBytes") return { type_kind: "bytes" };
  if (logicalType === "PositiveInteger") return { type_kind: "safe_integer", minimum: 1 };
  if (logicalType === "Count") return { type_kind: "safe_integer", minimum: 0 };
  if (logicalType === "SafeInteger") return { type_kind: "safe_integer" };
  if (logicalType === "BigInteger") return { type_kind: "big_integer" };
  if (logicalType === "Float64") return { type_kind: "float64" };
  if (logicalType === "Timestamp") return { type_kind: "timestamp" };
  if (logicalType === "Text" || logicalType === "Identifier" || logicalType === "NamespacedIdentifier" || logicalType === "SemVer" || logicalType === "URI") return { type_kind: "text" };
  return { type_kind: "schema_reference", reference_scope: "external", type_name: logicalType, schema_id: `core:${logicalType}`, schema_version: 1 };
}

function isDecimalFraction(value: unknown): value is { readonly tag: 4; readonly value: readonly [number | bigint, number | bigint] } {
  if (!isRecord(value)) return false;
  const candidate = value as { readonly tag?: unknown; readonly value?: unknown };
  return candidate.tag === 4 && Array.isArray(candidate.value) && candidate.value.length === 2 && (typeof candidate.value[0] === "bigint" || typeof candidate.value[0] === "number") && (typeof candidate.value[1] === "bigint" || typeof candidate.value[1] === "number");
}

function decimalFromFraction(value: readonly [number | bigint, number | bigint], policy: "significant" | "insignificant"): string {
  const exponent = BigInt(value[0]);
  const mantissa = BigInt(value[1]);
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString();
  const scale = Number(-exponent);
  const unsigned = scale === 0 ? digits : digits.length <= scale ? `0.${"0".repeat(scale - digits.length)}${digits}` : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return normalizeExactDecimal(`decimal:${negative && mantissa !== 0n ? "-" : ""}${unsigned}`, policy);
}

function concatHeaderAndValues(major: number, values: readonly Uint8Array[], itemCount = values.length): Uint8Array {
  return concat(encodeCanonicalHeader(major, itemCount), ...values);
}

function encodeCanonicalHeader(major: number, length: number): Uint8Array { return encodeCanonicalHeaderBytes(major, length); }
function encodeCanonicalHeaderBytes(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length <= 0xff) return Uint8Array.of((major << 5) | 24, length);
  if (length <= 0xffff) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of((major << 5) | 26, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function assertUnique(values: readonly Uint8Array[]): void { for (let index = 1; index < values.length; index += 1) if (compareBytes(values[index - 1]!, values[index]!) === 0) fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "DUPLICATE_SET_ELEMENT" }); }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function typeError(expected_type: string): never { return fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type }); }
function rangeError(numeric_type: string): never { return fail("uce:numeric_value_out_of_range", "schema_validation", { value_path: "", numeric_type, range_failure_kind: "CONSTRAINT_FAILED" }); }

function checkNumberBounds(minimum: number | undefined, maximum: number | undefined, value: number, numericType: string): void {
  if (minimum !== undefined && value < minimum) rangeError(numericType);
  if (maximum !== undefined && value > maximum) rangeError(numericType);
}

function checkBigIntegerBounds(minimum: string | undefined, maximum: string | undefined, value: bigint): void {
  if (minimum !== undefined && value < BigInt(minimum.slice("bigint:".length))) rangeError("big_integer");
  if (maximum !== undefined && value > BigInt(maximum.slice("bigint:".length))) rangeError("big_integer");
}

function checkTextBounds(minimum: number | undefined, maximum: number | undefined, value: string): void {
  checkCollectionBounds(minimum, maximum, [...value].length, "text");
}

function checkByteBounds(minimum: number | undefined, maximum: number | undefined, length: number): void {
  checkCollectionBounds(minimum, maximum, length, "bytes");
}

function checkTimestampBounds(earliest: string | undefined, latest: string | undefined, value: string): void {
  const timestamp = timestampNanoseconds(value);
  if (earliest !== undefined && timestamp < timestampNanoseconds(earliest)) rangeError("timestamp");
  if (latest !== undefined && timestamp > timestampNanoseconds(latest)) rangeError("timestamp");
}

function checkDecimalBounds(minimum: string | undefined, maximum: string | undefined, value: string): void {
  if (minimum !== undefined && compareDecimalStrings(value, minimum) < 0) rangeError("exact_decimal");
  if (maximum !== undefined && compareDecimalStrings(value, maximum) > 0) rangeError("exact_decimal");
}

function compareDecimalStrings(left: string, right: string): number {
  const parse = (value: string) => {
    const text = value.slice("decimal:".length);
    const negative = text.startsWith("-");
    const unsigned = negative ? text.slice(1) : text;
    const [whole = "0", fraction = ""] = unsigned.split(".");
    return { negative, digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0", scale: fraction.length };
  };
  const a = parse(left); const b = parse(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const scale = Math.max(a.scale, b.scale);
  const ad = a.digits.padEnd(a.digits.length + scale - a.scale, "0");
  const bd = b.digits.padEnd(b.digits.length + scale - b.scale, "0");
  const comparison = ad.length === bd.length ? ad.localeCompare(bd) : ad.length - bd.length;
  return a.negative ? -comparison : comparison;
}

function checkCollectionBounds(minimum: number | undefined, maximum: number | undefined, count: number, collectionType: string): void {
  if (minimum !== undefined && count < minimum) rangeError(collectionType);
  if (maximum !== undefined && count > maximum) rangeError(collectionType);
}

function encodeFieldValue(record: Record<string, unknown>, field: SchemaFieldDefinition, context: SchemaValidationContext): Uint8Array {
  const type = resolveType(field.value_type, context);
  if (type.type_kind === "bytes" && type.bound_schema_id_field && type.bound_schema_version_field) {
    const bytes = normalizeBytes(record[field.field_name]);
    validateBoundSchemaBytes(bytes, record, type, context);
    return encodeCanonical(bytes);
  }
  return encodeTypedValue(record[field.field_name], type, context);
}

function decodeFieldValue(record: Record<string, unknown>, field: SchemaFieldDefinition, context: SchemaValidationContext): unknown {
  const type = resolveType(field.value_type, context);
  if (type.type_kind === "bytes" && type.bound_schema_id_field && type.bound_schema_version_field) {
    if (!(record[field.field_name] instanceof Uint8Array)) typeError("SchemaBoundBytes");
    validateBoundSchemaBytes(record[field.field_name] as Uint8Array, record, type, context);
    return record[field.field_name];
  }
  return decodeTyped(record[field.field_name], type, context);
}

function validateBoundSchemaBytes(bytes: Uint8Array, record: Record<string, unknown>, type: Extract<CanonicalTypeExpression, { type_kind: "bytes" }>, context: SchemaValidationContext): void {
  const schemaId = record[type.bound_schema_id_field!];
  const schemaVersionValue = record[type.bound_schema_version_field!];
  const schemaVersion = typeof schemaVersionValue === "number" ? schemaVersionValue : NaN;
  if (typeof schemaId !== "string" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) typeError("SchemaBoundBytes");
  const schemas = context.schemas ?? coreSchemaDefinitions;
  const schema = Array.isArray(schemas)
    ? schemas.find((candidate) => candidate.schema_id === schemaId && candidate.schema_version === schemaVersion)
    : (schemas as ReadonlyMap<string, CanonicalSchemaDefinition>).get(`${schemaId}@${schemaVersion}`);
  if (!schema) fail("uce:unknown_schema", "schema_validation", { schema_id: schemaId, schema_version: schemaVersion });
  const decoded = decodeCanonical(bytes);
  try {
    validateSchemaValue(schema, decoded, { ...context, schemas });
  } catch (error) {
    fail("uce:schema_validation_failed", "schema_validation", { schema_id: schemaId, schema_version: schemaVersion, value_path: "", validation_kind: "PAYLOAD_SCHEMA_MISMATCH" }, error instanceof Error ? error.message : "SchemaBoundBytes does not conform to its bound schema");
  }
}

function decodeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(decodeJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeJsonValue(entry)]));
  typeError("JsonValue");
}

function assertFloatEncoding(bytes: Uint8Array): void {
  const initial = bytes[0];
  const additional = initial === undefined ? -1 : initial & 0x1f;
  if (initial === undefined || initial >> 5 !== 7 || (additional !== 25 && additional !== 26 && additional !== 27)) {
    fail("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "TYPE_MISMATCH", expected_type: "Float64" }, "Float64 requires a canonical CBOR floating-point item");
  }
}
