export type LogicalValue =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "real"; readonly value: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "bytes"; readonly value: readonly number[] }
  | { readonly type: "sequence"; readonly values: readonly LogicalValue[] }
  | { readonly type: "set"; readonly values: readonly LogicalValue[] }
  | {
    readonly type: "record";
    /** Schema-owned fields already ordered by the owning comparator. */
    readonly fields: readonly LogicalField[];
  };

export interface LogicalField {
  readonly identifier: string;
  readonly present: boolean;
  readonly value?: LogicalValue;
}

export interface LogicalRecord {
  readonly domain: string;
  /** Fields are supplied in their schema-owned order. */
  readonly fields: readonly LogicalField[];
}

export interface LogicalDigestResult {
  readonly digest: string;
  readonly byte_length: number;
}

export interface LogicalRecordVerification extends LogicalRecord {
  readonly expected_digest: string;
}

export interface LogicalValueRecord {
  readonly domain: string;
  readonly value: LogicalValue;
}

export interface LogicalValueVerification extends LogicalValueRecord {
  readonly expected_digest: string;
}

export interface LogicalVerificationResult {
  readonly valid: boolean;
  readonly actual_digest: string;
  readonly byte_length: number;
}

export interface StructuralKernelBatch {
  readonly records: readonly object[];
  readonly dependencies: readonly object[];
}

export interface StructuralObservationProjectionRequest {
  readonly profile_id: string;
  readonly batch: Readonly<Record<string, unknown>>;
}

export interface StructuralObservationProjectionResult {
  readonly owners: readonly {
    readonly canonical_records: readonly string[];
    readonly canonical_dependencies: readonly string[];
    readonly record_headers: readonly object[];
    readonly dependency_headers: readonly object[];
    readonly diagnostic_codes: readonly string[];
  }[];
}

export interface StructuralKernelCanonicalBatch {
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
  readonly record_definitions: readonly StructuralRecordDefinition[];
}

export interface StructuralPayloadProperty {
  readonly type: "string" | "integer" | "boolean" | "array" | "object";
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly items?: StructuralPayloadProperty;
  readonly properties?: Readonly<Record<string, StructuralPayloadProperty>>;
  readonly required?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface StructuralRecordDefinition {
  readonly kind: string;
  readonly category: string;
  readonly universal_kind: string;
  readonly schema_version: number;
  readonly allowed_facets: readonly string[];
  readonly required_facets: readonly string[];
  readonly body_schema?: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: Readonly<Record<string, StructuralPayloadProperty>>;
    readonly required: readonly string[];
  };
}

export interface StructuralAcceptedRecord {
  readonly proposal_record_key: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly schema_version: number;
  readonly identity_key: string;
}

export type StructuralJsonValue = string | number | boolean | null | readonly StructuralJsonValue[] | { readonly [key: string]: StructuralJsonValue };

export interface StructuralAcceptedDependency {
  readonly proposed_dependency_id: string;
  readonly proposal_record_key: string;
  readonly dependency_artifact_id: string;
  readonly dependency_artifact_version_id: string;
  readonly dependency_role: string;
  readonly dependency_basis: string;
  readonly source_reference: StructuralJsonValue;
}

export interface StructuralKernelCanonicalResult {
  readonly kernel: StructuralKernelResult;
  readonly records: readonly StructuralAcceptedRecord[];
  readonly dependencies: readonly StructuralAcceptedDependency[];
  readonly record_schema_attestations: readonly boolean[];
}

export interface StructuralKernelResult {
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
  readonly record_facets: readonly (readonly string[] | null)[];
  readonly record_structural_attestations: readonly boolean[];
  readonly record_digests: readonly string[];
  readonly record_ids: readonly string[];
  readonly publication_records: readonly StructuralPublicationRecord[];
  readonly record_body_payload_hexes: readonly string[];
  readonly publication_descriptor: StructuralPublicationDescriptor;
  readonly records_digest: string;
  readonly dependencies_digest: string;
  readonly canonical_byte_length: number;
}

export interface StructuralPublicationRecord {
  readonly [key: string]: unknown;
  readonly record_id: string;
  readonly record_digest: string;
  readonly body_digest: string;
  readonly body_byte_length: number;
  readonly schema_version: number;
  readonly facets: readonly string[];
  readonly primary_source_span: Readonly<Record<string, unknown>> | null;
  readonly identity_type: "entity" | "relation" | "diagnostic";
  readonly identity_key: string;
  readonly identity_id: string;
  readonly identity_key_digest: string;
  readonly identity_assignment_id: string;
}

export interface StructuralPublicationDescriptor {
  readonly record_count: number;
  readonly body_byte_length: number;
  readonly first_record_id: string | null;
  readonly last_record_id: string | null;
  readonly sequence_digest: string;
}

export type DistanceMetric = "cosine" | "squared_l2";

export interface ExactVectorRequest {
  readonly query: Uint8Array;
  /** Row-major packed vectors, one row per projectionRecordIds entry. */
  readonly candidates: Uint8Array;
  readonly projectionRecordIds: readonly string[];
  readonly dimensions: number;
  readonly elementType: "float32_le" | "float64_le";
  readonly k: number;
  readonly metric: DistanceMetric;
}

export interface VectorTopKMatch {
  readonly projection_record_id: string;
  readonly rank: number;
}

export interface NativeBinding {
  nativeApiVersion(): number;
  nativeTargetTriple(): string;
  logicalDigestBatch(records: readonly LogicalRecord[]): readonly LogicalDigestResult[];
  verifyLogicalRecordBatch(records: readonly LogicalRecordVerification[]): readonly LogicalVerificationResult[];
  logicalValueDigestBatch(records: readonly LogicalValueRecord[]): readonly LogicalDigestResult[];
  verifyLogicalValueBatch(records: readonly LogicalValueVerification[]): readonly LogicalVerificationResult[];
  structuralKernelBatch(batch: StructuralKernelBatch): StructuralKernelResult;
  structuralKernelCanonicalBatch(batch: StructuralKernelCanonicalBatch): StructuralKernelCanonicalResult;
  structuralObservationBatch(request: StructuralObservationProjectionRequest): StructuralObservationProjectionResult;
  exactVectorTopKBatch(requests: readonly ExactVectorRequest[]): readonly (readonly VectorTopKMatch[])[];
}
