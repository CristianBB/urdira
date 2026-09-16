import { createHash } from "node:crypto";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { acceptSealedFactDeltaStreamBatch, canonicalJson, canonicalSha256, factDeltaStreamAttestedFacets, factDeltaStreamBodyPayloadHex, factDeltaStreamCanonicalRow, factDeltaStreamNativeBatch, factDeltaStreamPublicationRow, factDeltaStreamRecordDigest, FactDeltaStreamValidator } from "@urdira/plugin-sdk";
import type { ArtifactWorkItem, CandidateIssueScope, ClosedPayloadSchema, FactDelta, FactDeltaBatch, FactDeltaStreamBatch, FactDeltaStreamHeader, IndexCandidate, PluginInputAccessManifest, ProposedRecord, ProposedRecordDependency, RecordArtifactDependency, ReplacementScope } from "@urdira/contracts";
import { isFinalizedPluginInputAccessManifest, pluginInputAccessManifestDigest, pluginInputAccessManifestId, type AutomaticPluginInputAccessManifest, type FactDeltaStream, type FactDeltaStreamValidationSummary } from "@urdira/plugin-sdk";
import { record as recordTiming, timed, timedSync, timingEnabled } from "./debug-timing.js";

export interface FactDeltaValidationInput {
  readonly candidate: IndexCandidate;
  readonly work_item: ArtifactWorkItem;
  readonly raw_delta: unknown;
  readonly accepted_manifest: AutomaticPluginInputAccessManifest;
  readonly expected_replacement_scopes: readonly ReplacementScope[];
  readonly target_registry: CandidateTargetRegistry;
  readonly base_records: readonly BaseCandidateRecord[];
  readonly base_record_dependencies: readonly RecordArtifactDependency[];
  readonly staged_records: readonly ValidatedStagedRecord[];
  readonly analysis_context_digest: string;
}

export interface RegisteredArtifactVersion {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly content_hash: string;
  readonly closed?: boolean;
}

export interface DependencyClosureEntry {
  readonly dependency_artifact_version_id: string;
  readonly dependency_artifact_id: string;
  readonly dependency_role: string;
  readonly digest: string;
  readonly closed?: boolean;
}

export interface ValidatedStagedRecord {
  readonly staged_record_id: string;
  readonly producing_work_item_id: string;
  readonly proposal_record_key: string;
  readonly validated_record_digest: string;
  readonly transitive_artifact_version_ids: readonly string[];
}

export interface BaseCandidateRecord {
  readonly record_id: string;
  readonly record_digest: string;
  readonly workspace_id: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly identity_type?: "entity" | "relation" | "diagnostic";
  readonly identity_id?: string;
  readonly identity_key?: string;
  readonly valid_from_generation: number;
  readonly valid_to_generation?: number;
}

export interface RegisteredRecordKind {
  readonly kind: string;
  readonly category: string;
  readonly universal_kind: string;
  readonly schema_version: number;
  readonly allowed_facets: readonly string[];
  readonly required_facets?: readonly string[];
  readonly body_schema?: ClosedPayloadSchema;
}

export interface CandidateTargetRegistry {
  readonly registry_snapshot_id: string;
  readonly record_kinds: ReadonlyMap<string, RegisteredRecordKind>;
  readonly identifiers: ReadonlySet<string>;
  readonly dependency_roles: ReadonlySet<string>;
  readonly artifact_versions?: ReadonlyMap<string, RegisteredArtifactVersion>;
  readonly dependency_closure?: ReadonlyMap<string, DependencyClosureEntry>;
  readonly closed_record_ids?: ReadonlySet<string>;
}

export interface ValidatedReplacementSet {
  readonly scope: ReplacementScope;
  readonly records: readonly ProposedRecord[];
  readonly record_set_digest: string;
}

export interface ValidatedFactDelta {
  readonly delta: FactDelta;
  readonly replacement_sets: readonly ValidatedReplacementSet[];
  readonly input_artifact_version_ids: readonly string[];
  readonly input_record_ids: readonly string[];
  readonly transitive_artifact_version_ids: readonly string[];
  readonly validated_staged_records: readonly ValidatedStagedRecord[];
}

export interface AcceptedFactDelta extends ValidatedFactDelta {
  readonly acceptance: "inserted" | "already_present";
}

/**
 * The compact form retained after acceptance and before candidate sealing.
 * Validation needs the complete provider delta, but materialization only
 * needs its identity, dependencies, plugin provenance, and completeness
 * claims; replacement records and staged bindings live in the validated
 * sibling fields. Dropping the duplicated raw proposal arrays here is safe
 * because the acceptance store already persisted the immutable digest.
 */
export type MaterializationFactDelta = Pick<FactDelta, "fact_delta_id" | "delta_digest" | "plugin_id" | "plugin_version" | "proposed_dependencies" | "completeness_claims">;
/**
 * Heap-bounded representation of a validated proposed record. The canonical
 * JSON is lossless; the promoted fields are the only ones materialization
 * needs without decoding the record body. Keeping one compact string instead
 * of a nested object/array graph is material on repository-sized first scans,
 * where hundreds of thousands of records remain live until candidate seal.
 */
export interface MaterializationProposedRecord {
  readonly proposal_record_key: string;
  readonly category: string;
  readonly kind: string;
  readonly universal_kind: string;
  readonly identity_key: string;
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
  readonly canonical_record: string;
  readonly record_digest: string;
  /** Private native publication scalar row. Absent on the portable fallback. */
  readonly publication_record?: Readonly<Record<string, unknown>>;
  /** Exact UCE body bytes encoded as lowercase hex for SQLite unhex(). */
  readonly body_payload_hex?: string;
}

export interface MaterializationReplacementSet extends Omit<ValidatedReplacementSet, "records"> {
  /** Full records remain accepted for generic/test providers; production
   * providers compact them immediately after authoritative validation. */
  readonly records: readonly (ProposedRecord | MaterializationProposedRecord)[];
}

export interface MaterializationAcceptedFactDelta extends Omit<AcceptedFactDelta, "delta" | "replacement_sets"> {
  readonly delta: MaterializationFactDelta;
  readonly replacement_sets: readonly MaterializationReplacementSet[];
}

export function compactAcceptedFactDelta(value: AcceptedFactDelta): MaterializationAcceptedFactDelta {
  const { fact_delta_id, delta_digest, plugin_id, plugin_version, proposed_dependencies, completeness_claims } = value.delta;
  const replacement_sets = value.replacement_sets.map((set) => Object.freeze({
    ...set,
    records: Object.freeze(set.records.map((record) => {
      const canonicalRecord = canonicalJson(record);
      return Object.freeze({
        proposal_record_key: record.proposal_record_key,
        category: record.category,
        kind: record.kind,
        universal_kind: record.universal_kind,
        identity_key: record.identity_key,
        owner_artifact_id: set.scope.owner_artifact_id,
        owner_artifact_version_id: set.scope.owner_artifact_version_id,
        canonical_record: canonicalRecord,
        record_digest: digestBytes(canonicalBytes(record)),
      });
    })),
  }));
  return Object.freeze({
    ...value,
    replacement_sets: Object.freeze(replacement_sets),
    delta: Object.freeze({
      fact_delta_id,
      delta_digest,
      plugin_id,
      plugin_version,
      proposed_dependencies: Object.freeze([...proposed_dependencies]),
      completeness_claims: Object.freeze([...completeness_claims]),
    }),
  });
}

export interface AcceptedDeltaStore {
  get(factDeltaId: string): Promise<{ readonly delta_digest: string } | undefined>;
  insert(delta: ValidatedFactDelta): Promise<"inserted" | "already_present">;
  remove(factDeltaId: string): Promise<void>;
}

export class CandidateDeltaError extends Error {
  readonly code: string;
  readonly scope: CandidateIssueScope | Record<string, unknown>;
  readonly phase = "analysis";

