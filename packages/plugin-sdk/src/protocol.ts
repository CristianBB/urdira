import { createHash, type Hash } from "node:crypto";
import {
  buildFactDeltaBatch,
  FACT_DELTA_BATCH_MAX_BYTES,
  FACT_DELTA_BATCH_MAX_ROWS,
  validateFactDeltaStreamBatchValue,
  validateFactDeltaStreamHeaderValue,
  validatePluginRuntimeExecutableBindingValue,
  validateRuntimeComponentImplementationManifestV2,
  type FactDelta,
  type FactDeltaBatch,
  type FactDeltaStreamBatch,
  type FactDeltaStreamHeader,
  type ClosedPayloadSchema,
  type PluginRuntimeExecutableBinding,
  type ProposedRecord,
  type ProposedRecordDependency,
  type RuntimeComponentImplementationManifestV2,
} from "@urdira/contracts";
import { canonicalJson, canonicalSha256, deepFreeze, hasExactKeys } from "./canonical.js";
import type { PluginDigestAuthority } from "./digest-authority.js";
import { PluginSdkError, sdkError } from "./errors.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";

/**
 * `analyze_closure` (Phase 5.1): a plugin-specific whole-project-analysis
 * query that returns per-file dependency closures (which of the corpus's own
 * scanned files a given file transitively imports) without producing a
 * `FactDelta`. It runs/reuses the same cached whole-project analysis
 * `analyze_artifact` does (see `packages/plugin-javascript-typescript/src/worker.ts`),
 * so a caller can fetch closures once per scan and then narrow each owner's
 * `analyze_artifact` request (both its access manifest and its `files`
 * payload) to just that owner's closure.
 */
export type PluginWorkerCall = "describe" | "discover_partitions" | "analyze_artifact" | "analyze_closure" | "generate_projection";
export type PluginWorkerOutcome = "success" | "inputs_incomplete" | "unsupported" | "cancelled" | "resource_exhausted" | "failed";
export type WorkerRetryMode = "new" | "retry_same";

export const FACT_DELTA_STREAM_PROTOCOL_VERSION = 2 as const;
export const FACT_DELTA_STREAM_SCHEMA_ID = "core:FactDeltaStream" as const;
export const FACT_DELTA_STREAM_BATCH_SCHEMA_ID = "core:FactDeltaStreamBatch" as const;
export const FACT_DELTA_STREAM_MAX_BYTES = FACT_DELTA_BATCH_MAX_BYTES;
export const FACT_DELTA_STREAM_MAX_ROWS = FACT_DELTA_BATCH_MAX_ROWS;

export interface FactDeltaStream {
  readonly header: FactDeltaStreamHeader;
  readonly batches: AsyncIterable<FactDeltaStreamBatch>;
}

export interface FactDeltaV1StreamAdapterOptions {
  readonly cancellation_id: string;
  readonly max_in_flight_batches?: 1;
  /** Adapter-only test/tuning ceiling; never widens the contract maximum. */
  readonly max_rows?: number;
}

export interface FactDeltaStreamValidationSummary {
  readonly batch_count: number;
  readonly record_count: number;
  readonly dependency_count: number;
  readonly byte_length: number;
}

export interface WorkerKey {
  readonly package_digest: string;
  readonly runtime_contract_version: number;
  readonly executable_build_digest: string;
}

export interface PluginWorkerRequestEnvelope {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
  readonly deadline: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}

export interface PluginWorkerResponseEnvelope {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
  readonly outcome: PluginWorkerOutcome;
  readonly payload: unknown;
}

// Compatibility aliases name the same authoritative wire models; they do not
// preserve the former non-authoritative fields.
export type PluginWorkerCallEnvelope = PluginWorkerRequestEnvelope;
export type PluginWorkerOutcomeEnvelope = PluginWorkerResponseEnvelope;

export interface WorkerPayloadValidator {
  validate_call(call: PluginWorkerCall, payload: unknown): unknown;
  validate_outcome(call: PluginWorkerCall, outcome: PluginWorkerOutcome, payload: unknown): unknown;
}

const CALLS = new Set<PluginWorkerCall>(["describe", "discover_partitions", "analyze_artifact", "analyze_closure", "generate_projection"]);
const OUTCOMES = new Set<PluginWorkerOutcome>(["success", "inputs_incomplete", "unsupported", "cancelled", "resource_exhausted", "failed"]);

function invalid(message: string): never {
  throw sdkError("plugin-sdk:worker_protocol_invalid", message);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\r\n\t\0]/u.test(value);
}

