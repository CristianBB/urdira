import { getNativeBinding } from "./loader.js";
import type {
  ExactVectorRequest,
  LogicalDigestResult,
  LogicalRecord,
  LogicalRecordVerification,
  LogicalValue,
  LogicalValueRecord,
  LogicalValueVerification,
  LogicalVerificationResult,
  StructuralKernelBatch,
  StructuralKernelCanonicalBatch,
  StructuralKernelCanonicalResult,
  StructuralKernelResult,
  StructuralObservationProjectionRequest,
  StructuralObservationProjectionResult,
  VectorTopKMatch,
} from "./types.js";

export {
  getNativeBinding,
  loadNativeBinding,
  resolveNativeWorkerPath,
  resolveNativeClosure,
  NativeBindingError,
  NATIVE_API_VERSION,
  NODE_API_VERSION,
  NATIVE_PACKAGE_MANIFEST_VERSION,
  NATIVE_WORKER_PROTOCOL,
} from "./loader.js";
export type { ResolvedNativeClosure } from "./loader.js";
export { resolveNativeTarget, SUPPORTED_NATIVE_TARGETS } from "./targets.js";
export type { NativeLibc, NativeTarget } from "./targets.js";
export type {
  DistanceMetric,
  ExactVectorRequest,
  LogicalDigestResult,
  LogicalField,
  LogicalRecord,
  LogicalRecordVerification,
  LogicalValueRecord,
  LogicalValueVerification,
  LogicalValue,
  LogicalVerificationResult,
  StructuralKernelBatch,
  StructuralKernelCanonicalBatch,
  StructuralKernelCanonicalResult,
  StructuralKernelResult,
  StructuralObservationProjectionRequest,
  StructuralObservationProjectionResult,
  VectorTopKMatch,
} from "./types.js";

export interface LogicalValueDigestInput {
  readonly domain: string;
  readonly value: unknown;
}

export interface LogicalValueVerificationInput extends LogicalValueDigestInput {
  readonly expected_digest: string;
}

const MAX_LOGICAL_VALUE_DEPTH = 64;

function encodeLogicalValue(value: unknown, depth = 0, ancestors = new Set<object>()): LogicalValue {
  if (depth > MAX_LOGICAL_VALUE_DEPTH) throw new TypeError("Unsupported logical digest value: maximum depth exceeded.");
  if (value === null) return { type: "null" };
  if (value instanceof Uint8Array) return { type: "bytes", value: [...value] };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "bigint") return { type: "integer", value: value.toString(10) };
  if (typeof value === "number") return Number.isSafeInteger(value)
    ? { type: "integer", value: String(value) }
    : { type: "real", value };
  if (typeof value === "string") return { type: "text", value };
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Unsupported logical digest value: cyclic array.");
    ancestors.add(value);
    try {
      return { type: "sequence", values: value.map((entry) => encodeLogicalValue(entry, depth + 1, ancestors)) };
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("Unsupported logical digest value: cyclic object.");
    ancestors.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
      return {
        type: "record",
        fields: entries.map(([identifier, entry]) => entry === undefined
          ? { identifier, present: false }
          : { identifier, present: true, value: encodeLogicalValue(entry, depth + 1, ancestors) }),
      };
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError(`Unsupported logical digest value: ${typeof value}.`);
}

/** Adapts call-owned JavaScript values to the closed native logical-value
 * shape. The adapter creates a fresh bounded graph for each call and retains
 * neither source values nor encoded values after N-API returns. */
export function createNativeLogicalDigestPort(binding = getNativeBinding()): {
  logicalValueDigestBatch(records: readonly LogicalValueDigestInput[]): readonly LogicalDigestResult[];
  verifyLogicalValueBatch(records: readonly LogicalValueVerificationInput[]): readonly LogicalVerificationResult[];
} {
  return {
    logicalValueDigestBatch(records) {
      const encoded: readonly LogicalValueRecord[] = records.map((record) => ({ domain: record.domain, value: encodeLogicalValue(record.value) }));
      return binding.logicalValueDigestBatch(encoded);
    },
    verifyLogicalValueBatch(records) {
      const encoded: readonly LogicalValueVerification[] = records.map((record) => ({ domain: record.domain, value: encodeLogicalValue(record.value), expected_digest: record.expected_digest }));
      return binding.verifyLogicalValueBatch(encoded);
    },
  };
}

export function logicalDigestBatch(records: readonly LogicalRecord[]): readonly LogicalDigestResult[] {
  return getNativeBinding().logicalDigestBatch(records);
}

export function verifyLogicalRecordBatch(
  records: readonly LogicalRecordVerification[],
): readonly LogicalVerificationResult[] {
  return getNativeBinding().verifyLogicalRecordBatch(records);
}

export function logicalValueDigestBatch(records: readonly LogicalValueDigestInput[]): readonly LogicalDigestResult[] {
  return createNativeLogicalDigestPort().logicalValueDigestBatch(records);
}

export function verifyLogicalValueBatch(records: readonly LogicalValueVerificationInput[]): readonly LogicalVerificationResult[] {
  return createNativeLogicalDigestPort().verifyLogicalValueBatch(records);
}

export function structuralKernelBatch(batch: StructuralKernelBatch): StructuralKernelResult {
  return getNativeBinding().structuralKernelBatch(batch);
}

export function structuralKernelCanonicalBatch(batch: StructuralKernelCanonicalBatch): StructuralKernelCanonicalResult {
  return getNativeBinding().structuralKernelCanonicalBatch(batch);
}

export function structuralObservationBatch(request: StructuralObservationProjectionRequest): StructuralObservationProjectionResult {
  return getNativeBinding().structuralObservationBatch(request);
}

export function createNativeStructuralKernelPort(binding = getNativeBinding()): {
  structuralKernelBatch(batch: StructuralKernelBatch): StructuralKernelResult;
  structuralKernelCanonicalBatch(batch: StructuralKernelCanonicalBatch): StructuralKernelCanonicalResult;
  structuralObservationBatch(request: StructuralObservationProjectionRequest): StructuralObservationProjectionResult;
} {
  return {
    structuralKernelBatch: (batch) => binding.structuralKernelBatch(batch),
    structuralKernelCanonicalBatch: (batch) => binding.structuralKernelCanonicalBatch(batch),
    structuralObservationBatch: (request) => binding.structuralObservationBatch(request),
  };
}

export function exactVectorTopKBatch(
  requests: readonly ExactVectorRequest[],
): readonly (readonly VectorTopKMatch[])[] {
  return getNativeBinding().exactVectorTopKBatch(requests);
}

export function createNativeExactVectorTopKPort(binding = getNativeBinding()): {
  exactVectorTopKBatch(requests: readonly ExactVectorRequest[]): readonly (readonly VectorTopKMatch[])[];
} {
  return {
    exactVectorTopKBatch(requests) {
      return binding.exactVectorTopKBatch(requests);
    },
  };
}
