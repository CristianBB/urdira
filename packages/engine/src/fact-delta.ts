import { canonicalJson, canonicalSha256 } from "@urdira/plugin-sdk";
import type { ArtifactWorkItem, CandidateIssueScope, ClosedPayloadSchema, FactDelta, IndexCandidate, PluginInputAccessManifest, ProposedRecord, RecordArtifactDependency, ReplacementScope } from "@urdira/contracts";
import { pluginInputAccessManifestDigest, pluginInputAccessManifestId, type AutomaticPluginInputAccessManifest } from "@urdira/plugin-sdk";

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

function parseUce(value: unknown): unknown {
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
  if (manifest.manifest_digest !== pluginInputAccessManifestDigest(manifestInput as never)) {
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
  for (const recordId of delta.input_record_ids) {
    const baseRecord = baseRecords.get(recordId);
    if (baseRecord === undefined) fail(input, "core:reference_validation_failed", "FactDelta refers to an unknown base record.", { record_id: recordId, reference_failure_kind: "dangling_base_record" });
    if (manifestBaseRecords.get(recordId) !== baseRecord.record_digest) fail(input, "core:reference_validation_failed", "FactDelta base record digest does not match the accepted manifest.", { record_id: recordId, reference_failure_kind: "base_record_digest_mismatch" });
    if (input.target_registry.closed_record_ids?.has(recordId) || baseRecord.valid_to_generation !== undefined) fail(input, "core:reference_validation_failed", "FactDelta refers to a closing base record.", { record_id: recordId, reference_failure_kind: "closing_base_record" });
  }
  const stagedManifestEntries = manifestStagedEntries(input.accepted_manifest);
  const stagedById = new Map(input.staged_records.map((entry) => [entry.staged_record_id, entry]));
  const stagedManifestIds = new Set(stagedManifestEntries.map((entry) => entry.staged_record_id));
  for (const stagedEntry of stagedManifestEntries) {
    const validated = stagedById.get(stagedEntry.staged_record_id);
    if (validated === undefined || validated.producing_work_item_id !== stagedEntry.producing_work_item_id || validated.proposal_record_key !== stagedEntry.proposal_record_key || validated.validated_record_digest !== stagedEntry.validated_record_digest || !hasString(validated.validated_record_digest)) {
      fail(input, "core:undeclared_input", "FactDelta contains a staged input that was not validated by its producer.", { input_type: "staged_record", undeclared_ids: [stagedEntry.staged_record_id] });
    }
    if (validated.transitive_artifact_version_ids.some((versionId) => !input.accepted_manifest.transitive_artifact_version_ids.includes(versionId) && !input.accepted_manifest.artifact_version_entries.some((entry) => isObject(entry) && entry["artifact_version_id"] === versionId))) fail(input, "core:undeclared_input", "Validated staged input contains an artifact outside the accepted closure.", { input_type: "staged_record", undeclared_ids: [stagedEntry.staged_record_id] });
  }
  const extraStaged = input.staged_records.filter((entry) => !stagedManifestIds.has(entry.staged_record_id));
  if (extraStaged.length > 0) fail(input, "core:undeclared_input", "FactDelta carries staged producer entries absent from the accepted manifest.", { input_type: "staged_record", undeclared_ids: extraStaged.map((entry) => entry.staged_record_id) });
  for (const record of delta.proposed_records) {
    const definition = input.target_registry.record_kinds.get(record.kind);
    if (definition === undefined) {
      fail(input, "core:unregistered_identifier", "A proposed record kind is not registered in the target schema.", { proposal_record_key: record.proposal_record_key, identifier: record.kind });
    }
    if (definition.category !== record.category || definition.universal_kind !== record.universal_kind || definition.schema_version !== record.schema_version) {
      fail(input, "core:record_schema_invalid", "A proposed record is not valid for its registered target schema.", { proposal_record_key: record.proposal_record_key });
    }
    try {
      const facets = parseUce(record.facets);
      if (!Array.isArray(facets) || facets.some((facet) => typeof facet !== "string") || new Set(facets).size !== facets.length || facets.some((facet) => !definition.allowed_facets.includes(facet)) || (definition.required_facets ?? []).some((facet) => !facets.includes(facet))) throw new TypeError("facet set is not registered");
      if (definition.body_schema !== undefined && !matchesPayloadSchema(record.body, definition.body_schema)) throw new TypeError("body does not match registered schema");
      canonicalJson(record.body);
      if (record.source_span.length > 0) parseUce(record.source_span);
      parseUce(record.evidence_references);
    } catch {
      fail(input, "core:record_schema_invalid", "A proposed record contains invalid registered facets, body schema, or UCE fields.", { proposal_record_key: record.proposal_record_key });
    }
    // ProposedRecord no longer declares its own workspace/owner (decision 05);
    // the work-item owner scope is already enforced by `validateScopes`'s
    // category/kind membership test against `expected_replacement_scopes`,
    // which are themselves pinned to `input.work_item` before this validator runs.
  }
}

function validateDependencies(input: FactDeltaValidationInput, delta: FactDelta): void {
  const keys = new Set(delta.proposed_records.map((record) => record.proposal_record_key));
  const dependencyIds = new Set<string>();
  const declaredEntries = input.accepted_manifest.artifact_version_entries.filter((entry) => isObject(entry) && typeof entry["artifact_version_id"] === "string");
  const declaredVersions = new Set<string>([
    ...declaredEntries.map((entry) => (entry as unknown as Record<string, unknown>)["artifact_version_id"] as string),
    ...input.accepted_manifest.transitive_artifact_version_ids,
  ]);
  const digestFromReference = (reference: unknown): string | undefined => {
    if (!isObject(reference)) return undefined;
    for (const key of ["dependency_digest", "content_hash", "digest"]) if (typeof reference[key] === "string") return reference[key] as string;
    return undefined;
  };
  const validateSourceReference = (reference: unknown, dependencyBasis: string): void => {
    if (!isObject(reference) || Object.keys(reference).length === 0) fail(input, "core:dependency_validation_failed", "Dependency source reference must be a non-empty structured value.", { dependency_failure_kind: "empty_source_reference" });
    const referenceType = typeof reference["reference_type"] === "string" ? reference["reference_type"] : typeof reference["type"] === "string" ? reference["type"] : undefined;
    const proposalKey = typeof reference["proposal_record_key"] === "string" ? reference["proposal_record_key"] : undefined;
    const recordId = typeof reference["record_id"] === "string" ? reference["record_id"] : undefined;
    const stagedId = typeof reference["staged_record_id"] === "string" ? reference["staged_record_id"] : undefined;
    if (referenceType === undefined) fail(input, "core:dependency_validation_failed", "Dependency source reference is missing its reference type.", { dependency_failure_kind: "source_reference_type_missing" });
    if (referenceType !== "base_record" && referenceType !== "staged_record" && referenceType !== "local_proposal" && referenceType !== "proposal") fail(input, "core:dependency_validation_failed", "Dependency source reference has an unknown reference type.", { dependency_failure_kind: "source_reference_type_unknown", source_reference: reference });
    if (referenceType === "base_record" && recordId === undefined) fail(input, "core:dependency_validation_failed", "Base dependency source reference is missing its record identity.", { dependency_failure_kind: "source_reference_id_missing" });
    if (referenceType === "staged_record" && stagedId === undefined) fail(input, "core:dependency_validation_failed", "Staged dependency source reference is missing its staged identity.", { dependency_failure_kind: "source_reference_id_missing" });
    if ((referenceType === "local_proposal" || referenceType === "proposal") && proposalKey === undefined) fail(input, "core:dependency_validation_failed", "Proposal dependency source reference is missing its proposal identity.", { dependency_failure_kind: "source_reference_id_missing" });
    if (proposalKey !== undefined && !keys.has(proposalKey)) fail(input, "core:undeclared_input", "Dependency source refers to an unknown local proposal.", { source_reference: reference });
    if (recordId !== undefined && !delta.input_record_ids.includes(recordId)) fail(input, "core:undeclared_input", "Dependency source refers to an undeclared base record.", { source_reference: reference });
    if (stagedId !== undefined && !input.staged_records.some((entry) => entry.staged_record_id === stagedId)) fail(input, "core:undeclared_input", "Dependency source refers to an undeclared staged record.", { source_reference: reference });
    if (dependencyBasis === "base" && referenceType !== undefined && referenceType !== "base_record") fail(input, "core:dependency_validation_failed", "Base dependency source has the wrong reference type.", { source_reference: reference });
  };
  for (const dependency of delta.proposed_dependencies) {
    if (dependencyIds.has(dependency.proposed_dependency_id) || !keys.has(dependency.proposal_record_key)) fail(input, "core:dependency_validation_failed", "A proposed dependency is not locally resolvable.");
    dependencyIds.add(dependency.proposed_dependency_id);
    if (!input.target_registry.dependency_roles.has(dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "A proposed dependency role is not registered.", { dependency_role: dependency.dependency_role });
    if (!declaredVersions.has(dependency.dependency_artifact_version_id)) fail(input, "core:dependency_validation_failed", "A proposed dependency version is outside the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
    const registered = input.target_registry.artifact_versions?.get(dependency.dependency_artifact_version_id);
    if (registered?.closed === true || input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id)?.closed === true) fail(input, "core:dependency_validation_failed", "A proposed dependency refers to a closing artifact version.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
    if (registered !== undefined && registered.artifact_id !== dependency.dependency_artifact_id) fail(input, "core:dependency_validation_failed", "A proposed dependency artifact/version identity is inconsistent.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id });
    validateSourceReference(dependency.source_reference, dependency.dependency_basis);
    const closure = input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id);
    const declared = declaredEntries.find((entry) => (entry as unknown as Record<string, unknown>)["artifact_version_id"] === dependency.dependency_artifact_version_id) as unknown as Record<string, unknown> | undefined;
    const expectedDigest = closure?.digest ?? registered?.content_hash ?? (typeof declared?.["content_hash"] === "string" ? declared["content_hash"] as string : undefined);
    if (expectedDigest !== undefined && digestFromReference(dependency.source_reference) !== expectedDigest) fail(input, "core:dependency_validation_failed", "Dependency content digest does not match the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "digest_mismatch" });
    if (closure !== undefined && (closure.dependency_artifact_id !== dependency.dependency_artifact_id || closure.dependency_role !== dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "Dependency role or artifact identity does not match the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_mismatch" });
  }
  for (const dependency of input.base_record_dependencies) {
    if (!keys.has(dependency.record_id) && !delta.input_record_ids.includes(dependency.record_id)) fail(input, "core:undeclared_input", "A base dependency is not declared by the accepted manifest.", { input_type: "base_record", undeclared_ids: [dependency.record_id] });
    if (!input.target_registry.dependency_roles.has(dependency.dependency_role)) fail(input, "core:dependency_validation_failed", "A base dependency role is not registered.", { dependency_role: dependency.dependency_role });
    if (dependency.valid_to_generation !== undefined || input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id)?.closed === true) fail(input, "core:dependency_validation_failed", "A base dependency is closing.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closing_dependency" });
    if (!declaredVersions.has(dependency.dependency_artifact_version_id)) fail(input, "core:dependency_validation_failed", "A base dependency version is outside the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "undeclared_version" });
    const registered = input.target_registry.artifact_versions?.get(dependency.dependency_artifact_version_id);
    if (registered !== undefined && (registered.artifact_id !== dependency.dependency_artifact_id || registered.closed === true)) fail(input, "core:dependency_validation_failed", "A base dependency artifact/version is not live.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "artifact_version_mismatch" });
    const closure = input.target_registry.dependency_closure?.get(dependency.dependency_artifact_version_id);
    if (input.target_registry.dependency_closure !== undefined && closure === undefined) fail(input, "core:dependency_validation_failed", "A base dependency is absent from the accepted closure.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_missing" });
    const dependencyValue = dependency as unknown as Record<string, unknown>;
    const declaredDigest = typeof dependencyValue["dependency_digest"] === "string" ? dependencyValue["dependency_digest"] : typeof dependencyValue["content_hash"] === "string" ? dependencyValue["content_hash"] : undefined;
    if (closure !== undefined && (closure.dependency_artifact_id !== dependency.dependency_artifact_id || closure.dependency_role !== dependency.dependency_role || (registered !== undefined && closure.digest !== registered.content_hash) || (declaredDigest !== undefined && closure.digest !== declaredDigest))) fail(input, "core:dependency_validation_failed", "A base dependency closure identity or content is inconsistent.", { dependency_artifact_version_id: dependency.dependency_artifact_version_id, dependency_failure_kind: "closure_mismatch" });
  }
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
    const scopeId = Array.isArray(claim.replacement_scope_ids) ? claim.replacement_scope_ids[0] : claim.replacement_scope_ids;
    const scope = input.expected_replacement_scopes.find((entry) => entry.replacement_scope_id === scopeId);
    const reasonCodes = stringList(claim.reason_codes);
    const diagnosticKeys = stringList(claim.diagnostic_proposal_keys);
    const affectedArtifactIds = stringList(claim.affected_artifact_ids);
    if (scope === undefined || claim.capability !== scope.capability || !statuses.has(claim.status)) fail(input, "core:replacement_scope_incomplete", "A completeness claim is invalid for its replacement scope.");
    if (new Set(reasonCodes).size !== reasonCodes.length || reasonCodes.some((code) => !input.target_registry.identifiers.has(code))) fail(input, "core:unregistered_identifier", "A completeness claim uses an unregistered reason code.");
    if (new Set(diagnosticKeys).size !== diagnosticKeys.length || diagnosticKeys.some((key) => !diagnosticRecords.has(key))) fail(input, "core:reference_validation_failed", "A completeness claim refers to an unknown diagnostic proposal.");
    if (new Set(affectedArtifactIds).size !== affectedArtifactIds.length || affectedArtifactIds.some((id) => id !== input.work_item.artifact_id)) fail(input, "core:delta_scope_mismatch", "A completeness claim affects an artifact outside the work item.");
    if (claim.status === "complete" && (reasonCodes.length > 0 || diagnosticKeys.length > 0) || claim.status !== "complete" && reasonCodes.length === 0 && diagnosticKeys.length === 0) {
      fail(input, "core:replacement_scope_incomplete", "Completeness evidence does not match the reported status.");
    }
  }
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