  constructor(code: string, message: string, scope: CandidateIssueScope | Record<string, unknown>) {
    super(message);
    this.name = "CandidateDeltaError";
    this.code = code;
    this.scope = scope;
  }
}

const DELTA_KEYS = [
  "fact_delta_id", "candidate_generation_id", "workspace_id", "base_snapshot_id", "work_item_id", "plugin_id", "plugin_version",
  "analysis_digest", "analysis_configuration_digest", "publication_stage_id", "owner_artifact_id", "owner_artifact_version_id", "replacement_scopes",
  "input_artifact_version_ids", "input_record_ids", "plugin_input_access_manifest_id", "plugin_input_access_manifest_digest",
  "analysis_input_digest", "proposed_records", "proposed_dependencies", "completeness_claims", "created_at", "delta_digest",
] as const;
const REQUIRED_DELTA_KEYS = DELTA_KEYS.filter((key) => key !== "base_snapshot_id" && key !== "publication_stage_id");

function scopeFor(input: FactDeltaValidationInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const factDeltaId = readString(input.raw_delta, "fact_delta_id") ?? "";
  if (typeof extra["replacement_scope_id"] === "string") return { ...extra, scope_type: "replacement_scope", fact_delta_id: factDeltaId, replacement_scope_id: extra["replacement_scope_id"] };
  if (typeof extra["proposal_record_key"] === "string") return { ...extra, scope_type: "proposal", fact_delta_id: factDeltaId, proposal_record_key: extra["proposal_record_key"] };
  return { ...extra, scope_type: "fact_delta", fact_delta_id: factDeltaId };
}

function fail(input: FactDeltaValidationInput, code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new CandidateDeltaError(code, message, scopeFor(input, extra));
}

function readString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" ? entry : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], requiredKeys: readonly string[] = keys): { readonly unknown?: string; readonly missing?: string } {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown !== undefined) return { unknown };
  const missing = requiredKeys.find((key) => !(key in value));
  return missing === undefined ? {} : { missing };
}

function orderedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseLogicalJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("UCE must be a non-empty canonical JSON string.");
  const parsed = JSON.parse(value) as unknown;
  if (canonicalJson(parsed) !== value) throw new TypeError("UCE JSON is not canonical.");
  return parsed;
}

function matchesPayloadSchema(value: unknown, schema: ClosedPayloadSchema): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !(key in schema.properties))) return false;
  if (schema.required.some((key) => !(key in object))) return false;
  const matches = (candidate: unknown, property: { readonly type: string; readonly items?: unknown; readonly properties?: Readonly<Record<string, { readonly type: string }>>; readonly required?: readonly string[]; readonly enum?: readonly string[]; readonly minimum?: number; readonly maximum?: number }): boolean => {
    if (property.enum !== undefined && (typeof candidate !== "string" || !property.enum.includes(candidate))) return false;
    if (property.type === "string") return typeof candidate === "string";
    if (property.type === "integer") return typeof candidate === "number" && Number.isSafeInteger(candidate) && (property.minimum === undefined || candidate >= property.minimum) && (property.maximum === undefined || candidate <= property.maximum);
    if (property.type === "boolean") return typeof candidate === "boolean";
    if (property.type === "array") return Array.isArray(candidate) && (property.items === undefined || candidate.every((entry) => matches(entry, property.items as { readonly type: string })));
    if (property.type === "object") {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const nested = candidate as Record<string, unknown>;
      if (property.properties !== undefined && Object.keys(nested).some((key) => !(key in property.properties!))) return false;
      if (property.required?.some((key) => !(key in nested))) return false;
      return property.properties === undefined || Object.entries(property.properties).every(([key, child]) => !(key in nested) || matches(nested[key], child));
    }
    return false;
  };
  return Object.entries(schema.properties).every(([key, property]) => !(key in object) || matches(object[key], property));
}

