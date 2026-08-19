export { CanonicalEncodingError, type CanonicalEncodingErrorDetails, type CanonicalEncodingPhase } from "./errors.js";
export {
  canonicalBytes,
  compareBytes,
  decodeCanonical,
  encodeArrayHeader,
  encodeCanonical,
  encodeFloat64,
  type CanonicalEncodingLimits,
} from "./cbor.js";
export {
  canonicalSetValues,
  compareCanonicalValues,
  readCanonicalPointer,
  sortCanonicalValues,
  type CanonicalComparator,
} from "./comparators.js";
export {
  canonicalComparatorRegistry,
  canonicalComparatorDefinitions,
  canonicalEncodingErrorCodeRegistry,
  canonicalEncodingErrorDetailContracts,
  canonicalSchemaRegistry,
  canonicalSchemaDefinitions,
  digestDomainRegistry,
  hashAlgorithmRegistry,
  allDigestFieldContracts,
  expandedAllDigestFieldContracts,
  digestFieldContracts,
  expandedDigestFieldContracts,
  digestReferenceContracts,
  digestReferenceDefinitions,
  externalVerificationContractDefinitions,
  digestRecipeDefinitions,
  digestRecipeVariantDefinitions,
  digestRecipeRegistry,
  digestPayloadSchemaDefinitions,
  digestContractRowRegistry,
  documentedDigestContractRows,
  documentedDigestFieldContracts,
  documentedDigestRecipeCoordinates,
  phase3DigestFieldContractRows,
  terminalDigestRecipeDefinitions,
  canonicalEncodingConformanceCases,
  canonicalTypedConformanceCases,
  type DigestFieldContract,
} from "./registries.js";
export {
  encodeCanonical as encodeCanonicalValue,
} from "./cbor.js";
export {
  decodeTypedValue,
  encodeSchemaValueTyped,
  encodeTypedValue,
} from "./typed.js";
export {
  normalizeBigInteger,
  normalizeBytes,
  normalizeDigest,
  normalizeExactDecimal,
  normalizeText,
  normalizeTimestamp,
  timestampNanoseconds,
  timestampFromNanoseconds,
  toBase64Url,
  toBigIntegerText,
} from "./scalars.js";
export {
  computeDigest,
  computeDigestOverArrayPayload,
  computeDigestOverMapPayloadWithArrayField,
  computeDigestRecipe,
  decodeDigest,
  digestBytes,
  digestCanonical,
  digestCanonicalArray,
  digestEnvelope,
  digestPayloadBytes,
  digestToBytes,
  encodeDigest,
  schemaCoordinateExists,
  validateDigestEnvelope,
  validateDigestRecipeGraph,
  verifyDigest,
  type DigestOptions,
  type DigestEnvelopeValidationContext,
  type DigestRecipe,
  type DigestRecipeGraphResult,
  type DigestText,
} from "./digests.js";

import {
  coreSchemaDefinitions,
  validateSchemaValue,
  type CanonicalSchemaDefinition,
  type SchemaValidationContext,
} from "@urdira/contracts";
import { canonicalComparatorRegistry } from "./registries.js";
import { encodeSchemaValueTyped } from "./typed.js";
import { CanonicalEncodingError } from "./errors.js";

export { coreSchemaDefinitions as canonicalSchemaIRDefinitions } from "@urdira/contracts";

export function encodeSchemaValue(value: unknown, schema: CanonicalSchemaDefinition, context: SchemaValidationContext = {}): Uint8Array {
  const validationContext: SchemaValidationContext = {
    schemas: context.schemas ?? coreSchemaDefinitions,
    comparators: context.comparators ?? canonicalComparatorRegistry,
  };
  if (context.localDefinitions) validationContext.localDefinitions = context.localDefinitions;
  try {
    validateSchemaValue(schema, value, validationContext);
  } catch (error) {
    if (error instanceof CanonicalEncodingError) throw error;
    throw new CanonicalEncodingError("uce:schema_validation_failed", "schema_validation", { value_path: "", validation_kind: "CONSTRAINT_FAILED" }, error instanceof Error ? error.message : "Schema validation failed");
  }
  return encodeSchemaValueTyped(value, schema, validationContext);
}

export function canonicalize<T>(value: T): T {
  if (Object.is(value, -0)) return 0 as T;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item)) as T;
  if (value instanceof Uint8Array || value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalize(item)])) as T;
}