function isCanonicalDeadline(value: unknown): value is string {
  if (!isNonemptyString(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

const PROPOSED_RECORD_KEYS = ["proposal_record_key", "category", "kind", "universal_kind", "facets", "schema_version", "source_span", "identity_key", "body", "evidence_references"] as const;
const PROPOSED_DEPENDENCY_KEYS = ["proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_role", "dependency_basis", "source_reference"] as const;
const CANONICAL_STREAM_ROWS = new WeakMap<object, string>();
const STRUCTURAL_RECORD_DIGESTS = new WeakMap<object, string>();
const STRUCTURAL_PUBLICATION_ROWS = new WeakMap<object, Readonly<Record<string, unknown>>>();
const STRUCTURAL_BODY_PAYLOAD_HEXES = new WeakMap<object, string>();
const STRUCTURALLY_ATTESTED_RECORDS = new WeakMap<object, readonly string[]>();
const STRUCTURALLY_PREPARED_ROWS = new WeakSet<object>();
const VALIDATED_STREAM_HEADERS = new WeakSet<object>();
const VALIDATED_STREAM_BATCHES = new WeakSet<object>();

export interface SealedFactDeltaStreamRows {
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
}

export interface StructuralKernelRecordDefinition {
  readonly kind: string;
  readonly category: string;
  readonly universal_kind: string;
  readonly schema_version: number;
  readonly allowed_facets: readonly string[];
  readonly required_facets: readonly string[];
  readonly body_schema?: ClosedPayloadSchema;
}

export interface StructuralKernelAcceptedRecord {
  readonly proposal_record_key: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly schema_version: number;
  readonly identity_key: string;
}

export interface StructuralKernelCanonicalAcceptance {
  readonly kernel: ReturnType<StructuralKernelPort["structuralKernelBatch"]>;
  readonly records: readonly StructuralKernelAcceptedRecord[];
  readonly dependencies: readonly ProposedRecordDependency[];
  readonly record_schema_attestations: readonly boolean[];
}

const SEALED_STREAM_ROWS = new WeakMap<object, SealedFactDeltaStreamRows>();
const SEALED_STRUCTURAL_ACCEPTANCE = new WeakMap<object, StructuralKernelCanonicalAcceptance>();

export interface StructuralKernelPort {
  structuralKernelBatch(batch: {
    readonly records: readonly ProposedRecord[];
    readonly dependencies: readonly ProposedRecordDependency[];
  }): {
    readonly canonical_records: readonly string[];
    readonly canonical_dependencies: readonly string[];
    readonly record_facets: readonly (readonly string[] | null)[];
    readonly record_structural_attestations: readonly boolean[];
    readonly record_digests: readonly string[];
    readonly record_ids: readonly string[];
    readonly publication_records: readonly Readonly<Record<string, unknown>>[];
    readonly record_body_payload_hexes: readonly string[];
    readonly publication_descriptor: {
      readonly record_count: number;
      readonly body_byte_length: number;
      readonly first_record_id: string | null;
      readonly last_record_id: string | null;
      readonly sequence_digest: string;
    };
    readonly records_digest: string;
    readonly dependencies_digest: string;
    readonly canonical_byte_length: number;
  };
  structuralKernelCanonicalBatch?(batch: {
    readonly canonical_records: readonly string[];
    readonly canonical_dependencies: readonly string[];
    readonly record_definitions: readonly StructuralKernelRecordDefinition[];
  }): StructuralKernelCanonicalAcceptance;
  structuralObservationBatch?(request: {
    readonly profile_id: string;
    readonly batch: Readonly<Record<string, unknown>>;
  }): {
    readonly owners: readonly {
      readonly canonical_records: readonly string[];
      readonly canonical_dependencies: readonly string[];
      readonly record_headers: readonly object[];
      readonly dependency_headers: readonly object[];
      readonly diagnostic_codes: readonly string[];
    }[];
  };
}

let activeStructuralKernelPort: StructuralKernelPort | undefined;

/** Configures the core-owned native accelerator at the composition root. */
export function configureStructuralKernelPort(port: StructuralKernelPort | undefined): void {
  activeStructuralKernelPort = port;
}

/** Canonical bytes-as-text cached only for immutable stream row objects. */
export function factDeltaStreamCanonicalRow(value: ProposedRecord | ProposedRecordDependency): string {
  const cached = CANONICAL_STREAM_ROWS.get(value as object);
  if (cached !== undefined) return cached;
  const canonical = canonicalJson(value);
  CANONICAL_STREAM_ROWS.set(value as object, canonical);
  return canonical;
}

/** Native proof that the body is canonicalizable and the nested UCE strings
 * are canonical. Registry-dependent validation remains engine-owned. */
export function factDeltaStreamAttestedFacets(value: ProposedRecord): readonly string[] | undefined {
  return STRUCTURALLY_ATTESTED_RECORDS.get(value as object);
}

/** Record digest computed over the exact cached canonical row by the trusted
 * native kernel. Undefined on the portable fallback path. */
export function factDeltaStreamRecordDigest(value: ProposedRecord): string | undefined {
  return STRUCTURAL_RECORD_DIGESTS.get(value as object);
}

/** Prevalidated typed publication scalar row emitted by the trusted kernel. */
export function factDeltaStreamPublicationRow(value: ProposedRecord): Readonly<Record<string, unknown>> | undefined {
  return STRUCTURAL_PUBLICATION_ROWS.get(value as object);
}

/** Hex UCE body payload paired with the typed publication scalar row. */
export function factDeltaStreamBodyPayloadHex(value: ProposedRecord): string | undefined {
  return STRUCTURAL_BODY_PAYLOAD_HEXES.get(value as object);
}

function streamInvalid(message: string): never {
  throw sdkError("plugin-sdk:worker_protocol_invalid", message);
}

function validateProposedRecordRow(value: unknown, validateCanonicalValue = true): ProposedRecord {
  if (!hasExactKeys(value, PROPOSED_RECORD_KEYS)
    || !PROPOSED_RECORD_KEYS.filter((key) => key !== "schema_version" && key !== "body").every((key) => typeof value[key] === "string")
    || !Number.isSafeInteger(value["schema_version"]) || Number(value["schema_version"]) < 1) streamInvalid("FactDeltaStream record row is invalid.");
  if (validateCanonicalValue) try { canonicalSha256(value["body"]); } catch { streamInvalid("FactDeltaStream record body is not canonicalizable."); }
  return value as unknown as ProposedRecord;
}

function validateProposedDependencyRow(value: unknown, validateCanonicalValue = true): ProposedRecordDependency {
  if (!hasExactKeys(value, PROPOSED_DEPENDENCY_KEYS)
    || !PROPOSED_DEPENDENCY_KEYS.filter((key) => key !== "source_reference").every((key) => typeof value[key] === "string")) streamInvalid("FactDeltaStream dependency row is invalid.");
  if (validateCanonicalValue) try { canonicalSha256(value["source_reference"]); } catch { streamInvalid("FactDeltaStream dependency source reference is not canonicalizable."); }
  return value as unknown as ProposedRecordDependency;
}

function canonicalArrayDigest(values: Iterable<unknown>): string {
  const hash = createHash("sha256");
  hash.update("[", "utf8");
  let first = true;
  for (const value of values) {
    if (!first) hash.update(",", "utf8");
    first = false;
    hash.update(canonicalJson(value), "utf8");
  }
  hash.update("]", "utf8");
  return `sha256:${hash.digest("hex")}`;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STRUCTURAL_KERNEL_RESULT_KEYS = ["canonical_records", "canonical_dependencies", "record_facets", "record_structural_attestations", "record_digests", "record_ids", "publication_records", "record_body_payload_hexes", "publication_descriptor", "records_digest", "dependencies_digest", "canonical_byte_length"] as const;

function containsBinary(value: unknown, ancestors = new Set<object>()): boolean {
  if (value instanceof Uint8Array) return true;
  if (value === null || typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    return Object.values(value).some((entry) => containsBinary(entry, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

// Rust's publication digest fast lane uses byte-ordered object fields. The
// existing logical-digest.v3 writer historically uses localeCompare. They
// are identical for the schema-owned lowercase ASCII keys emitted by the
// production analyzers; any other key stays on the portable exact path.
function nativePublicationBodyIsExact(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  if (ancestors.has(value as object)) return false;
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) return value.every((entry) => nativePublicationBodyIsExact(entry, ancestors));
    return Object.entries(value as Record<string, unknown>).every(([key, entry]) => /^[a-z0-9_]+$/u.test(key) && nativePublicationBodyIsExact(entry, ancestors));
  } finally { ancestors.delete(value as object); }
}

type StructuralKernelSummary = {
  readonly records_digest: string;
  readonly dependencies_digest: string;
};

const STRUCTURAL_KERNEL_BATCH_SUMMARIES = new WeakMap<object, StructuralKernelSummary>();

function prepareStructuralKernelRows(records: readonly ProposedRecord[], dependencies: readonly ProposedRecordDependency[]): ReturnType<StructuralKernelPort["structuralKernelBatch"]> | undefined {
  const port = activeStructuralKernelPort;
  if (port === undefined || records.some((record) => containsBinary(record.body)) || dependencies.some((dependency) => containsBinary(dependency.source_reference))) return undefined;
  // The stream producer first probes physical bounds and only afterwards
  // seals the same immutable owner rows with their final sequence/final bit.
  // A successful native pass is row-intrinsic, so the second framing step
  // must not cross N-API and deserialize the full logical batch again.
  if (records.every((record) => STRUCTURALLY_PREPARED_ROWS.has(record as object))
    && dependencies.every((dependency) => STRUCTURALLY_PREPARED_ROWS.has(dependency as object))) return undefined;
  let result: ReturnType<StructuralKernelPort["structuralKernelBatch"]>;
  try {
    result = port.structuralKernelBatch({ records, dependencies });
  } catch {
    return streamInvalid("FactDeltaStream structural kernel rejected the bounded batch.");
  }
  return acceptStructuralKernelResult(records, dependencies, result);
}

function acceptStructuralKernelResult(
  records: readonly ProposedRecord[],
  dependencies: readonly ProposedRecordDependency[],
  result: ReturnType<StructuralKernelPort["structuralKernelBatch"]>,
): ReturnType<StructuralKernelPort["structuralKernelBatch"]> {
  if (!hasExactKeys(result, STRUCTURAL_KERNEL_RESULT_KEYS)
    || !Array.isArray(result.canonical_records) || result.canonical_records.length !== records.length || result.canonical_records.some((value) => typeof value !== "string")
    || !Array.isArray(result.canonical_dependencies) || result.canonical_dependencies.length !== dependencies.length || result.canonical_dependencies.some((value) => typeof value !== "string")
    || !Array.isArray(result.record_facets) || result.record_facets.length !== records.length || result.record_facets.some((value) => value !== null && (!Array.isArray(value) || value.some((facet) => typeof facet !== "string")))
    || !Array.isArray(result.record_structural_attestations) || result.record_structural_attestations.length !== records.length || result.record_structural_attestations.some((value) => typeof value !== "boolean")
    || !Array.isArray(result.record_digests) || result.record_digests.length !== records.length || result.record_digests.some((value) => typeof value !== "string" || !SHA256_PATTERN.test(value))
    || !Array.isArray(result.record_ids) || result.record_ids.length !== records.length || result.record_ids.some((value) => typeof value !== "string")
    || !Array.isArray(result.publication_records) || result.publication_records.length !== records.length || result.publication_records.some((value) => value === null || typeof value !== "object" || Array.isArray(value))
    || !Array.isArray(result.record_body_payload_hexes) || result.record_body_payload_hexes.length !== records.length || result.record_body_payload_hexes.some((value) => typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value))
    || result.publication_descriptor === null || typeof result.publication_descriptor !== "object" || Array.isArray(result.publication_descriptor)
    || typeof result.records_digest !== "string" || !SHA256_PATTERN.test(result.records_digest)
    || typeof result.dependencies_digest !== "string" || !SHA256_PATTERN.test(result.dependencies_digest)
    || !Number.isSafeInteger(result.canonical_byte_length) || result.canonical_byte_length < 0) {
    return streamInvalid("FactDeltaStream structural kernel returned an invalid result.");
  }
  for (let index = 0; index < records.length; index += 1) {
    const digest = result.record_digests[index]!;
    if (result.record_ids[index] !== `record:${digest.slice("sha256:".length)}`) return streamInvalid("FactDeltaStream structural kernel record identity is inconsistent.");
    const publication = result.publication_records[index]!;
    if (publication["record_id"] !== result.record_ids[index] || publication["record_digest"] !== digest
      || typeof publication["body_digest"] !== "string" || !SHA256_PATTERN.test(publication["body_digest"])
      || !Number.isSafeInteger(publication["body_byte_length"]) || Number(publication["body_byte_length"]) < 0
      || !Number.isSafeInteger(publication["schema_version"]) || Number(publication["schema_version"]) < 1
      || !Array.isArray(publication["facets"]) || publication["facets"].some((facet) => typeof facet !== "string")
      || typeof publication["identity_type"] !== "string" || !["entity", "relation", "diagnostic"].includes(publication["identity_type"])
      || typeof publication["identity_key"] !== "string" || typeof publication["identity_id"] !== "string"
      || typeof publication["identity_key_digest"] !== "string" || !SHA256_PATTERN.test(publication["identity_key_digest"])
      || typeof publication["identity_assignment_id"] !== "string" || !SHA256_PATTERN.test(publication["identity_assignment_id"])) return streamInvalid("FactDeltaStream structural kernel publication row is inconsistent.");
  }
  if (result.publication_descriptor.record_count !== records.length
    || !Number.isSafeInteger(result.publication_descriptor.body_byte_length) || result.publication_descriptor.body_byte_length < 0
    || typeof result.publication_descriptor.sequence_digest !== "string" || !SHA256_PATTERN.test(result.publication_descriptor.sequence_digest)
    || result.publication_descriptor.first_record_id !== (records.length === 0 ? null : result.record_ids[0])
    || result.publication_descriptor.last_record_id !== (records.length === 0 ? null : result.record_ids.at(-1))) return streamInvalid("FactDeltaStream structural kernel publication descriptor is inconsistent.");
  // The private binding is a core-owned trusted accelerator selected by the
  // composition root after its version handshake. Re-hashing every returned
  // canonical row twice in JavaScript merely repeated the Rust kernel's hot
  // loop. The ordinary chunk digest below still authenticates the exact
  // canonical row text against the producer, while the stream aggregate
  // compares these kernel digests with the sealed header.
  records.forEach((record, index) => CANONICAL_STREAM_ROWS.set(record as object, result.canonical_records[index]!));
  records.forEach((record, index) => STRUCTURAL_RECORD_DIGESTS.set(record as object, result.record_digests[index]!));
  records.forEach((record, index) => {
    if (!nativePublicationBodyIsExact(record.body)) return;
    STRUCTURAL_PUBLICATION_ROWS.set(record as object, Object.freeze({ ...result.publication_records[index]! }));
    STRUCTURAL_BODY_PAYLOAD_HEXES.set(record as object, result.record_body_payload_hexes[index]!);
  });
  records.forEach((record, index) => {
    if (result.record_structural_attestations[index] === true && result.record_facets[index] !== null) STRUCTURALLY_ATTESTED_RECORDS.set(record as object, Object.freeze([...result.record_facets[index]!]));
  });
  dependencies.forEach((dependency, index) => CANONICAL_STREAM_ROWS.set(dependency as object, result.canonical_dependencies[index]!));
  records.forEach((record) => STRUCTURALLY_PREPARED_ROWS.add(record as object));
  dependencies.forEach((dependency) => STRUCTURALLY_PREPARED_ROWS.add(dependency as object));
  return result;
}

/** Projects language-specific compact observations through a registered
 * native profile and attaches the same core-owned canonical/typed result used
 * by ordinary structural groups. Unknown profiles and malformed results fail
 * closed; callers may use the portable mapper only when no native projector
 * was configured at all. */
export interface SealedStructuralProjectionOwner {
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
  readonly record_headers: readonly {
    readonly proposal_record_key: string;
    readonly category: string;
    readonly kind: string;
    readonly universal_kind: string;
    readonly identity_key: string;
  }[];
  readonly dependency_headers: readonly {
    readonly proposed_dependency_id: string;
    readonly proposal_record_key: string;
    readonly dependency_artifact_id: string;
    readonly dependency_artifact_version_id: string;
    readonly dependency_role: string;
  }[];
  readonly diagnostic_codes: readonly string[];
}

export function projectStructuralObservationGroup(
  profileId: string,
  batch: Readonly<Record<string, unknown>>,
): readonly SealedStructuralProjectionOwner[] | undefined {
  const operation = activeStructuralKernelPort?.structuralObservationBatch;
  if (operation === undefined) return undefined;
  let projected: ReturnType<NonNullable<StructuralKernelPort["structuralObservationBatch"]>>;
  try {
    projected = operation({ profile_id: profileId, batch });
  } catch {
    return streamInvalid("FactDeltaStream native observation projector rejected the bounded group.");
  }
  if (projected === null || typeof projected !== "object" || Array.isArray(projected)
    || !hasExactKeys(projected, ["owners"]) || !Array.isArray(projected.owners)) {
    return streamInvalid("FactDeltaStream native observation projector returned an invalid group.");
  }
  const owners = projected.owners.map((owner) => {
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)
      || !hasExactKeys(owner, ["canonical_records", "canonical_dependencies", "record_headers", "dependency_headers", "diagnostic_codes"])
      || !Array.isArray(owner["canonical_records"]) || !Array.isArray(owner["canonical_dependencies"])
      || !Array.isArray(owner["record_headers"]) || !Array.isArray(owner["dependency_headers"]) || !Array.isArray(owner["diagnostic_codes"])
      || owner["canonical_records"].some((row) => typeof row !== "string") || owner["canonical_dependencies"].some((row) => typeof row !== "string")
      || owner["diagnostic_codes"].some((code) => typeof code !== "string")) {
      return streamInvalid("FactDeltaStream native observation projector returned an invalid owner.");
    }
    const recordHeaders = owner["record_headers"].map((header) => {
      if (!hasExactKeys(header, ["proposal_record_key", "category", "kind", "universal_kind", "identity_key"])
        || Object.values(header).some((value) => typeof value !== "string")) return streamInvalid("FactDeltaStream native observation projector returned an invalid record header.");
      return header as SealedStructuralProjectionOwner["record_headers"][number];
    });
    const dependencyHeaders = owner["dependency_headers"].map((header) => {
      if (!hasExactKeys(header, ["proposed_dependency_id", "proposal_record_key", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_role"])
        || Object.values(header).some((value) => typeof value !== "string")) return streamInvalid("FactDeltaStream native observation projector returned an invalid dependency header.");
      return header as SealedStructuralProjectionOwner["dependency_headers"][number];
    });
    if (recordHeaders.length !== owner["canonical_records"].length || dependencyHeaders.length !== owner["canonical_dependencies"].length) return streamInvalid("FactDeltaStream native observation projector returned inconsistent owner rows.");
    return Object.freeze({
      canonical_records: Object.freeze([...owner["canonical_records"]]),
      canonical_dependencies: Object.freeze([...owner["canonical_dependencies"]]),
      record_headers: Object.freeze(recordHeaders),
      dependency_headers: Object.freeze(dependencyHeaders),
      diagnostic_codes: Object.freeze([...owner["diagnostic_codes"]]),
    });
  });
  const rowCount = owners.reduce((count, owner) => count + owner.canonical_records.length + owner.canonical_dependencies.length, 0);
  if (rowCount > FACT_DELTA_STREAM_MAX_ROWS) return streamInvalid(`FactDeltaStream native observation group exceeds ${String(FACT_DELTA_STREAM_MAX_ROWS)} rows.`);
  return Object.freeze(owners);
}

/** Preseals one physical owner group with a single core-owned Rust call.
 *
 * Logical owner identity is deliberately absent from the kernel input: the
 * result is row-intrinsic and is cached against the immutable row objects.
 * Stream headers, receipts and transactions remain owner-delimited when the
 * caller subsequently frames each stream. A rejected group is left entirely
 * on the ordinary scalar path, which will reproduce the exact closed error;
 * this makes group placement an optimization rather than a trust shortcut.
 */
export function prepareFactDeltaStreamStructuralGroup(
  owners: readonly { readonly records: readonly ProposedRecord[]; readonly dependencies: readonly ProposedRecordDependency[] }[],
): boolean {
  if (owners.length === 0 || owners.length > 64) throw new RangeError("A structural kernel owner group must contain between 1 and 64 owners.");
  const records = owners.flatMap((owner) => owner.records);
  const dependencies = owners.flatMap((owner) => owner.dependencies);
  if (records.length + dependencies.length > FACT_DELTA_STREAM_MAX_ROWS) throw new RangeError(`A structural kernel owner group exceeds ${String(FACT_DELTA_STREAM_MAX_ROWS)} rows.`);
  if (activeStructuralKernelPort === undefined || records.some((record) => containsBinary(record.body)) || dependencies.some((dependency) => containsBinary(dependency.source_reference))) return false;
  try {
    prepareStructuralKernelRows(records, dependencies);
  } catch {
    // Scalar framing remains the normative validator and will report the same
    // invalid row or split an otherwise valid oversized byte group.
    return false;
  }
  return records.every((record) => STRUCTURALLY_PREPARED_ROWS.has(record as object))
    && dependencies.every((dependency) => STRUCTURALLY_PREPARED_ROWS.has(dependency as object));
}

class CanonicalArrayDigestAccumulator {
  #hash: Hash | undefined;
  #deferred: { readonly values: readonly (ProposedRecord | ProposedRecordDependency)[]; readonly digest: string } | undefined;
  #first = true;
  #finished = false;
  #ensureHash(): Hash {
    if (this.#hash === undefined) {
      this.#hash = createHash("sha256");
      this.#hash.update("[", "utf8");
      const deferred = this.#deferred;
      this.#deferred = undefined;
      if (deferred !== undefined) for (const value of deferred.values) this.#pushValue(value);
    }
    return this.#hash;
  }
  #pushValue(value: ProposedRecord | ProposedRecordDependency): void {
    const hash = this.#hash!;
    if (!this.#first) hash.update(",", "utf8");
    this.#first = false;
    hash.update(factDeltaStreamCanonicalRow(value), "utf8");
  }
  push(value: ProposedRecord | ProposedRecordDependency): void {
    if (this.#finished) streamInvalid("FactDeltaStream digest accumulator is closed.");
    this.#ensureHash();
    this.#pushValue(value);
  }
  pushBatch(values: readonly (ProposedRecord | ProposedRecordDependency)[], trustedDigest: string | undefined): void {
    if (this.#finished) streamInvalid("FactDeltaStream digest accumulator is closed.");
    if (this.#hash === undefined && this.#deferred === undefined && trustedDigest !== undefined) {
      this.#deferred = { values, digest: trustedDigest };
      return;
    }
    this.#ensureHash();
    for (const value of values) this.#pushValue(value);
  }
  pushCanonicalBatch(values: readonly string[]): void {
    if (this.#finished) streamInvalid("FactDeltaStream digest accumulator is closed.");
    const hash = this.#ensureHash();
    for (const value of values) {
      if (!this.#first) hash.update(",", "utf8");
      this.#first = false;
      hash.update(value, "utf8");
    }
  }
  finish(): string {
    if (this.#finished) streamInvalid("FactDeltaStream digest accumulator is closed.");
    this.#finished = true;
    if (this.#deferred !== undefined) return this.#deferred.digest;
    const hash = this.#ensureHash();
    hash.update("]", "utf8");
    return `sha256:${hash.digest("hex")}`;
  }
}

function streamBatchPayload(value: Omit<FactDeltaStreamBatch, "chunk_digest">): Omit<FactDeltaStreamBatch, "chunk_digest"> {
  return value;
}

/** Hashes the closed batch object in canonical key order while reusing the
 * native canonical row text. This is byte-identical to canonicalSha256 over
 * the payload without serializing every record and dependency a second time. */
function streamBatchDigest(value: Omit<FactDeltaStreamBatch, "chunk_digest">): string {
  const hash = createHash("sha256");
  const scalar = (entry: unknown): void => { hash.update(canonicalJson(entry), "utf8"); };
  const rows = (entries: readonly (ProposedRecord | ProposedRecordDependency)[]): void => {
    hash.update("[", "utf8");
    entries.forEach((entry, index) => {
      if (index > 0) hash.update(",", "utf8");
      hash.update(factDeltaStreamCanonicalRow(entry), "utf8");
    });
    hash.update("]", "utf8");
  };
  hash.update("{\"byte_length\":", "utf8"); scalar(value.byte_length);
  hash.update(",\"dependencies\":", "utf8"); rows(value.dependencies);
  hash.update(",\"dependency_count\":", "utf8"); scalar(value.dependency_count);
  hash.update(",\"fact_delta_id\":", "utf8"); scalar(value.fact_delta_id);
  hash.update(",\"final\":", "utf8"); scalar(value.final);
  hash.update(",\"protocol_version\":", "utf8"); scalar(value.protocol_version);
  hash.update(",\"record_count\":", "utf8"); scalar(value.record_count);
  hash.update(",\"records\":", "utf8"); rows(value.records);
  hash.update(",\"row_count\":", "utf8"); scalar(value.row_count);
  hash.update(",\"schema_id\":", "utf8"); scalar(value.schema_id);
  hash.update(",\"sequence\":", "utf8"); scalar(value.sequence);
  hash.update("}", "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function sealedStreamBatchDigest(
  value: Omit<FactDeltaStreamBatch, "chunk_digest" | "records" | "dependencies">,
  rowsValue: SealedFactDeltaStreamRows,
): string {
  const hash = createHash("sha256");
  const scalar = (entry: unknown): void => { hash.update(canonicalJson(entry), "utf8"); };
  const rows = (entries: readonly string[]): void => {
    hash.update("[", "utf8");
    entries.forEach((entry, index) => {
      if (index > 0) hash.update(",", "utf8");
      hash.update(entry, "utf8");
    });
    hash.update("]", "utf8");
  };
  hash.update("{\"byte_length\":", "utf8"); scalar(value.byte_length);
  hash.update(",\"dependencies\":", "utf8"); rows(rowsValue.canonical_dependencies);
  hash.update(",\"dependency_count\":", "utf8"); scalar(value.dependency_count);
  hash.update(",\"fact_delta_id\":", "utf8"); scalar(value.fact_delta_id);
  hash.update(",\"final\":", "utf8"); scalar(value.final);
  hash.update(",\"protocol_version\":", "utf8"); scalar(value.protocol_version);
  hash.update(",\"record_count\":", "utf8"); scalar(value.record_count);
  hash.update(",\"records\":", "utf8"); rows(rowsValue.canonical_records);
  hash.update(",\"row_count\":", "utf8"); scalar(value.row_count);
  hash.update(",\"schema_id\":", "utf8"); scalar(value.schema_id);
  hash.update(",\"sequence\":", "utf8"); scalar(value.sequence);
  hash.update("}", "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/** Reconstitutes only the bounded stream envelope. Canonical row text remains
 * opaque until the receiving core revalidates it through Rust. */
export function buildSealedFactDeltaStreamBatch(
  metadata: Omit<FactDeltaStreamBatch, "records" | "dependencies">,
  rows: SealedFactDeltaStreamRows,
): FactDeltaStreamBatch {
  if (rows.canonical_records.length !== metadata.record_count
    || rows.canonical_dependencies.length !== metadata.dependency_count
    || metadata.row_count !== metadata.record_count + metadata.dependency_count
    || metadata.row_count > FACT_DELTA_STREAM_MAX_ROWS
    || metadata.byte_length > FACT_DELTA_STREAM_MAX_BYTES) streamInvalid("Sealed FactDeltaStream batch counts or bounds are invalid.");
  const { chunk_digest: chunkDigest, ...payload } = metadata;
  if (sealedStreamBatchDigest(payload, rows) !== chunkDigest) streamInvalid("Sealed FactDeltaStream chunk digest is invalid.");
  const batch = deepFreeze({ ...metadata, records: [], dependencies: [] }) as FactDeltaStreamBatch;
  SEALED_STREAM_ROWS.set(batch as object, Object.freeze({
    canonical_records: Object.freeze([...rows.canonical_records]),
    canonical_dependencies: Object.freeze([...rows.canonical_dependencies]),
  }));
  VALIDATED_STREAM_BATCHES.add(batch as object);
  return batch;
}

export function factDeltaStreamSealedRows(batch: FactDeltaStreamBatch): SealedFactDeltaStreamRows | undefined {
  return SEALED_STREAM_ROWS.get(batch as object);
}

/** Frames native-projected canonical rows without reconstructing logical
 * ProposedRecord objects in JavaScript. Compact headers exist only to compute
 * the exact six-column private protocol byte budget; the receiving core still
 * reparses and validates every canonical row independently. */
export function buildProjectedSealedFactDeltaStreamBatch(input: {
  readonly fact_delta_id: string;
  readonly sequence: number;
  readonly final: boolean;
  readonly canonical_records: readonly string[];
  readonly canonical_dependencies: readonly string[];
  readonly record_headers: SealedStructuralProjectionOwner["record_headers"];
  readonly dependency_headers: SealedStructuralProjectionOwner["dependency_headers"];
}): FactDeltaStreamBatch {
  if (input.record_headers.length !== input.canonical_records.length || input.dependency_headers.length !== input.canonical_dependencies.length) streamInvalid("Projected FactDeltaStream row headers are inconsistent.");
  const native = buildFactDeltaBatch({
    sequence: input.sequence,
    final: input.final,
    records: input.record_headers.map((header, index) => ({ strings: [header.proposal_record_key, header.category, header.kind, header.universal_kind, header.identity_key, input.canonical_records[index]!] })),
    graph_edges: [], identities: [],
    dependencies: input.dependency_headers.map((header, index) => ({ strings: [header.proposed_dependency_id, header.proposal_record_key, header.dependency_artifact_id, header.dependency_artifact_version_id, header.dependency_role, input.canonical_dependencies[index]!] })),
  });
  const payload = {
    protocol_version: FACT_DELTA_STREAM_PROTOCOL_VERSION,
    schema_id: FACT_DELTA_STREAM_BATCH_SCHEMA_ID,
    fact_delta_id: input.fact_delta_id,
    sequence: input.sequence,
    final: input.final,
    record_count: input.canonical_records.length,
    dependency_count: input.canonical_dependencies.length,
    row_count: input.canonical_records.length + input.canonical_dependencies.length,
    byte_length: native.byte_length,
  } as const;
  const rows = { canonical_records: input.canonical_records, canonical_dependencies: input.canonical_dependencies };
  return buildSealedFactDeltaStreamBatch({ ...payload, chunk_digest: sealedStreamBatchDigest(payload, rows) }, rows);
}

function nativeRows(records: readonly ProposedRecord[], dependencies: readonly ProposedRecordDependency[], includePublication = true) {
  return {
    records: records.map((record) => {
      const publication = includePublication ? factDeltaStreamPublicationRow(record) : undefined;
      const bodyPayloadHex = includePublication ? factDeltaStreamBodyPayloadHex(record) : undefined;
      return { strings: [record.proposal_record_key, record.category, record.kind, record.universal_kind, record.identity_key, factDeltaStreamCanonicalRow(record), publication === undefined ? "" : canonicalJson(publication), bodyPayloadHex ?? ""] };
    }).map((row) => includePublication ? row : { strings: row.strings.slice(0, 6) }),
    // Relations and identities are deterministic projections of the full
    // authoritative record row above. Persisting them here created two extra
    // SQLite rows per common semantic record even though no recovery or
    // publication reader consumes those derived lanes. Keep the additive
    // sections in the private batch contract, but leave them empty; typed
    // publication derives the same projections once from the sealed record
    // sequence.
    graph_edges: [],
    identities: [],
    dependencies: dependencies.map((dependency) => ({ strings: [dependency.proposed_dependency_id, dependency.proposal_record_key, dependency.dependency_artifact_id, dependency.dependency_artifact_version_id, dependency.dependency_role, factDeltaStreamCanonicalRow(dependency)] })),
  };
}

// `FactDeltaStreamBatch.byte_length` is part of the process-neutral stream
// contract. It must not change depending on whether the receiving core has
// enabled the private typed-publication accelerator. Measure the stable six
// transport columns here; the enriched eight-column batch is cached and
// staged separately by `factDeltaStreamNativeBatch`.
function factDeltaStreamProtocolByteLength(batch: Pick<FactDeltaStreamBatch, "sequence" | "final" | "records" | "dependencies">): number {
  return buildFactDeltaBatch({ sequence: batch.sequence, final: batch.final, ...nativeRows(batch.records, batch.dependencies, false) }).byte_length;
}

// A validated batch is immutable and keeps its object identity through the
// stream validator. Retain the native columnar projection computed while
// checking its byte budget so engine staging does not serialize every row a
// second time immediately afterwards.
const VALIDATED_NATIVE_BATCHES = new WeakMap<object, FactDeltaBatch>();

function sealedNativeRows(acceptance: StructuralKernelCanonicalAcceptance, includePublication: boolean) {
  const rows = acceptance.records.map((record, index) => {
    const publication = acceptance.kernel.publication_records[index];
    const strings = [
      record.proposal_record_key, record.category, record.kind, record.universal_kind, record.identity_key,
      acceptance.kernel.canonical_records[index]!,
    ];
    if (includePublication) strings.push(canonicalJson(publication), acceptance.kernel.record_body_payload_hexes[index]!);
    return { strings };
  });
  return {
    records: rows,
    graph_edges: [],
    identities: [],
    dependencies: acceptance.dependencies.map((dependency, index) => ({ strings: [
      dependency.proposed_dependency_id, dependency.proposal_record_key, dependency.dependency_artifact_id,
      dependency.dependency_artifact_version_id, dependency.dependency_role, acceptance.kernel.canonical_dependencies[index]!,
    ] })),
  };
}

/** Runs the independent core-owned Rust acceptance pass over opaque producer
 * rows and caches only its compact typed result against the stream envelope. */
export function acceptSealedFactDeltaStreamBatch(
  batch: FactDeltaStreamBatch,
  definitions: readonly StructuralKernelRecordDefinition[],
): StructuralKernelCanonicalAcceptance | undefined {
  const rows = SEALED_STREAM_ROWS.get(batch as object);
  if (rows === undefined) return undefined;
  const cached = SEALED_STRUCTURAL_ACCEPTANCE.get(batch as object);
  if (cached !== undefined) return cached;
  const port = activeStructuralKernelPort;
  if (port?.structuralKernelCanonicalBatch === undefined) return streamInvalid("Sealed FactDeltaStream rows require the verified core-owned Rust binding.");
  let acceptance: StructuralKernelCanonicalAcceptance;
  try {
    acceptance = port.structuralKernelCanonicalBatch({
      canonical_records: rows.canonical_records,
      canonical_dependencies: rows.canonical_dependencies,
      record_definitions: definitions,
    });
  } catch {
    return streamInvalid("The core-owned Rust acceptance kernel rejected sealed FactDeltaStream rows.");
  }
  const kernel = acceptance.kernel;
  if (!hasExactKeys(acceptance, ["kernel", "records", "dependencies", "record_schema_attestations"])
    || !hasExactKeys(kernel, STRUCTURAL_KERNEL_RESULT_KEYS)
    || !Array.isArray(acceptance.records) || acceptance.records.length !== rows.canonical_records.length
    || !Array.isArray(acceptance.dependencies) || acceptance.dependencies.length !== rows.canonical_dependencies.length
    || !Array.isArray(acceptance.record_schema_attestations) || acceptance.record_schema_attestations.length !== acceptance.records.length
    || kernel.canonical_records.length !== rows.canonical_records.length || kernel.canonical_records.some((row, index) => row !== rows.canonical_records[index])
    || kernel.canonical_dependencies.length !== rows.canonical_dependencies.length || kernel.canonical_dependencies.some((row, index) => row !== rows.canonical_dependencies[index])
    || kernel.record_digests.length !== acceptance.records.length || kernel.publication_records.length !== acceptance.records.length
    || kernel.record_body_payload_hexes.length !== acceptance.records.length) {
    return streamInvalid("The core-owned Rust acceptance kernel returned an inconsistent sealed result.");
  }
  const protocolNative = buildFactDeltaBatch({ sequence: batch.sequence, final: batch.final, ...sealedNativeRows(acceptance, false) });
  if (protocolNative.byte_length !== batch.byte_length) return streamInvalid("Sealed FactDeltaStream byte length differs from the core-owned projection.");
  let native: FactDeltaBatch;
  try { native = buildFactDeltaBatch({ sequence: batch.sequence, final: batch.final, ...sealedNativeRows(acceptance, true) }); }
  catch { native = protocolNative; }
  VALIDATED_NATIVE_BATCHES.set(batch as object, native);
  STRUCTURAL_KERNEL_BATCH_SUMMARIES.set(batch as object, { records_digest: kernel.records_digest, dependencies_digest: kernel.dependencies_digest });
  SEALED_STRUCTURAL_ACCEPTANCE.set(batch as object, acceptance);
  return acceptance;
}

/** Full-fidelity native staging projection for exactly one logical stream batch. */
export function factDeltaStreamNativeBatch(batch: Pick<FactDeltaStreamBatch, "sequence" | "final" | "records" | "dependencies">): FactDeltaBatch {
  const cached = VALIDATED_NATIVE_BATCHES.get(batch as object);
  if (cached !== undefined) return cached;
  if (SEALED_STREAM_ROWS.has(batch as object)) return streamInvalid("Sealed FactDeltaStream rows must pass core acceptance before typed staging.");
  const structural = prepareStructuralKernelRows(batch.records, batch.dependencies);
  let native: FactDeltaBatch;
  try {
    native = buildFactDeltaBatch({ sequence: batch.sequence, final: batch.final, ...nativeRows(batch.records, batch.dependencies) });
  } catch {
    // A producer can legitimately seal a batch just below the public 4 MiB
    // budget. Adding an exact UCE body as hex may make only the private typed
    // projection exceed that physical budget. Preserve the complete canonical
    // six-column transport in that case; candidate-wide typed eligibility will
    // fail closed and publication will use the exact portable materializer.
    native = buildFactDeltaBatch({ sequence: batch.sequence, final: batch.final, ...nativeRows(batch.records, batch.dependencies, false) });
  }
  VALIDATED_NATIVE_BATCHES.set(batch as object, native);
  if (structural !== undefined) STRUCTURAL_KERNEL_BATCH_SUMMARIES.set(batch as object, {
    records_digest: structural.records_digest,
    dependencies_digest: structural.dependencies_digest,
  });
  return native;
}

export function buildFactDeltaStreamBatch(input: {
  readonly fact_delta_id: string;
  readonly sequence: number;
  readonly final: boolean;
  readonly records: readonly ProposedRecord[];
  readonly dependencies: readonly ProposedRecordDependency[];
}): FactDeltaStreamBatch {
  if (typeof input.fact_delta_id !== "string" || input.fact_delta_id.length === 0 || !Number.isSafeInteger(input.sequence) || input.sequence < 0) streamInvalid("FactDeltaStream batch identity or sequence is invalid.");
  const nativeCanonicalization = activeStructuralKernelPort !== undefined
    && !input.records.some((record) => containsBinary(record.body))
    && !input.dependencies.some((dependency) => containsBinary(dependency.source_reference));
  const records = input.records.map((record) => validateProposedRecordRow(record, !nativeCanonicalization));
  const dependencies = input.dependencies.map((dependency) => validateProposedDependencyRow(dependency, !nativeCanonicalization));
  const row_count = records.length + dependencies.length;
  if (row_count > FACT_DELTA_STREAM_MAX_ROWS) streamInvalid(`FactDeltaStream batch exceeds ${String(FACT_DELTA_STREAM_MAX_ROWS)} rows.`);
  let native: FactDeltaBatch;
  try { native = factDeltaStreamNativeBatch({ sequence: input.sequence, final: input.final, records, dependencies }); }
  catch (error) {
    if (error instanceof PluginSdkError) throw error;
    return streamInvalid(`FactDeltaStream batch exceeds ${String(FACT_DELTA_STREAM_MAX_BYTES)} bytes.`);
  }
  const payload = streamBatchPayload({
    protocol_version: FACT_DELTA_STREAM_PROTOCOL_VERSION,
    schema_id: FACT_DELTA_STREAM_BATCH_SCHEMA_ID,
    fact_delta_id: input.fact_delta_id,
    sequence: input.sequence,
    final: input.final,
    record_count: records.length,
    dependency_count: dependencies.length,
    row_count,
    byte_length: factDeltaStreamProtocolByteLength({ sequence: input.sequence, final: input.final, records, dependencies }),
    records,
    dependencies,
  });
  const frozen = deepFreeze({ ...payload, chunk_digest: streamBatchDigest(payload) });
  VALIDATED_NATIVE_BATCHES.set(frozen as object, native);
  return frozen;
}

export function factDeltaStreamHeaderDigest(value: Omit<FactDeltaStreamHeader, "stream_digest">): string {
  return canonicalSha256(value);
}

export function validateFactDeltaStreamHeader(value: unknown): FactDeltaStreamHeader {
  if (typeof value === "object" && value !== null && VALIDATED_STREAM_HEADERS.has(value)) return value as FactDeltaStreamHeader;
  let header: FactDeltaStreamHeader;
  try { header = validateFactDeltaStreamHeaderValue(value); } catch { return streamInvalid("FactDeltaStream header is structurally invalid."); }
  if (header.replacement_scope_count !== header.replacement_scopes.length || header.replacement_scopes_digest !== canonicalArrayDigest(header.replacement_scopes)) streamInvalid("FactDeltaStream replacement scope count or digest is invalid.");
  if (header.input_artifact_version_count !== header.input_artifact_version_ids.length || header.input_artifact_versions_digest !== canonicalArrayDigest(header.input_artifact_version_ids)) streamInvalid("FactDeltaStream artifact input count or digest is invalid.");
  if (header.input_record_count !== header.input_record_ids.length || header.input_records_digest !== canonicalArrayDigest(header.input_record_ids)) streamInvalid("FactDeltaStream record input count or digest is invalid.");
  if (header.completeness_claim_count !== header.completeness_claims.length || header.completeness_claims_digest !== canonicalArrayDigest(header.completeness_claims)) streamInvalid("FactDeltaStream completeness count or digest is invalid.");
  const { stream_digest: _streamDigest, ...payload } = header;
  if (header.stream_digest !== factDeltaStreamHeaderDigest(payload)) streamInvalid("FactDeltaStream header digest is invalid.");
  const frozen = deepFreeze(header);
  VALIDATED_STREAM_HEADERS.add(frozen as object);
  return frozen;
}

export function validateFactDeltaStreamBatch(value: unknown): FactDeltaStreamBatch {
  if (typeof value === "object" && value !== null && VALIDATED_STREAM_BATCHES.has(value)) return value as FactDeltaStreamBatch;
  let batch: FactDeltaStreamBatch;
  try { batch = validateFactDeltaStreamBatchValue(value); } catch { return streamInvalid("FactDeltaStream batch is structurally invalid."); }
  if (batch.record_count !== batch.records.length || batch.dependency_count !== batch.dependencies.length || batch.row_count !== batch.records.length + batch.dependencies.length) streamInvalid("FactDeltaStream batch row counts are invalid.");
  if (batch.row_count > FACT_DELTA_STREAM_MAX_ROWS) streamInvalid("FactDeltaStream batch row budget is exceeded.");
  const nativeCanonicalization = activeStructuralKernelPort !== undefined
    && !batch.records.some((record) => containsBinary(record.body))
    && !batch.dependencies.some((dependency) => containsBinary(dependency.source_reference));
  for (const record of batch.records) validateProposedRecordRow(record, !nativeCanonicalization);
  for (const dependency of batch.dependencies) validateProposedDependencyRow(dependency, !nativeCanonicalization);
  let native: FactDeltaBatch;
  try { native = factDeltaStreamNativeBatch(batch); } catch (error) {
    if (error instanceof PluginSdkError) throw error;
    return streamInvalid("FactDeltaStream batch byte budget is exceeded.");
  }
  if (factDeltaStreamProtocolByteLength(batch) !== batch.byte_length || batch.byte_length > FACT_DELTA_STREAM_MAX_BYTES) streamInvalid("FactDeltaStream batch byte length is invalid.");
  const { chunk_digest: _chunkDigest, ...payload } = batch;
  if (batch.chunk_digest !== streamBatchDigest(payload)) streamInvalid("FactDeltaStream chunk digest is invalid.");
  const frozen = deepFreeze(batch);
  VALIDATED_STREAM_BATCHES.add(frozen as object);
  return frozen;
}

export class FactDeltaStreamValidator {
  readonly header: FactDeltaStreamHeader;
  readonly #records = new CanonicalArrayDigestAccumulator();
  readonly #dependencies = new CanonicalArrayDigestAccumulator();
  #nextSequence = 0;
  #recordCount = 0;
  #dependencyCount = 0;
  #byteLength = 0;
  #final = false;
  #finished = false;

  constructor(header: unknown) { this.header = validateFactDeltaStreamHeader(header); }

  accept_batch(value: unknown): FactDeltaStreamBatch {
    if (this.#finished || this.#final) streamInvalid("FactDeltaStream is already final and closed.");
    const batch = validateFactDeltaStreamBatch(value);
    if (batch.fact_delta_id !== this.header.fact_delta_id) streamInvalid("FactDeltaStream batch identity does not match its header.");
    if (batch.sequence !== this.#nextSequence) streamInvalid("FactDeltaStream batch sequence is duplicate or out of order.");
    if (this.#recordCount + batch.record_count > this.header.proposed_record_count || this.#dependencyCount + batch.dependency_count > this.header.proposed_dependency_count) streamInvalid("FactDeltaStream batch counts exceed the header.");
    const sealed = SEALED_STREAM_ROWS.get(batch as object);
    if (sealed !== undefined) {
      this.#records.pushCanonicalBatch(sealed.canonical_records);
      this.#dependencies.pushCanonicalBatch(sealed.canonical_dependencies);
    } else {
      const structural = STRUCTURAL_KERNEL_BATCH_SUMMARIES.get(batch as object);
      this.#records.pushBatch(batch.records, structural?.records_digest);
      this.#dependencies.pushBatch(batch.dependencies, structural?.dependencies_digest);
    }
    this.#recordCount += batch.record_count;
    this.#dependencyCount += batch.dependency_count;
    this.#byteLength += batch.byte_length;
    this.#nextSequence += 1;
    this.#final = batch.final;
    return batch;
  }

  finish(): FactDeltaStreamValidationSummary {
    if (this.#finished) streamInvalid("FactDeltaStream has already been finished.");
    if (!this.#final) streamInvalid("FactDeltaStream is missing its final batch.");
    this.#finished = true;
    if (this.#recordCount !== this.header.proposed_record_count || this.#dependencyCount !== this.header.proposed_dependency_count) streamInvalid("FactDeltaStream aggregate count does not match its header.");
    if (this.#records.finish() !== this.header.proposed_records_digest || this.#dependencies.finish() !== this.header.proposed_dependencies_digest) streamInvalid("FactDeltaStream aggregate digest does not match its header.");
    return Object.freeze({ batch_count: this.#nextSequence, record_count: this.#recordCount, dependency_count: this.#dependencyCount, byte_length: this.#byteLength });
  }
}

function factDeltaStreamHeader(delta: FactDelta, options: FactDeltaV1StreamAdapterOptions): FactDeltaStreamHeader {
  if (!options.cancellation_id) streamInvalid("FactDeltaStream cancellation identity is required.");
  const payload: Omit<FactDeltaStreamHeader, "stream_digest"> = {
    protocol_version: FACT_DELTA_STREAM_PROTOCOL_VERSION,
    schema_id: FACT_DELTA_STREAM_SCHEMA_ID,
    fact_delta_id: delta.fact_delta_id,
    candidate_generation_id: delta.candidate_generation_id,
    workspace_id: delta.workspace_id,
    ...(delta.base_snapshot_id === undefined ? {} : { base_snapshot_id: delta.base_snapshot_id }),
    work_item_id: delta.work_item_id,
    plugin_id: delta.plugin_id,
    plugin_version: delta.plugin_version,
    analysis_digest: delta.analysis_digest,
    analysis_configuration_digest: delta.analysis_configuration_digest,
    ...(delta.publication_stage_id === undefined ? {} : { publication_stage_id: delta.publication_stage_id }),
    owner_artifact_id: delta.owner_artifact_id,
    owner_artifact_version_id: delta.owner_artifact_version_id,
    replacement_scopes: delta.replacement_scopes,
    replacement_scope_count: delta.replacement_scopes.length,
    replacement_scopes_digest: canonicalArrayDigest(delta.replacement_scopes),
    input_artifact_version_ids: delta.input_artifact_version_ids,
    input_artifact_version_count: delta.input_artifact_version_ids.length,
    input_artifact_versions_digest: canonicalArrayDigest(delta.input_artifact_version_ids),
    input_record_ids: delta.input_record_ids,
    input_record_count: delta.input_record_ids.length,
    input_records_digest: canonicalArrayDigest(delta.input_record_ids),
    plugin_input_access_manifest_id: delta.plugin_input_access_manifest_id,
    plugin_input_access_manifest_digest: delta.plugin_input_access_manifest_digest,
    analysis_input_digest: delta.analysis_input_digest,
    completeness_claims: delta.completeness_claims,
    completeness_claim_count: delta.completeness_claims.length,
    completeness_claims_digest: canonicalArrayDigest(delta.completeness_claims),
    proposed_record_count: delta.proposed_records.length,
    proposed_records_digest: canonicalArrayDigest(delta.proposed_records),
    proposed_dependency_count: delta.proposed_dependencies.length,
    proposed_dependencies_digest: canonicalArrayDigest(delta.proposed_dependencies),
    created_at: delta.created_at,
    delta_digest: delta.delta_digest,
    cancellation_id: options.cancellation_id,
    backpressure: { acknowledgement_mode: "per_batch", max_in_flight_batches: options.max_in_flight_batches ?? 1 },
  };
  return deepFreeze({ ...payload, stream_digest: factDeltaStreamHeaderDigest(payload) });
}

/** Bounded compatibility adapter for existing FactDelta@1 packages. It
 * retains the caller's one v1 value and creates only one transient batch. */
export function adaptFactDeltaV1ToStream(delta: FactDelta, options: FactDeltaV1StreamAdapterOptions): FactDeltaStream {
  const maxRows = options.max_rows ?? FACT_DELTA_STREAM_MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > FACT_DELTA_STREAM_MAX_ROWS) streamInvalid("FactDeltaStream adapter row limit is invalid.");
  const header = factDeltaStreamHeader(delta, options);
  const batches = (async function* (): AsyncGenerator<FactDeltaStreamBatch> {
    let recordOffset = 0;
    let dependencyOffset = 0;
    let sequence = 0;
    if (delta.proposed_records.length === 0 && delta.proposed_dependencies.length === 0) {
      yield buildFactDeltaStreamBatch({ fact_delta_id: delta.fact_delta_id, sequence: 0, final: true, records: [], dependencies: [] });
      return;
    }
    while (recordOffset < delta.proposed_records.length || dependencyOffset < delta.proposed_dependencies.length) {
      const remaining = delta.proposed_records.length - recordOffset + delta.proposed_dependencies.length - dependencyOffset;
      let rowBudget = Math.min(maxRows, remaining);
      while (true) {
        const recordCount = Math.min(rowBudget, delta.proposed_records.length - recordOffset);
        const dependencyCount = Math.min(rowBudget - recordCount, delta.proposed_dependencies.length - dependencyOffset);
        const records = delta.proposed_records.slice(recordOffset, recordOffset + recordCount);
        const dependencies = delta.proposed_dependencies.slice(dependencyOffset, dependencyOffset + dependencyCount);
        const final = recordOffset + recordCount === delta.proposed_records.length && dependencyOffset + dependencyCount === delta.proposed_dependencies.length;
        try {
          const batch = buildFactDeltaStreamBatch({ fact_delta_id: delta.fact_delta_id, sequence, final, records, dependencies });
          yield batch;
          recordOffset += recordCount;
          dependencyOffset += dependencyCount;
          sequence += 1;
          break;
        } catch (error) {
          if (rowBudget === 1) throw error;
          rowBudget = Math.max(1, Math.floor(rowBudget / 2));
        }
      }
    }
  })();
  return { header, batches };
}

export function runtimeComponentImplementationManifestV2Digest(value: RuntimeComponentImplementationManifestV2, digests: Pick<PluginDigestAuthority, "runtime_implementation_v2">): string {
  if (digests.runtime_implementation_v2 === undefined) throw new TypeError("The v2 runtime implementation digest authority is required.");
  return digests.runtime_implementation_v2(validateRuntimeComponentImplementationManifestV2(value));
}

export function pluginRuntimeExecutableBindingDigest(value: Omit<PluginRuntimeExecutableBinding, "binding_digest">, digests: Pick<PluginDigestAuthority, "runtime_executable_binding">): string {
  if (digests.runtime_executable_binding === undefined) throw new TypeError("The executable binding digest authority is required.");
  return digests.runtime_executable_binding(value);
}

export function validatePluginRuntimeExecutableBinding(value: unknown, digests: Pick<PluginDigestAuthority, "runtime_executable_binding">): PluginRuntimeExecutableBinding {
  let binding: PluginRuntimeExecutableBinding;
  try { binding = validatePluginRuntimeExecutableBindingValue(value); } catch { return streamInvalid("Plugin runtime executable binding is structurally invalid."); }
  const { binding_digest: _bindingDigest, ...payload } = binding;
  if (binding.binding_digest !== pluginRuntimeExecutableBindingDigest(payload, digests)) streamInvalid("Plugin runtime executable binding digest is invalid.");
  return deepFreeze(binding);
}

function validatedPayload<T extends PluginWorkerCall | PluginWorkerOutcome>(
  operation: () => unknown,
  kind: T,
  limits: PortMaterializationLimits,
): unknown {
  try {
    return deepFreeze(materializePortResult(operation(), limits));
  } catch {
    return invalid(`Worker ${CALLS.has(kind as PluginWorkerCall) ? "call" : "outcome"} payload is invalid.`);
  }
}

export function workerRequestDigest(input: {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly call: PluginWorkerCall;
  readonly deadline: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}): string {
  return canonicalSha256({
    protocol_version: input.protocol_version,
    request_id: input.request_id,
    call: input.call,
    deadline: input.deadline,
    cancellation_id: input.cancellation_id,
    payload: input.payload,
  });
}

export class ClosedWorkerProtocol {
  constructor(
    private readonly validator: WorkerPayloadValidator,
    private readonly materialization_limits: PortMaterializationLimits,
  ) {
    try {
      materializePortResult(null, materialization_limits);
    } catch {
      invalid("Worker protocol materialization limits are invalid.");
    }
  }

  accept_call(foreignValue: unknown): PluginWorkerRequestEnvelope {
    let value: unknown;
    try {
      value = materializePortResult(foreignValue, this.materialization_limits);
    } catch {
      return invalid("Worker call envelope is malformed.");
    }
    if (!hasExactKeys(value, ["protocol_version", "request_id", "request_digest", "call", "deadline", "cancellation_id", "payload"])
      || !isNonemptyString(value["protocol_version"])
      || !isNonemptyString(value["request_id"])
      || !isNonemptyString(value["request_digest"])
      || typeof value["call"] !== "string"
      || !CALLS.has(value["call"] as PluginWorkerCall)
      || !isCanonicalDeadline(value["deadline"])
      || !isNonemptyString(value["cancellation_id"])) invalid("Worker call envelope is invalid.");
    const call = value["call"] as PluginWorkerCall;
    const payload = validatedPayload(() => this.validator.validate_call(call, value["payload"]), call, this.materialization_limits);
    const expectedDigest = workerRequestDigest({
      protocol_version: value["protocol_version"],
      request_id: value["request_id"],
      call,
      deadline: value["deadline"],
      cancellation_id: value["cancellation_id"],
      payload,
    });
    if (value["request_digest"] !== expectedDigest) invalid("Worker request digest is invalid.");
    return deepFreeze({
      protocol_version: value["protocol_version"],
      request_id: value["request_id"],
      request_digest: expectedDigest,
      call,
      deadline: value["deadline"],
      cancellation_id: value["cancellation_id"],
      payload,
    });
  }

  accept_outcome(request: PluginWorkerRequestEnvelope, foreignValue: unknown): PluginWorkerResponseEnvelope {
    let value: unknown;
    try {
      value = materializePortResult(foreignValue, this.materialization_limits);
    } catch {
      return invalid("Worker outcome envelope is malformed.");
    }
    if (!hasExactKeys(value, ["protocol_version", "request_id", "request_digest", "call", "outcome", "payload"])
      || !isNonemptyString(value["protocol_version"])
      || !isNonemptyString(value["request_id"])
      || !isNonemptyString(value["request_digest"])
      || typeof value["call"] !== "string"
      || !CALLS.has(value["call"] as PluginWorkerCall)
      || typeof value["outcome"] !== "string"
      || !OUTCOMES.has(value["outcome"] as PluginWorkerOutcome)) invalid("Worker outcome envelope is invalid.");
    if (value["protocol_version"] !== request.protocol_version
      || value["request_id"] !== request.request_id
      || value["request_digest"] !== request.request_digest
      || value["call"] !== request.call) invalid("Worker outcome correlation is invalid.");
    const outcome = value["outcome"] as PluginWorkerOutcome;
    const payload = validatedPayload(
      () => this.validator.validate_outcome(request.call, outcome, value["payload"]),
      outcome,
      this.materialization_limits,
    );
    return deepFreeze({
      protocol_version: request.protocol_version,
      request_id: request.request_id,
      request_digest: request.request_digest,
      call: request.call,
      outcome,
      payload,
    });
  }
}