function sameScope(left: ReplacementScope, right: ReplacementScope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function digestPayload(delta: FactDelta): Record<string, unknown> {
  const { fact_delta_id: _factDeltaId, created_at: _createdAt, delta_digest: _deltaDigest, ...payload } = delta;
  return payload;
}

function parseManifest(manifest: AutomaticPluginInputAccessManifest): PluginInputAccessManifest {
  return manifest as unknown as PluginInputAccessManifest;
}

function baseRecordIds(manifest: AutomaticPluginInputAccessManifest): string[] {
  return orderedUnique(manifest.record_entries.filter((entry) => isObject(entry) && entry["input_type"] === "base_record" && typeof entry["record_id"] === "string").map((entry) => (entry as unknown as Record<string, unknown>)["record_id"] as string));
}

function validateManifest(input: FactDeltaValidationInput, delta: FactDelta): void {
  const manifest = parseManifest(input.accepted_manifest);
  const manifestInput = {
    request_id: manifest.request_id,
    analysis_view_digest: manifest.analysis_view_digest,
    artifact_version_entries: manifest.artifact_version_entries,
    record_entries: manifest.record_entries,
    lookup_entries: manifest.lookup_entries,
    transitive_artifact_version_ids: manifest.transitive_artifact_version_ids,
  };
  if (manifest.plugin_input_access_manifest_id !== pluginInputAccessManifestId(manifest.request_id, manifest.analysis_view_digest)) {
    fail(input, "core:analysis_context_unavailable", "The accepted access manifest identity does not match its request and view.");
  }
  if (!isFinalizedPluginInputAccessManifest(input.accepted_manifest) && manifest.manifest_digest !== pluginInputAccessManifestDigest(manifestInput as never)) {
    fail(input, "core:candidate_digest_mismatch", "The accepted access manifest digest is invalid.");
  }
  if (delta.plugin_input_access_manifest_id !== manifest.plugin_input_access_manifest_id || delta.plugin_input_access_manifest_digest !== manifest.manifest_digest) {
    fail(input, "core:analysis_context_unavailable", "FactDelta does not bind the accepted access manifest.");
  }
}

function validateIdentity(input: FactDeltaValidationInput, delta: FactDelta): void {
  const work = input.work_item;
  const candidate = input.candidate;
  const pairs: readonly [string, string | undefined, string | undefined][] = [
    ["candidate_generation_id", delta.candidate_generation_id, candidate.candidate_generation_id],
    ["workspace_id", delta.workspace_id, candidate.workspace_id],
    ["work_item_id", delta.work_item_id, work.work_item_id],
    ["plugin_id", delta.plugin_id, work.plugin_id],
    ["plugin_version", delta.plugin_version, work.plugin_version],
    ["owner_artifact_id", delta.owner_artifact_id, work.artifact_id],
    ["owner_artifact_version_id", delta.owner_artifact_version_id, work.target_artifact_version_id],
    ["analysis_input_digest", delta.analysis_input_digest, undefined],
  ];
  for (const [field, actual, expected] of pairs) {
    if (!hasString(actual) || (expected !== undefined && actual !== expected)) fail(input, "core:delta_scope_mismatch", `FactDelta ${field} does not match the frozen work scope.`, { field });
  }
  if (candidate.base_snapshot_id !== undefined && delta.base_snapshot_id !== candidate.base_snapshot_id) fail(input, "core:delta_base_mismatch", "FactDelta base snapshot does not match the candidate.", { field: "base_snapshot_id" });
  if (input.analysis_context_digest !== work.analysis_context_digest) fail(input, "core:analysis_context_unavailable", "The analysis context binding is stale.");
  if (input.target_registry.registry_snapshot_id !== candidate.target_registry_snapshot_id) fail(input, "core:delta_scope_mismatch", "The target registry is not the candidate registry.");
  if (!input.target_registry.identifiers.has(work.plugin_id) || work.capabilities.some((capability) => !input.target_registry.identifiers.has(capability))) {
    fail(input, "core:registry_definition_unavailable", "The work item refers to an unregistered plugin or capability.");
  }
}

function validateScopes(input: FactDeltaValidationInput, delta: FactDelta): ValidatedReplacementSet[] {
  const expected = input.expected_replacement_scopes;
  const actual = delta.replacement_scopes;
  const expectedIds = expected.map((entry) => entry.replacement_scope_id);
  const actualIds = actual.map((entry) => entry.replacement_scope_id);
  if (new Set(actualIds).size !== actualIds.length || new Set(expectedIds).size !== expectedIds.length) fail(input, "core:delta_scope_mismatch", "Replacement scope identities must be unique.");
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  if (missing.length > 0) fail(input, "core:required_delta_missing", "FactDelta omitted an expected replacement scope.", { replacement_scope_ids: missing });
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  if (extra.length > 0 || actual.length !== expected.length) fail(input, "core:delta_scope_mismatch", "FactDelta replacement scopes are not complete.", { replacement_scope_ids: extra });
  for (const wanted of expected) {
    const found = actual.find((entry) => entry.replacement_scope_id === wanted.replacement_scope_id);
    if (found === undefined || !sameScope(found, wanted)) fail(input, "core:delta_scope_mismatch", "FactDelta replacement scope differs from the planned scope.", { replacement_scope_id: wanted.replacement_scope_id });
  }
  // Every ReplacementScope in one FactDelta shares the delta's single owner
  // artifact version (`validateIdentity` already pins `delta.owner_artifact_id`/
  // `owner_artifact_version_id` to the frozen work item, and scopes are
  // planned per work item -- see `candidate-planning.ts`'s `expectedScopes`).
  // ProposedRecord no longer carries its own owner copy (content-derived
  // record identity, decision 05), so a record's scope is disambiguated by
  // category/kind coverage alone; scope owner is a known artifact version by
  // construction (`expected` comes from the frozen, already-validated
  // `expected_replacement_scopes`, never from the delta itself).
  for (const record of delta.proposed_records) {
    const inScope = expected.some((wanted) => wanted.record_categories.includes(record.category) && wanted.record_kinds.includes(record.kind));
    if (!inScope) fail(input, "core:delta_scope_mismatch", "A proposed record is outside every authoritative replacement scope.", { proposal_record_key: record.proposal_record_key });
  }
  return expected.map((wanted) => {
    const records = delta.proposed_records.filter((record) => wanted.record_categories.includes(record.category) && wanted.record_kinds.includes(record.kind));
    const recordKeys = records.map((record) => record.proposal_record_key);
    if (new Set(recordKeys).size !== recordKeys.length) fail(input, "core:record_schema_invalid", "Proposal record keys must be unique.");
    return Object.freeze({ scope: wanted, records: Object.freeze(records), record_set_digest: canonicalSha256(records) });
  });
}

function baseSetDigest(records: readonly BaseCandidateRecord[]): string {
  return canonicalSha256(records.map((record) => ({ record_id: record.record_id, record_digest: record.record_digest })).sort((left, right) => Buffer.compare(Buffer.from(left.record_id), Buffer.from(right.record_id))));
}

function manifestStagedEntries(manifest: AutomaticPluginInputAccessManifest): readonly ValidatedStagedRecord[] {
  return manifest.record_entries.filter((entry) => isObject(entry) && entry["input_type"] === "staged_record").map((entry) => {
    const raw = entry as unknown as Record<string, unknown>;
    return {
    staged_record_id: typeof raw["staged_record_id"] === "string" ? raw["staged_record_id"] : "",
    producing_work_item_id: typeof raw["producing_work_item_id"] === "string" ? raw["producing_work_item_id"] : "",
    proposal_record_key: typeof raw["proposal_record_key"] === "string" ? raw["proposal_record_key"] : "",
    validated_record_digest: typeof raw["validated_record_digest"] === "string" ? raw["validated_record_digest"] : "",
    transitive_artifact_version_ids: [],
    };
  });
}

function validateRecords(input: FactDeltaValidationInput, delta: FactDelta): void {
  const baseRecords = new Map(input.base_records.map((record) => [record.record_id, record]));
  const manifestBaseRecords = new Map(input.accepted_manifest.record_entries.filter((entry) => isObject(entry) && entry["input_type"] === "base_record" && typeof entry["record_id"] === "string").map((entry) => {
    const raw = entry as unknown as Record<string, unknown>;
    return [raw["record_id"] as string, raw["record_digest"] as string] as const;
  }));
  const manifestIds = baseRecordIds(input.accepted_manifest);
  if (canonicalJson(delta.input_record_ids) !== canonicalJson(manifestIds)) fail(input, "core:delta_scope_mismatch", "FactDelta direct record inputs do not match the accepted manifest.");
  validateBaseRecordInputs(input, delta.input_record_ids, baseRecords, manifestBaseRecords);
  const stagedManifestEntries = manifestStagedEntries(input.accepted_manifest);
  const stagedById = new Map(input.staged_records.map((entry) => [entry.staged_record_id, entry]));
  const stagedManifestIds = new Set(stagedManifestEntries.map((entry) => entry.staged_record_id));
  validateStagedManifestEntries(input, stagedManifestEntries, stagedById);
  const extraStaged = input.staged_records.filter((entry) => !stagedManifestIds.has(entry.staged_record_id));
  if (extraStaged.length > 0) fail(input, "core:undeclared_input", "FactDelta carries staged producer entries absent from the accepted manifest.", { input_type: "staged_record", undeclared_ids: extraStaged.map((entry) => entry.staged_record_id) });
  for (const record of delta.proposed_records) validateProposedRecord(input, record);
}

function validateBaseRecordInputs(input: FactDeltaValidationInput, recordIds: readonly string[], baseRecords: ReadonlyMap<string, BaseCandidateRecord>, manifestBaseRecords: ReadonlyMap<string, string>): void {
  for (const recordId of recordIds) {
    const baseRecord = baseRecords.get(recordId);
    if (baseRecord === undefined) fail(input, "core:reference_validation_failed", "FactDelta refers to an unknown base record.", { record_id: recordId, reference_failure_kind: "dangling_base_record" });
    if (manifestBaseRecords.get(recordId) !== baseRecord.record_digest) fail(input, "core:reference_validation_failed", "FactDelta base record digest does not match the accepted manifest.", { record_id: recordId, reference_failure_kind: "base_record_digest_mismatch" });
    if (input.target_registry.closed_record_ids?.has(recordId) || baseRecord.valid_to_generation !== undefined) fail(input, "core:reference_validation_failed", "FactDelta refers to a closing base record.", { record_id: recordId, reference_failure_kind: "closing_base_record" });
  }
}

function validateStagedManifestEntries(input: FactDeltaValidationInput, entries: readonly ValidatedStagedRecord[], stagedById: ReadonlyMap<string, ValidatedStagedRecord>): void {
  for (const stagedEntry of entries) {
    const validated = stagedById.get(stagedEntry.staged_record_id);
    if (validated === undefined || validated.producing_work_item_id !== stagedEntry.producing_work_item_id || validated.proposal_record_key !== stagedEntry.proposal_record_key || validated.validated_record_digest !== stagedEntry.validated_record_digest || !hasString(validated.validated_record_digest)) {
      fail(input, "core:undeclared_input", "FactDelta contains a staged input that was not validated by its producer.", { input_type: "staged_record", undeclared_ids: [stagedEntry.staged_record_id] });
    }
    if (validated.transitive_artifact_version_ids.some((versionId) => !input.accepted_manifest.transitive_artifact_version_ids.includes(versionId) && !input.accepted_manifest.artifact_version_entries.some((entry) => isObject(entry) && entry["artifact_version_id"] === versionId))) fail(input, "core:undeclared_input", "Validated staged input contains an artifact outside the accepted closure.", { input_type: "staged_record", undeclared_ids: [stagedEntry.staged_record_id] });
  }
}

function validateProposedRecord(input: FactDeltaValidationInput, record: ProposedRecord): void {
  const definition = input.target_registry.record_kinds.get(record.kind);
  if (definition === undefined) {
    fail(input, "core:unregistered_identifier", "A proposed record kind is not registered in the target schema.", { proposal_record_key: record.proposal_record_key, identifier: record.kind });
  }
  if (definition.category !== record.category || definition.universal_kind !== record.universal_kind || definition.schema_version !== record.schema_version) {
    fail(input, "core:record_schema_invalid", "A proposed record is not valid for its registered target schema.", { proposal_record_key: record.proposal_record_key });
  }
  validateProposedRecordPayload(input, record, definition);
}

function validateProposedRecordPayload(input: FactDeltaValidationInput, record: ProposedRecord, definition: RegisteredRecordKind): void {
  try {
    const attestedFacets = factDeltaStreamAttestedFacets(record);
    const facets = attestedFacets ?? parseLogicalJson(record.facets);
    if (!Array.isArray(facets) || facets.some((facet) => typeof facet !== "string") || new Set(facets).size !== facets.length || facets.some((facet) => !definition.allowed_facets.includes(facet)) || (definition.required_facets ?? []).some((facet) => !facets.includes(facet))) throw new TypeError("facet set is not registered");
    if (definition.body_schema !== undefined && !matchesPayloadSchema(record.body, definition.body_schema)) throw new TypeError("body does not match registered schema");
    if (attestedFacets === undefined) {
      canonicalJson(record.body);
      if (record.source_span.length > 0) parseLogicalJson(record.source_span);
      parseLogicalJson(record.evidence_references);
    }
  } catch {
    fail(input, "core:record_schema_invalid", "A proposed record contains invalid registered facets, body schema, or UCE fields.", { proposal_record_key: record.proposal_record_key });
  }
  // ProposedRecord no longer declares its own workspace/owner (decision 05);
  // the work-item owner scope is already enforced by `validateScopes`'s
  // category/kind membership test against `expected_replacement_scopes`,
  // which are themselves pinned to `input.work_item` before this validator runs.
}

type DependencyValidationContext = {
  readonly declaredByVersion: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly declaredVersions: ReadonlySet<string>;
  readonly inputRecordIds: ReadonlySet<string>;
  readonly stagedRecordIds: ReadonlySet<string>;
};

function dependencyValidationContext(input: FactDeltaValidationInput, inputRecordIds: readonly string[]): DependencyValidationContext {
  const declaredEntries = input.accepted_manifest.artifact_version_entries.filter((entry) => isObject(entry) && typeof entry["artifact_version_id"] === "string");
  const declaredVersions = new Set<string>([
    ...declaredEntries.map((entry) => (entry as unknown as Record<string, unknown>)["artifact_version_id"] as string),
    ...input.accepted_manifest.transitive_artifact_version_ids,
  ]);
  return {
    declaredByVersion: new Map(declaredEntries.map((entry) => {
      const record = entry as unknown as Readonly<Record<string, unknown>>;
      return [record["artifact_version_id"] as string, record] as const;
    })),
    declaredVersions,
    inputRecordIds: new Set(inputRecordIds),
    stagedRecordIds: new Set(input.staged_records.map((entry) => entry.staged_record_id)),
  };
}

function validateProposedDependency(input: FactDeltaValidationInput, dependency: ProposedRecordDependency, keys: ReadonlySet<string>, dependencyIds: Set<string>, context: DependencyValidationContext): void {
  if (dependencyIds.has(dependency.proposed_dependency_id) || !keys.has(dependency.proposal_record_key)) fail(input, "core:dependency_validation_failed", "A proposed dependency is not locally resolvable.");
  dependencyIds.add(dependency.proposed_dependency_id);
  if (!input.target_registry.dependency_roles.has(dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "A proposed dependency role is not registered.", { dependency_role: dependency.dependency_role });
  if (!context.declaredVersions.has(dependency.dependency_artifact_version_id)) fail(input, "core:dependency_validation_failed", "A proposed dependency version is outside the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
  const registered = input.target_registry.artifact_versions?.get(dependency.dependency_artifact_version_id);
  if (registered?.closed === true || input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id)?.closed === true) fail(input, "core:dependency_validation_failed", "A proposed dependency refers to a closing artifact version.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
  if (registered !== undefined && registered.artifact_id !== dependency.dependency_artifact_id) fail(input, "core:dependency_validation_failed", "A proposed dependency artifact/version identity is inconsistent.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
  validateDependencySourceReference(input, dependency.source_reference, dependency.dependency_basis, keys, context);
  const closure = input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id);
  const declared = context.declaredByVersion.get(dependency.dependency_artifact_version_id);
  const expectedDigest = closure?.digest ?? registered?.content_hash ?? (typeof declared?.["content_hash"] === "string" ? declared["content_hash"] as string : undefined);
  if (expectedDigest !== undefined && dependencyDigestFromReference(dependency.source_reference) !== expectedDigest) fail(input, "core:dependency_validation_failed", "Dependency content digest does not match the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "digest_mismatch" });
  if (closure !== undefined && (closure.dependency_artifact_id !== dependency.dependency_artifact_id || closure.dependency_role !== dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "Dependency role or artifact identity does not match the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_mismatch" });
}

function dependencyDigestFromReference(reference: unknown): string | undefined {
  if (!isObject(reference)) return undefined;
  for (const key of ["dependency_digest", "content_hash", "digest"]) if (typeof reference[key] === "string") return reference[key] as string;
  return undefined;
}

function validateDependencySourceReference(input: FactDeltaValidationInput, reference: unknown, dependencyBasis: string, keys: ReadonlySet<string>, context: DependencyValidationContext): void {
  const parsed = parseDependencySourceReference(input, reference);
  validateDependencySourceMembership(input, parsed, dependencyBasis, keys, context);
}

interface ParsedDependencySourceReference {
  readonly raw: Record<string, unknown>;
  readonly referenceType: string;
  readonly proposalKey?: string;
  readonly recordId?: string;
  readonly stagedId?: string;
}

function parseDependencySourceReference(input: FactDeltaValidationInput, reference: unknown): ParsedDependencySourceReference {
  if (!isObject(reference) || Object.keys(reference).length === 0) fail(input, "core:dependency_validation_failed", "Dependency source reference must be a non-empty structured value.", { dependency_failure_kind: "empty_source_reference" });
  const referenceType = typeof reference["reference_type"] === "string" ? reference["reference_type"] : typeof reference["type"] === "string" ? reference["type"] : undefined;
  const proposalKey = typeof reference["proposal_record_key"] === "string" ? reference["proposal_record_key"] : undefined;
  const recordId = typeof reference["record_id"] === "string" ? reference["record_id"] : undefined;
  const stagedId = typeof reference["staged_record_id"] === "string" ? reference["staged_record_id"] : undefined;
  if (referenceType === undefined) fail(input, "core:dependency_validation_failed", "Dependency source reference is missing its reference type.", { dependency_failure_kind: "source_reference_type_missing" });
  if (!["base_record", "staged_record", "local_proposal", "proposal"].includes(referenceType)) fail(input, "core:dependency_validation_failed", "Dependency source reference has an unknown reference type.", { dependency_failure_kind: "source_reference_type_unknown", source_reference: reference });
  if (referenceType === "base_record" && recordId === undefined) fail(input, "core:dependency_validation_failed", "Base dependency source reference is missing its record identity.", { dependency_failure_kind: "source_reference_id_missing" });
  if (referenceType === "staged_record" && stagedId === undefined) fail(input, "core:dependency_validation_failed", "Staged dependency source reference is missing its staged identity.", { dependency_failure_kind: "source_reference_id_missing" });
  if ((referenceType === "local_proposal" || referenceType === "proposal") && proposalKey === undefined) fail(input, "core:dependency_validation_failed", "Proposal dependency source reference is missing its proposal identity.", { dependency_failure_kind: "source_reference_id_missing" });
  return { raw: reference, referenceType, ...(proposalKey === undefined ? {} : { proposalKey }), ...(recordId === undefined ? {} : { recordId }), ...(stagedId === undefined ? {} : { stagedId }) };
}

function validateDependencySourceMembership(input: FactDeltaValidationInput, reference: ParsedDependencySourceReference, dependencyBasis: string, keys: ReadonlySet<string>, context: DependencyValidationContext): void {
  if (reference.proposalKey !== undefined && !keys.has(reference.proposalKey)) fail(input, "core:undeclared_input", "Dependency source refers to an unknown local proposal.", { source_reference: reference.raw });
  if (reference.recordId !== undefined && !context.inputRecordIds.has(reference.recordId)) fail(input, "core:undeclared_input", "Dependency source refers to an undeclared base record.", { source_reference: reference.raw });
  if (reference.stagedId !== undefined && !context.stagedRecordIds.has(reference.stagedId)) fail(input, "core:undeclared_input", "Dependency source refers to an undeclared staged record.", { source_reference: reference.raw });
  if (dependencyBasis === "base" && reference.referenceType !== "base_record") fail(input, "core:dependency_validation_failed", "Base dependency source has the wrong reference type.", { source_reference: reference.raw });
}

function validateDependencies(input: FactDeltaValidationInput, delta: FactDelta): void {
  const keys = new Set(delta.proposed_records.map((record) => record.proposal_record_key));
  const dependencyIds = new Set<string>();
  const context = dependencyValidationContext(input, delta.input_record_ids);
  for (const dependency of delta.proposed_dependencies) validateProposedDependency(input, dependency, keys, dependencyIds, context);
  for (const dependency of input.base_record_dependencies) validateBaseDependency(input, dependency, keys, delta.input_record_ids, context);
}

function validateBaseDependency(input: FactDeltaValidationInput, dependency: RecordArtifactDependency, keys: ReadonlySet<string>, inputRecordIds: readonly string[], context: DependencyValidationContext): void {
  if (!keys.has(dependency.record_id) && !inputRecordIds.includes(dependency.record_id)) fail(input, "core:undeclared_input", "A base dependency is not declared by the accepted manifest.", { input_type: "base_record", undeclared_ids: [dependency.record_id] });
  if (!input.target_registry.dependency_roles.has(dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "A base dependency role is not registered.", { dependency_role: dependency.dependency_role });
  if (dependency.valid_to_generation !== undefined || input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id)?.closed === true) fail(input, "core:dependency_validation_failed", "A base dependency is closing.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closing_dependency" });
  if (!context.declaredVersions.has(dependency.dependency_artifact_version_id)) fail(input, "core:dependency_validation_failed", "A base dependency version is outside the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "undeclared_version" });
  const registered = input.target_registry.artifact_versions?.get(dependency.dependency_artifact_version_id);
  if (registered !== undefined && (registered.artifact_id !== dependency.dependency_artifact_id || registered.closed === true)) fail(input, "core:dependency_validation_failed", "A base dependency artifact/version is not live.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "artifact_version_mismatch" });
  const closure = input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id);
  if (input.target_registry.dependency_closure !== undefined && closure === undefined) fail(input, "core:dependency_validation_failed", "A base dependency is absent from the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_missing" });
  const dependencyValue = dependency as unknown as Record<string, unknown>;
  const declaredDigest = typeof dependencyValue["dependency_digest"] === "string" ? dependencyValue["dependency_digest"] : typeof dependencyValue["content_hash"] === "string" ? dependencyValue["content_hash"] : undefined;
  if (closure !== undefined && (closure.dependency_artifact_id !== dependency.dependency_artifact_id || closure.dependency_role !== dependency.dependency_role || (registered !== undefined && closure.digest !== registered.content_hash) || (declaredDigest !== undefined && closure.digest !== declaredDigest))) fail(input, "core:dependency_validation_failed", "A base dependency closure identity or content is inconsistent.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_mismatch" });
}

function validateCompleteness(input: FactDeltaValidationInput, delta: FactDelta): void {
  const expected = new Set(input.expected_replacement_scopes.map((scope) => scope.replacement_scope_id));
  const claimed = delta.completeness_claims.flatMap((claim) => Array.isArray(claim.replacement_scope_ids) ? claim.replacement_scope_ids : [claim.replacement_scope_ids]);
  if (new Set(claimed).size !== claimed.length || claimed.some((id) => !expected.has(id)) || claimed.length !== expected.size) {
    fail(input, "core:replacement_scope_incomplete", "Completeness claims do not cover the planned replacement scope exactly once.");
  }
  const diagnosticRecords = new Map(delta.proposed_records.filter((record) => record.category === "diagnostic").map((record) => [record.proposal_record_key, record]));
  const stringList = (value: unknown): readonly string[] => {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
    if (value === "") return [];
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
    } catch { return []; }
  };
  const statuses = new Set(["complete", "partial", "unknown", "unsupported", "stale"]);
  for (const claim of delta.completeness_claims) {
    validateCompletenessClaim(input, claim, statuses, diagnosticRecords, stringList);
  }
}

function validateCompletenessClaim(
  input: FactDeltaValidationInput,
  claim: FactDelta["completeness_claims"][number],
  statuses: ReadonlySet<string>,
  diagnosticRecords: ReadonlyMap<string, ProposedRecord>,
  stringList: (value: unknown) => readonly string[],
): void {
  const scopeId = Array.isArray(claim.replacement_scope_ids) ? claim.replacement_scope_ids[0] : claim.replacement_scope_ids;
  const scope = input.expected_replacement_scopes.find((entry) => entry.replacement_scope_id === scopeId);
  const reasonCodes = stringList(claim.reason_codes);
  const diagnosticKeys = stringList(claim.diagnostic_proposal_keys);
  const affectedArtifactIds = stringList(claim.affected_artifact_ids);
  if (scope === undefined || claim.capability !== scope.capability || !statuses.has(claim.status)) fail(input, "core:replacement_scope_incomplete", "A completeness claim is invalid for its replacement scope.");
  if (new Set(reasonCodes).size !== reasonCodes.length || reasonCodes.some((code) => !input.target_registry.identifiers.has(code))) fail(input, "core:unregistered_identifier", "A completeness claim uses an unregistered reason code.");
  if (new Set(diagnosticKeys).size !== diagnosticKeys.length || diagnosticKeys.some((key) => !diagnosticRecords.has(key))) fail(input, "core:reference_validation_failed", "A completeness claim refers to an unknown diagnostic proposal.");
  if (new Set(affectedArtifactIds).size !== affectedArtifactIds.length || affectedArtifactIds.some((id) => id !== input.work_item.artifact_id)) fail(input, "core:delta_scope_mismatch", "A completeness claim affects an artifact outside the work item.");
  if (!completenessEvidenceMatchesStatus(claim.status, reasonCodes, diagnosticKeys)) fail(input, "core:replacement_scope_incomplete", "Completeness evidence does not match the reported status.");
}

function completenessEvidenceMatchesStatus(status: string, reasonCodes: readonly string[], diagnosticKeys: readonly string[]): boolean {
  const hasEvidence = reasonCodes.length > 0 || diagnosticKeys.length > 0;
  return status === "complete" ? !hasEvidence : hasEvidence;
}

function validatedDelta(input: FactDeltaValidationInput): ValidatedFactDelta {
  if (!isObject(input.raw_delta)) fail(input, "core:record_schema_invalid", "FactDelta must be an object.");
  const keyResult = exactKeys(input.raw_delta, DELTA_KEYS, REQUIRED_DELTA_KEYS);
  if (keyResult.unknown !== undefined) fail(input, "core:unknown_field", `FactDelta has an invalid field: ${keyResult.unknown}.`, { field: keyResult.unknown });
  if (keyResult.missing !== undefined) fail(input, "core:record_schema_invalid", `FactDelta is missing required field: ${keyResult.missing}.`, { field: keyResult.missing });
  const delta = input.raw_delta as unknown as FactDelta;
  if (!hasString(delta.fact_delta_id) || !hasString(delta.delta_digest) || !hasString(delta.created_at)) fail(input, "core:record_schema_invalid", "FactDelta identities and digest are required.");
  const expectedDigest = canonicalSha256(digestPayload(delta));
  if (delta.delta_digest !== expectedDigest) fail(input, "core:candidate_digest_mismatch", "FactDelta digest does not match its canonical payload.");
  validateIdentity(input, delta);
  validateManifest(input, delta);
  const directArtifactIds = orderedUnique(input.accepted_manifest.artifact_version_entries.filter((entry) => isObject(entry) && typeof entry["artifact_version_id"] === "string").map((entry) => entry["artifact_version_id"] as string));
  if (canonicalJson(delta.input_artifact_version_ids) !== canonicalJson(directArtifactIds)) fail(input, "core:delta_scope_mismatch", "FactDelta direct artifact inputs do not match the accepted manifest.");
  const transitive = orderedUnique([...directArtifactIds, ...input.accepted_manifest.transitive_artifact_version_ids.filter((entry): entry is string => typeof entry === "string")]);
  const replacementSets = validateScopes(input, delta);
  for (const replacementSet of replacementSets) {
    const records = input.base_records.filter((record) => record.owner_artifact_id === replacementSet.scope.owner_artifact_id && record.owner_artifact_version_id === replacementSet.scope.owner_artifact_version_id && replacementSet.scope.record_categories.includes(record.category) && replacementSet.scope.record_kinds.includes(record.kind));
    const actualBaseDigest = baseSetDigest(records);
    if (actualBaseDigest !== replacementSet.scope.base_record_set_digest) fail(input, "core:delta_base_mismatch", "Replacement scope base record-set digest does not match the frozen base records.", { replacement_scope_id: replacementSet.scope.replacement_scope_id });
  }
  validateRecords(input, delta);
  validateDependencies(input, delta);
  validateCompleteness(input, delta);
  const staged = Object.freeze([...input.staged_records].map((entry) => Object.freeze({ ...entry, transitive_artifact_version_ids: Object.freeze([...entry.transitive_artifact_version_ids]) })));
  return Object.freeze({ delta: Object.freeze({ ...delta, replacement_scopes: Object.freeze([...delta.replacement_scopes]), proposed_records: Object.freeze([...delta.proposed_records]), proposed_dependencies: Object.freeze([...delta.proposed_dependencies]), completeness_claims: Object.freeze([...delta.completeness_claims]) }), replacement_sets: Object.freeze(replacementSets), input_artifact_version_ids: Object.freeze(directArtifactIds), input_record_ids: Object.freeze([...delta.input_record_ids]), transitive_artifact_version_ids: Object.freeze(transitive), validated_staged_records: staged });
}

export function validateFactDelta(input: FactDeltaValidationInput): ValidatedFactDelta {
  return validatedDelta(input);
}

class MemoryAcceptedDeltaStore implements AcceptedDeltaStore {
  readonly #values = new Map<string, string>();
  async get(factDeltaId: string): Promise<{ readonly delta_digest: string } | undefined> {
    const delta_digest = this.#values.get(factDeltaId);
    return delta_digest === undefined ? undefined : { delta_digest };
  }
  async insert(delta: ValidatedFactDelta): Promise<"inserted" | "already_present"> {
    if (this.#values.has(delta.delta.fact_delta_id)) return "already_present";
    this.#values.set(delta.delta.fact_delta_id, delta.delta.delta_digest);
    return "inserted";
  }
  async remove(factDeltaId: string): Promise<void> {
    this.#values.delete(factDeltaId);
  }
}

export class FactDeltaAcceptanceService {
  readonly #store: AcceptedDeltaStore;

  constructor(store: AcceptedDeltaStore = new MemoryAcceptedDeltaStore()) {
    this.#store = store;
  }

  async accept(input: FactDeltaValidationInput): Promise<AcceptedFactDelta> {
    const factDeltaId = readString(input.raw_delta, "fact_delta_id");
    const deltaDigest = readString(input.raw_delta, "delta_digest");
    if (factDeltaId !== undefined) {
      const existing = await this.#store.get(factDeltaId);
      if (existing !== undefined && existing.delta_digest !== deltaDigest) fail(input, "core:delta_id_conflict", "An immutable FactDelta identity was reused with another digest.");
    }
    const validated = validateFactDelta(input);
    const status = await this.#store.insert(validated);
    if (status === "already_present") {
      const existing = await this.#store.get(validated.delta.fact_delta_id);
      if (existing !== undefined && existing.delta_digest !== validated.delta.delta_digest) fail(input, "core:delta_id_conflict", "An immutable FactDelta identity was reused with another digest.");
    }
    return Object.freeze({ ...validated, acceptance: status });
  }

  async discard(factDeltaId: string): Promise<void> {
    await this.#store.remove(factDeltaId);
  }
}

export interface FactDeltaStreamStagingPort {
  stageFactDeltaStreamBatch(header: FactDeltaStreamHeader, batch: FactDeltaStreamBatch, nativeBatch: FactDeltaBatch): Promise<"inserted" | "already_accepted">;
  completeFactDeltaStream(header: FactDeltaStreamHeader): Promise<"inserted" | "already_accepted">;
  /**
   * Commits several completely validated logical streams in one durable
   * storage transaction. The physical group is only an amortisation boundary:
   * every entry keeps its own header, sequence receipts and immutable delta
   * identity.
   */
  commitFactDeltaStreamGroup?(entries: readonly StagedFactDeltaStreamGroupEntry[]): Promise<readonly ("inserted" | "already_accepted")[]>;
  cancelFactDeltaStream?(header: FactDeltaStreamHeader): Promise<void>;
}

export interface StagedFactDeltaStreamGroupEntry {
  readonly header: FactDeltaStreamHeader;
  readonly batches: readonly {
    readonly batch: FactDeltaStreamBatch;
    readonly native_batch: FactDeltaBatch;
  }[];
}

export interface FactDeltaStreamAcceptanceOptions {
  readonly signal?: AbortSignal;
}

export interface FactDeltaStreamGroupAcceptanceOptions extends FactDeltaStreamAcceptanceOptions {
  readonly max_streams?: number;
  readonly max_rows?: number;
  readonly max_bytes?: number;
}

export interface FactDeltaStreamGroupValidationEntry {
  readonly stream: FactDeltaStream;
  readonly input: FactDeltaStreamValidationInput;
}

export type FactDeltaStreamValidationInput = Omit<FactDeltaValidationInput, "raw_delta">;

export interface AcceptedFactDeltaStream extends FactDeltaStreamValidationSummary {
  readonly header: FactDeltaStreamHeader;
  readonly acceptance: "inserted" | "already_accepted";
}

function throwIfFactDeltaStreamAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("FactDeltaStream acceptance was cancelled.");
  error.name = "AbortError";
  throw error;
}

/** Validates and durably stages exactly one bounded batch at a time. Only a
 * completely validated final stream is promoted to an accepted FactDelta. */
export class FactDeltaStreamAcceptanceService {
  readonly #staging: FactDeltaStreamStagingPort;

  constructor(staging: FactDeltaStreamStagingPort) {
    this.#staging = staging;
  }

  async accept(stream: FactDeltaStream, options: FactDeltaStreamAcceptanceOptions = {}): Promise<AcceptedFactDeltaStream> {
    const validator = new FactDeltaStreamValidator(stream.header);
    try {
      throwIfFactDeltaStreamAborted(options.signal);
      for await (const rawBatch of stream.batches) {
        throwIfFactDeltaStreamAborted(options.signal);
        const batch = validator.accept_batch(rawBatch);
        const nativeBatch = factDeltaStreamNativeBatch(batch);
        await this.#staging.stageFactDeltaStreamBatch(validator.header, batch, nativeBatch);
        throwIfFactDeltaStreamAborted(options.signal);
      }
      const summary = validator.finish();
      throwIfFactDeltaStreamAborted(options.signal);
      const acceptance = await this.#staging.completeFactDeltaStream(validator.header);
      return Object.freeze({ header: validator.header, acceptance, ...summary });
    } catch (error) {
      if (options.signal?.aborted && this.#staging.cancelFactDeltaStream !== undefined) await this.#staging.cancelFactDeltaStream(validator.header);
      throw error;
    }
  }

  /** Built-in direct-stream path. Header authority and every row are checked
   * before the final receipt is promoted; only compact materialization rows,
   * proposal identities, and dependencies survive beyond each staged batch. */
  async acceptValidated(stream: FactDeltaStream, input: FactDeltaStreamValidationInput, options: FactDeltaStreamAcceptanceOptions = {}): Promise<MaterializationAcceptedFactDelta> {
    const validator = timedSync("fact_delta_stream_header_protocol", () => new FactDeltaStreamValidator(stream.header));
    const header = validator.header;
    const preflightStartedAt = timingEnabled() ? performance.now() : 0;
    const validationInput = { ...input, raw_delta: header } satisfies FactDeltaValidationInput;
    const shell = {
      fact_delta_id: header.fact_delta_id, candidate_generation_id: header.candidate_generation_id, workspace_id: header.workspace_id,
      ...(header.base_snapshot_id === undefined ? {} : { base_snapshot_id: header.base_snapshot_id }), work_item_id: header.work_item_id,
      plugin_id: header.plugin_id, plugin_version: header.plugin_version, analysis_digest: header.analysis_digest,
      analysis_configuration_digest: header.analysis_configuration_digest, ...(header.publication_stage_id === undefined ? {} : { publication_stage_id: header.publication_stage_id }),
      owner_artifact_id: header.owner_artifact_id, owner_artifact_version_id: header.owner_artifact_version_id,
      replacement_scopes: header.replacement_scopes, input_artifact_version_ids: header.input_artifact_version_ids, input_record_ids: header.input_record_ids,
      plugin_input_access_manifest_id: header.plugin_input_access_manifest_id, plugin_input_access_manifest_digest: header.plugin_input_access_manifest_digest,
      analysis_input_digest: header.analysis_input_digest, proposed_records: [], proposed_dependencies: [], completeness_claims: header.completeness_claims,
      created_at: header.created_at, delta_digest: header.delta_digest,
    } satisfies FactDelta;
    validateIdentity(validationInput, shell);
    validateManifest(validationInput, shell);
    const directArtifactIds = orderedUnique(input.accepted_manifest.artifact_version_entries.filter((entry) => isObject(entry) && typeof entry["artifact_version_id"] === "string").map((entry) => entry["artifact_version_id"] as string));
    if (canonicalJson(header.input_artifact_version_ids) !== canonicalJson(directArtifactIds)) fail(validationInput, "core:delta_scope_mismatch", "FactDeltaStream direct artifact inputs do not match the accepted manifest.");
    const expectedScopeIds = input.expected_replacement_scopes.map((scope) => scope.replacement_scope_id);
    if (header.replacement_scopes.length !== input.expected_replacement_scopes.length || header.replacement_scopes.some((scope, index) => scope.replacement_scope_id !== expectedScopeIds[index] || !sameScope(scope, input.expected_replacement_scopes[index]!))) {
      fail(validationInput, "core:delta_scope_mismatch", "FactDeltaStream replacement scopes do not match the frozen work item.");
    }
    for (const scope of header.replacement_scopes) {
      const base = input.base_records.filter((record) => record.owner_artifact_id === scope.owner_artifact_id && record.owner_artifact_version_id === scope.owner_artifact_version_id && scope.record_categories.includes(record.category) && scope.record_kinds.includes(record.kind));
      if (baseSetDigest(base) !== scope.base_record_set_digest) fail(validationInput, "core:delta_base_mismatch", "Replacement scope base record-set digest does not match the frozen base records.", { replacement_scope_id: scope.replacement_scope_id });
    }
    validateRecords(validationInput, shell);
    validateDependencies(validationInput, shell);
    if (preflightStartedAt !== 0) recordTiming("fact_delta_stream_preflight_validation", performance.now() - preflightStartedAt);

    const proposalKeys = new Set<string>();
    const dependencyIds = new Set<string>();
    const dependencyContext = dependencyValidationContext(validationInput, header.input_record_ids);
    const diagnosticKeys = new Set<string>();
    const dependencies: ProposedRecordDependency[] = [];
    const replacement = header.replacement_scopes.map((scope) => ({ scope, records: [] as MaterializationProposedRecord[], hash: createHash("sha256"), count: 0 }));
    for (const entry of replacement) entry.hash.update("[", "utf8");
    try {
      throwIfFactDeltaStreamAborted(options.signal);
      for await (const rawBatch of stream.batches) {
        throwIfFactDeltaStreamAborted(options.signal);
        const batch = timedSync("fact_delta_stream_protocol", () => validator.accept_batch(rawBatch));
        const sealed = timedSync("fact_delta_stream_rust_acceptance", () => acceptSealedFactDeltaStreamBatch(batch, [...input.target_registry.record_kinds.values()].map((definition) => ({
          kind: definition.kind,
          category: definition.category,
          universal_kind: definition.universal_kind,
          schema_version: definition.schema_version,
          allowed_facets: definition.allowed_facets,
          required_facets: definition.required_facets ?? [],
          ...(definition.body_schema === undefined ? {} : { body_schema: definition.body_schema }),
        }))));
        timedSync("fact_delta_stream_record_validation", () => {
          const records = sealed?.records ?? batch.records;
          for (const [recordIndex, record] of records.entries()) {
            if (proposalKeys.has(record.proposal_record_key)) fail(validationInput, "core:record_schema_invalid", "FactDeltaStream proposal record keys must be unique.", { proposal_record_key: record.proposal_record_key });
            proposalKeys.add(record.proposal_record_key);
            if (sealed === undefined) validateProposedRecord(validationInput, record as ProposedRecord);
            else {
              const definition = input.target_registry.record_kinds.get(record.kind);
              if (definition === undefined) fail(validationInput, "core:unregistered_identifier", "A proposed record kind is not registered in the target schema.", { proposal_record_key: record.proposal_record_key, identifier: record.kind });
              if (sealed.record_schema_attestations[recordIndex] !== true) fail(validationInput, "core:record_schema_invalid", "A proposed record contains invalid registered facets, body schema, or UCE fields.", { proposal_record_key: record.proposal_record_key });
            }
            const matching = replacement.filter((entry) => entry.scope.record_categories.includes(record.category) && entry.scope.record_kinds.includes(record.kind));
            if (matching.length === 0) fail(validationInput, "core:delta_scope_mismatch", "A streamed proposed record is outside every replacement scope.", { proposal_record_key: record.proposal_record_key });
            const canonicalRecord = sealed?.kernel.canonical_records[recordIndex] ?? factDeltaStreamCanonicalRow(record as ProposedRecord);
            if (record.category === "diagnostic") diagnosticKeys.add(record.proposal_record_key);
            for (const entry of matching) {
              if (entry.count > 0) entry.hash.update(",", "utf8");
              entry.hash.update(canonicalRecord, "utf8");
              entry.count += 1;
              const publicationRecord = sealed?.kernel.publication_records[recordIndex] ?? factDeltaStreamPublicationRow(record as ProposedRecord);
              const bodyPayloadHex = sealed?.kernel.record_body_payload_hexes[recordIndex] ?? factDeltaStreamBodyPayloadHex(record as ProposedRecord);
              const recordDigest = sealed?.kernel.record_digests[recordIndex] ?? factDeltaStreamRecordDigest(record as ProposedRecord) ?? digestBytes(canonicalBytes(record as ProposedRecord));
              entry.records.push(Object.freeze({ proposal_record_key: record.proposal_record_key, category: record.category, kind: record.kind, universal_kind: record.universal_kind, identity_key: record.identity_key, owner_artifact_id: entry.scope.owner_artifact_id, owner_artifact_version_id: entry.scope.owner_artifact_version_id, canonical_record: canonicalRecord, record_digest: recordDigest, ...(publicationRecord === undefined ? {} : { publication_record: publicationRecord }), ...(bodyPayloadHex === undefined ? {} : { body_payload_hex: bodyPayloadHex }) }));
            }
          }
        });
        timedSync("fact_delta_stream_dependency_validation", () => {
          for (const dependency of sealed?.dependencies ?? batch.dependencies) {
            validateProposedDependency(validationInput, dependency, proposalKeys, dependencyIds, dependencyContext);
            dependencies.push(Object.freeze(dependency));
          }
        });
        const nativeBatch = timedSync("fact_delta_stream_native_batch", () => factDeltaStreamNativeBatch(batch));
        await timed("fact_delta_stream_stage", () => this.#staging.stageFactDeltaStreamBatch(header, batch, nativeBatch));
        throwIfFactDeltaStreamAborted(options.signal);
      }
      timedSync("fact_delta_stream_finish", () => validator.finish());
      const diagnosticRecords = [...diagnosticKeys].map((proposal_record_key) => ({ proposal_record_key, category: "diagnostic" }) as ProposedRecord);
      validateCompleteness(validationInput, { ...shell, proposed_records: diagnosticRecords });
      const acceptance = await timed("fact_delta_stream_complete", () => this.#staging.completeFactDeltaStream(header));
      const transitive = orderedUnique([...directArtifactIds, ...input.accepted_manifest.transitive_artifact_version_ids.filter((entry): entry is string => typeof entry === "string")]);
      const staged = Object.freeze([...input.staged_records].map((entry) => Object.freeze({ ...entry, transitive_artifact_version_ids: Object.freeze([...entry.transitive_artifact_version_ids]) })));
      return Object.freeze({
        acceptance: acceptance === "already_accepted" ? "already_present" : "inserted",
        delta: Object.freeze({ fact_delta_id: header.fact_delta_id, delta_digest: header.delta_digest, plugin_id: header.plugin_id, plugin_version: header.plugin_version, proposed_dependencies: Object.freeze(dependencies), completeness_claims: Object.freeze([...header.completeness_claims]) }),
        replacement_sets: Object.freeze(replacement.map((entry) => {
          entry.hash.update("]", "utf8");
          return Object.freeze({ scope: entry.scope, records: Object.freeze(entry.records), record_set_digest: `sha256:${entry.hash.digest("hex")}` });
        })),
        input_artifact_version_ids: Object.freeze(directArtifactIds), input_record_ids: Object.freeze([...header.input_record_ids]),
        transitive_artifact_version_ids: Object.freeze(transitive), validated_staged_records: staged,
      });
    } catch (error) {
      if (options.signal?.aborted && this.#staging.cancelFactDeltaStream !== undefined) await this.#staging.cancelFactDeltaStream(header);
      throw error;
    }
  }

  /**
   * Validates logical streams independently, then commits bounded physical
   * groups. This removes the owner-per-transaction bottleneck without making
   * a partially validated owner durable or changing the per-owner result.
   */
  async acceptValidatedGroup(
    entries: Iterable<FactDeltaStreamGroupValidationEntry> | AsyncIterable<FactDeltaStreamGroupValidationEntry>,
    options: FactDeltaStreamGroupAcceptanceOptions = {},
  ): Promise<readonly MaterializationAcceptedFactDelta[]> {
    const maxStreams = options.max_streams ?? 64;
    const maxRows = options.max_rows ?? 4096;
    const maxBytes = options.max_bytes ?? 16 * 1024 * 1024;
    for (const [field, value] of [["max_streams", maxStreams], ["max_rows", maxRows], ["max_bytes", maxBytes]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer.`);
    }

    type Buffered = {
      readonly staged: StagedFactDeltaStreamGroupEntry;
      readonly delta: MaterializationAcceptedFactDelta;
      readonly rows: number;
      readonly bytes: number;
    };
    const accepted: MaterializationAcceptedFactDelta[] = [];
    let buffered: Buffered[] = [];
    let bufferedRows = 0;
    let bufferedBytes = 0;

    const commit = async (): Promise<void> => {
      if (buffered.length === 0) return;
      throwIfFactDeltaStreamAborted(options.signal);
      const staged = buffered.map((entry) => entry.staged);
      const statuses = await timed("fact_delta_stream_group_commit", () => this.#staging.commitFactDeltaStreamGroup !== undefined
        ? this.#staging.commitFactDeltaStreamGroup(staged)
        : Promise.all(staged.map(async (entry) => {
          for (const batch of entry.batches) await this.#staging.stageFactDeltaStreamBatch(entry.header, batch.batch, batch.native_batch);
          return this.#staging.completeFactDeltaStream(entry.header);
        })));
      if (statuses.length !== buffered.length) throw new Error("FactDeltaStream group staging returned the wrong acknowledgement count.");
      for (let index = 0; index < buffered.length; index += 1) {
        const status = statuses[index];
        if (status !== "inserted" && status !== "already_accepted") throw new Error("FactDeltaStream group staging returned an invalid acknowledgement.");
        accepted.push(Object.freeze({ ...buffered[index]!.delta, acceptance: status === "already_accepted" ? "already_present" : "inserted" }));
      }
      buffered = [];
      bufferedRows = 0;
      bufferedBytes = 0;
    };

    try {
      for await (const entry of entries) {
        throwIfFactDeltaStreamAborted(options.signal);
        const stagedBatches: { batch: FactDeltaStreamBatch; native_batch: FactDeltaBatch }[] = [];
        let streamRows = 0;
        let streamBytes = 0;
        let completedHeader: FactDeltaStreamHeader | undefined;
        const bufferingPort: FactDeltaStreamStagingPort = {
          stageFactDeltaStreamBatch: async (header, batch, nativeBatch) => {
            completedHeader = header;
            stagedBatches.push({ batch, native_batch: nativeBatch });
            streamRows += nativeBatch.records.row_count + nativeBatch.graph_edges.row_count + nativeBatch.identities.row_count + nativeBatch.dependencies.row_count;
            streamBytes += nativeBatch.byte_length;
            return "inserted";
          },
          completeFactDeltaStream: async (header) => { completedHeader = header; return "inserted"; },
        };
        const delta = await new FactDeltaStreamAcceptanceService(bufferingPort).acceptValidated(entry.stream, entry.input, options);
        if (completedHeader === undefined) throw new Error("FactDeltaStream validation completed without a header.");
        if (buffered.length > 0 && (buffered.length + 1 > maxStreams || bufferedRows + streamRows > maxRows || bufferedBytes + streamBytes > maxBytes)) await commit();
        buffered.push({ staged: Object.freeze({ header: completedHeader, batches: Object.freeze(stagedBatches) }), delta, rows: streamRows, bytes: streamBytes });
        bufferedRows += streamRows;
        bufferedBytes += streamBytes;
        // A single oversized owner is legal and remains isolated in its own
        // transaction; it must never force unrelated owners over the budget.
        if (buffered.length >= maxStreams || bufferedRows >= maxRows || bufferedBytes >= maxBytes) await commit();
      }
      await commit();
      return Object.freeze(accepted);
    } catch (error) {
      if (this.#staging.cancelFactDeltaStream !== undefined) {
        await Promise.allSettled(buffered.map((entry) => this.#staging.cancelFactDeltaStream!(entry.staged.header)));
      }
      throw error;
    }
  }
}
