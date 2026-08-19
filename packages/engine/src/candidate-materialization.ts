import { canonicalJson, canonicalSha256 } from "@urdira/plugin-sdk";
import { canonicalBytes, compareBytes, digestBytes, digestCanonicalArray } from "@urdira/canonical";
import type { CanonicalEncodingLimits } from "@urdira/canonical";
import type { BoundPluginLookupInvalidationDependency, PluginInvalidationConsumerType, PluginInvalidationScope, PluginLookupOperation } from "@urdira/plugin-sdk";
import type {
  CandidateIdentityAssignmentTemplate,
  CandidateMaterialization,
  CandidateProjectionClosureTemplate,
  CandidateProjectionOpenTemplate,
  CandidateProjectionTemplate,
  CandidateRecordClosureTemplate,
  CandidateRecordOpenTemplate,
  CandidateSourceTransitionTemplate,
  ChangeCauseReference,
  IndexCandidate,
  OrderedSetDescriptor,
  PluginLookupInvalidationDependency,
  ProposedRecord,
  ProjectionWorkItem,
  RecordArtifactDependency,
} from "@urdira/contracts";
import type { CandidatePlan } from "./candidate-planning.js";
import type { SourceCandidatePlan } from "./source-candidate-planning.js";
import type { AcceptedFactDelta, BaseCandidateRecord } from "./fact-delta.js";
import type { BaseCandidateProjection } from "./candidate-planning.js";
import type { ProviderWatermark, SnapshotCapabilityStateEntry, CandidateWorkManifest } from "@urdira/contracts";

export interface CandidateMaterializationInput {
  readonly candidate: IndexCandidate;
  readonly manifest: CandidateWorkManifest;
  readonly source_plan: SourceCandidatePlan;
  readonly accepted_deltas: readonly AcceptedFactDelta[];
  readonly accepted_projection_sets: readonly ValidatedProjectionReplacementSet[];
  readonly base_records: readonly BaseCandidateRecord[];
  /**
   * Active records found by identity key across the whole workspace. This is
   * intentionally separate from `base_records`: normal replacement scopes
   * remain owner-narrowed, while an identity that moved to another owner must
   * still close its old occurrence deterministically.
   */
  readonly global_identity_records?: readonly BaseCandidateRecord[];
  readonly base_projections: readonly BaseCandidateProjection[];
  readonly capability_state_entries: readonly SnapshotCapabilityStateEntry[];
  readonly source_observation_watermarks: readonly ProviderWatermark[];
  readonly created_at: string;
  readonly record_dependencies?: readonly RecordArtifactDependency[];
  readonly lookup_bindings?: readonly PluginLookupInvalidationDependency[];
  readonly projection_dependencies?: readonly Readonly<Record<string, unknown>>[];
  readonly absence_barriers?: readonly CandidateAbsenceBarrier[];
  readonly known_artifact_versions: readonly CandidateKnownArtifactVersion[];
  readonly known_dependency_roles?: readonly string[];
  readonly known_lookup_dependencies: readonly CandidateLookupDependencyAuthority[];
}

export interface CandidateKnownArtifactVersion {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_digest: string;
}

export interface CandidateAbsenceBarrier {
  readonly identity_type: string;
  readonly identity_key: string;
  readonly closed_identity_id: string;
}

export interface CandidateRecordDependencyTemplate extends Omit<RecordArtifactDependency, "valid_from_generation" | "valid_to_generation"> {}

export interface CandidateLookupBindingTemplate extends Omit<BoundPluginLookupInvalidationDependency, "valid_from_generation" | "valid_to_generation"> {}

export interface CandidateLookupDependencyAuthority extends CandidateLookupBindingTemplate {}

export interface CandidateProjectionDependencyTemplate extends Readonly<Record<string, unknown>> {}

export interface ValidatedProjectionReplacementSet {
  readonly work_item: ProjectionWorkItem;
  readonly projections: readonly CandidateProjectionTemplate[];
  readonly projection_set_digest: string;
}

export interface SealedCandidateMaterialization {
  readonly materialization: CandidateMaterialization;
  readonly reused_record_ids: readonly string[];
  readonly source_transitions: readonly CandidateSourceTransitionTemplate[];
  readonly record_opens: readonly CandidateRecordOpenTemplate[];
  readonly record_closures: readonly CandidateRecordClosureTemplate[];
  readonly identity_assignments: readonly CandidateIdentityAssignmentTemplate[];
  readonly record_dependencies: readonly CandidateRecordDependencyTemplate[];
  readonly lookup_bindings: readonly CandidateLookupBindingTemplate[];
  readonly lookup_revalidations: readonly Readonly<Record<string, unknown>>[];
  readonly projection_dependencies: readonly CandidateProjectionDependencyTemplate[];
  readonly reused_projection_record_ids: readonly string[];
  readonly absence_barrier_keys: readonly string[];
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  }
  return value;
}

const sortKeyEncoder = new TextEncoder();

// Schwartzian transform: encode each sort key once instead of allocating two
// fresh Buffers per comparison over potentially multi-KB keys.
function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return values
    .map((value) => ({ value, keyBytes: sortKeyEncoder.encode(key(value)) }))
    .sort((left, right) => compareBytes(left.keyBytes, right.keyBytes))
    .map((entry) => entry.value);
}

function digest(value: unknown, limits: CanonicalEncodingLimits = {}): string {
  return digestBytes(canonicalBytes(value, limits));
}

// `CandidateMaterialization`'s template-set fields (`record_open_template_set`,
// `record_closure_template_set`, etc. -- see
// `docs/serialization/core-digest-field-contracts.md`) each carry Text, but the text they
// carry is now a small, bounded `OrderedSetDescriptor` (`orderedSetDescriptor`, below),
// not the template array itself. The array (which, for a real analyzer such as
// `packages/plugin-javascript-typescript/src/analyzer.ts`, embeds every record's own
// source-span text and legitimately scales with real workspace size) is digested
// incrementally via `digestCanonicalArray` -- one element at a time, under
// `@urdira/canonical`'s ordinary default per-element limits -- and never concatenated
// into one in-memory encoding. So `materialization_digest` itself, and every per-set
// digest inside a descriptor, can use the shared default limits everywhere: no field of
// the sealed materialization object is an aggregate of unbounded size anymore. The
// caller carries the actual arrays out-of-band (`SealedCandidateMaterialization`) for
// storage to persist as CAS-backed segments (`packages/storage/src/candidates.ts`).
export interface CandidateMaterializerOptions {}

const recordDigestMemo = new WeakMap<ProposedRecord, string>();

function recordDigest(record: ProposedRecord): string {
  const cached = recordDigestMemo.get(record);
  if (cached !== undefined) return cached;
  const value = digest(record);
  recordDigestMemo.set(record, value);
  return value;
}

function causes(ownerArtifactId: string): readonly ChangeCauseReference[] {
  return [{ cause_type: "artifact", cause_id: ownerArtifactId }];
}

const scopedRecordsMemo = new WeakMap<object, ProposedRecord[]>();

function scopeRecords(input: CandidateMaterializationInput): ProposedRecord[] {
  const cached = scopedRecordsMemo.get(input as object);
  if (cached !== undefined) return cached;
  const records = sorted(input.accepted_deltas.flatMap((delta) => delta.replacement_sets.flatMap((set) => set.records)), (record) => record.proposal_record_key);
  scopedRecordsMemo.set(input as object, records);
  return records;
}

interface RecordOwner {
  readonly owner_artifact_id: string;
  readonly owner_artifact_version_id: string;
}

// ProposedRecord is pure content (decision 11): it carries no workspace/owner
// of its own. Its owner is the replacement scope that produced it (uniform
// per FactDelta -- one work item owns exactly one artifact version -- but
// scopes vary across the several deltas one candidate materialization can
// cover), and its workspace is always `input.candidate.workspace_id`. Built
// once per `seal()` call and threaded into `recordTemplates`/`validateBindings`
// instead of each independently re-deriving it.
function recordOwners(input: CandidateMaterializationInput): ReadonlyMap<string, RecordOwner> {
  const owners = new Map<string, RecordOwner>();
  for (const delta of input.accepted_deltas) for (const set of delta.replacement_sets) for (const record of set.records) owners.set(record.proposal_record_key, { owner_artifact_id: set.scope.owner_artifact_id, owner_artifact_version_id: set.scope.owner_artifact_version_id });
  return owners;
}

function identityTypeForCategory(category: string): "entity" | "relation" | "diagnostic" | undefined {
  if (category === "entity" || category === "relation" || category === "diagnostic") return category;
  return undefined;
}

// A replacement scope supersedes whatever its owner artifact *currently*
// has, regardless of which exact prior version originally wrote it: the
// scope's own record_categories/record_kinds are themselves derived from
// `owned_records` matched by `owner_artifact_id` alone
// (`candidate-planning.ts`'s `expectedScopes`/`affectedRecords`), so a base
// record must match the same way here. Requiring the base row's
// owner_artifact_version_id to equal the scope's (necessarily new, on a
// genuine content edit) target version would make `matchingBaseRecords`
// blind to that owner's own prior-version records on every edit -- under
// the old workspace-salted digest scheme this was merely wasteful (the
// mismatch meant "no previous" so every record was freshly minted with a
// version-salted, guaranteed-unique id, and unmatched base rows just never
// closed); under content-derived ids (decision 11) it is unsafe, because an
// unmatched base row's id can now collide with a content-identical fresh
// mint that skips the chain salt for want of a `previousCandidate`.
// Scopes are grouped by `owner_artifact_id` once so each base record only
// tests the (typically few) scopes belonging to its own owner, instead of
// every scope across the whole candidate -- O(records + scopes) rather than
// O(records * scopes).
function matchingBaseRecords(input: CandidateMaterializationInput): BaseCandidateRecord[] {
  const scopesByOwner = new Map<string, { readonly record_categories: readonly string[]; readonly record_kinds: readonly string[] }[]>();
  for (const delta of input.accepted_deltas) for (const set of delta.replacement_sets) {
    const scope = set.scope;
    const owned = scopesByOwner.get(scope.owner_artifact_id);
    if (owned) owned.push(scope); else scopesByOwner.set(scope.owner_artifact_id, [scope]);
  }
  return sorted(input.base_records.filter((record) => (scopesByOwner.get(record.owner_artifact_id) ?? []).some((scope) => scope.record_categories.includes(record.category) && scope.record_kinds.includes(record.kind))), (record) => record.record_id);
}

function recordTemplates(input: CandidateMaterializationInput, owners: ReadonlyMap<string, RecordOwner>): {
  readonly reused: readonly string[];
  readonly opens: readonly CandidateRecordOpenTemplate[];
  readonly closures: readonly CandidateRecordClosureTemplate[];
  readonly identities: readonly CandidateIdentityAssignmentTemplate[];
  readonly proposal_record_ids: ReadonlyMap<string, string>;
} {
  const desired = scopeRecords(input);
  const workspaceId = input.candidate.workspace_id;
  const base = matchingBaseRecords(input);
  const globalByKey = new Map<string, BaseCandidateRecord[]>();
  for (const record of input.global_identity_records ?? []) {
    if (record.identity_key === undefined) continue;
    const entries = globalByKey.get(`${record.identity_type ?? identityTypeForCategory(record.category) ?? "entity"}\0${record.identity_key}`);
    if (entries) entries.push(record); else globalByKey.set(`${record.identity_type ?? identityTypeForCategory(record.category) ?? "entity"}\0${record.identity_key}`, [record]);
  }
  for (const entries of globalByKey.values()) {
    const distinctRecordIds = new Set(entries.map((record) => record.record_id));
    if (distinctRecordIds.size > 1) throw new CandidateMaterializationError("core:identity_assignment_conflict", "More than one active record matches an exact identity key.", { identity_key_digest: digest(entries[0]!.identity_key), conflict_kind: "multiple_active_records", record_ids: [...distinctRecordIds] });
  }
  const baseByKey = new Map(base.filter((record) => record.identity_key !== undefined).map((record) => [`${record.identity_type ?? identityTypeForCategory(record.category) ?? "entity"}\0${record.identity_key!}`, record]));
  const absenceBarriers = new Map((input.absence_barriers ?? []).map((entry) => [`${entry.identity_type}\0${entry.identity_key}`, entry]));
  const desiredByKey = new Map<string, ProposedRecord>();
  for (const record of desired) if (!desiredByKey.has(record.identity_key)) desiredByKey.set(record.identity_key, record);
  const reused: string[] = [];
  const opens: CandidateRecordOpenTemplate[] = [];
  const closures: CandidateRecordClosureTemplate[] = [];
  const identities: CandidateIdentityAssignmentTemplate[] = [];
  const replacementIds = new Map<string, string>();
  const proposalRecordIds = new Map<string, string>();
  const migrationPredecessors = new Map<string, BaseCandidateRecord>();

  for (const record of desired) {
    const owner = owners.get(record.proposal_record_key)!;
    const identityType = identityTypeForCategory(record.category) ?? "entity";
    const identityKey = `${identityType}\0${record.identity_key}`;
    const previousCandidate = baseByKey.get(identityKey);
    const globalPrevious = globalByKey.get(identityKey)?.[0];
    const candidate = previousCandidate ?? globalPrevious;
    const barrier = absenceBarriers.get(`${candidate?.identity_type ?? identityType}\0${record.identity_key}`) ?? absenceBarriers.get(`entity\0${record.identity_key}`);
    const ownerMigrated = candidate !== undefined && candidate.owner_artifact_id !== owner.owner_artifact_id;
    if (ownerMigrated) migrationPredecessors.set(candidate!.record_id, candidate!);
    const previous = barrier !== undefined || ownerMigrated ? undefined : candidate;
    if (!ownerMigrated && previous !== undefined && previous.record_digest === recordDigest(record)) {
      // A reused record (unchanged content, same `record_id`) whose identity
      // hasn't moved needs no new `identity_assignments` row at all: the
      // identity assignment that already exists for it -- `digest({record_id:
      // previous.record_id, identity_key: record.identity_key})`, the exact
      // same formula this branch used to re-propose here -- is content-derived
      // from values that are, by construction of this very branch, unchanged
      // (`previous.record_id`/`record.identity_key` are identical to whatever
      // minted that row originally). Its `owner_artifact_id`/`owner_artifact_version_id`
      // stay correctly frozen at whatever they were on first open too, exactly
      // like `record_occurrences` itself already does for a reused row (no
      // `opens` entry pushed below either) -- using THIS scan's fresh `owner`
      // here, as the old code did, was actually a latent correctness bug of
      // its own: it silently rewrote the identity assignment's owner columns
      // out of sync with the (never-rewritten) record's own owner every
      // generation, undetected because `assertPublicationImmutableRows`'s
      // identity-assignment check only ever compares against a row from the
      // SAME generation, never a prior one.
      //
      // Before this fix, `identity_assignments` uses `valid_from_generation`
      // as part of its own primary key (`schema.ts`), unlike `record_occurrences`
      // (which never re-opens a reused row) -- so re-proposing this template
      // every scan meant a genuinely NEW physical row, at the CURRENT
      // generation, for every reused record with an identity, forever. On an
      // incremental scan whose affected-owner closure is wide (e.g. a widely
      // imported module, pulling in hundreds of owners' worth of records even
      // though only one file's content actually changed), this made
      // `identity_assignments` writes -- and `assertPublicationImmutableRows`'s
      // byte-comparison of each one -- scale with affected-scope size instead
      // of changed-record count, dominating incremental publish time at real
      // repository scale (measured: publish growing from 144s to 236s between
      // two successive one-file edits on a real, large repository, entirely
      // from this). Skipping the push here is sufficient on its own -- no
      // change needed in `publication-authority.ts`, since both the write
      // loop and `assertPublicationImmutableRows` already just iterate
      // whatever `templateSets.identity_assignments` contains.
      reused.push(previous.record_id);
      proposalRecordIds.set(record.proposal_record_key, previous.record_id);
      continue;
    }
    // The new record id is a pure content digest on first open. On
    // replacement (a previously-visible row under the same identity key,
    // barrier or not) and/or an absence-barrier reopen, the id is salted with
    // whatever of those two applies -- composed when both do -- so an A->B->A
    // content revert never re-mints the id of its own closed history row
    // (see docs/decisions/11-content-derived-record-identity.md). Content-identical
    // first opens across workspaces still yield identical ids: the fork property.
    const salt: Record<string, unknown> = {};
    if (candidate !== undefined) salt["previous_record_id"] = candidate.record_id;
    if (barrier !== undefined) salt["absence_barrier"] = barrier.closed_identity_id;
    const hasSalt = candidate !== undefined || barrier !== undefined;
    const digestInput = hasSalt ? { record, ...salt } : record;
    const newRecordId = `record:${digest(digestInput).slice("sha256:".length)}`;
    proposalRecordIds.set(record.proposal_record_key, newRecordId);
    replacementIds.set(record.identity_key, newRecordId);
    // `record_without_validity` carries the canonical JSON of exactly the digest
    // input above, so storage (`memoizeRecordOpens`, publication-authority.ts)
    // re-derives the identical id byte-for-byte from the template alone.
    opens.push({ record_without_validity: canonicalJson(digestInput), open_reason_code: previous === undefined ? "core:record_created" : "core:record_replaced", ...(previous === undefined ? {} : { previous_record_id: previous.record_id }), owner_artifact_id: owner.owner_artifact_id, owner_artifact_version_id: owner.owner_artifact_version_id, cause_references: causes(owner.owner_artifact_id) });
    if (previous?.identity_type !== undefined && previous.identity_id !== undefined) identities.push({
      identity_assignment_id: digest({ record_id: newRecordId, identity_key: record.identity_key }),
      workspace_id: workspaceId,
      identity_type: previous.identity_type,
      identity_id: previous.identity_id,
      assignment_kind: "continued",
      identity_key: record.identity_key,
      identity_key_digest: digest(record.identity_key),
      record_id: newRecordId,
      previous_record_id: previous.record_id,
      owner_artifact_id: owner.owner_artifact_id,
      owner_artifact_version_id: owner.owner_artifact_version_id,
    });
    else {
      const createdIdentityType = identityTypeForCategory(record.category) ?? "entity";
      const identitySalt = barrier === undefined
        ? ownerMigrated ? { identity_key: record.identity_key, owner_migration_barrier: candidate!.identity_id } : { identity_key: record.identity_key }
        : { identity_key: record.identity_key, absence_barrier: barrier.closed_identity_id };
      identities.push({
        identity_assignment_id: digest({ record_id: newRecordId, identity_key: record.identity_key }),
        workspace_id: workspaceId,
        identity_type: createdIdentityType,
        identity_id: `${createdIdentityType}:${digest(identitySalt).slice("sha256:".length)}`,
        assignment_kind: "created",
        identity_key: record.identity_key,
        identity_key_digest: digest(record.identity_key),
        record_id: newRecordId,
        owner_artifact_id: owner.owner_artifact_id,
        owner_artifact_version_id: owner.owner_artifact_version_id,
      });
    }
  }

  const closureCandidates = new Map<string, BaseCandidateRecord>();
  for (const previous of base) closureCandidates.set(previous.record_id, previous);
  for (const previous of migrationPredecessors.values()) closureCandidates.set(previous.record_id, previous);
  for (const previous of closureCandidates.values()) {
    const barrier = previous.identity_key === undefined ? undefined : absenceBarriers.get(`${previous.identity_type ?? identityTypeForCategory(previous.category) ?? "entity"}\0${previous.identity_key}`) ?? absenceBarriers.get(`entity\0${previous.identity_key}`);
    if (barrier !== undefined) {
      const replacement = replacementIds.get(previous.identity_key!);
      closures.push({ record_id: previous.record_id, workspace_id: previous.workspace_id, owner_artifact_id: previous.owner_artifact_id, owner_artifact_version_id: previous.owner_artifact_version_id, category: previous.category, kind: previous.kind, universal_kind: previous.universal_kind, closure_reason_code: "core:record_replaced", ...(replacement === undefined ? {} : { replacement_record_id: replacement }), cause_references: [{ cause_type: "artifact", cause_id: previous.owner_artifact_id }] });
    } else if (previous.identity_key !== undefined && desiredByKey.has(previous.identity_key)) {
      const desiredRecord = desiredByKey.get(previous.identity_key);
      const desiredOwner = desiredRecord === undefined ? undefined : owners.get(desiredRecord.proposal_record_key);
      if (desiredRecord !== undefined && desiredOwner?.owner_artifact_id === previous.owner_artifact_id && previous.record_digest === recordDigest(desiredRecord)) continue;
      const replacement = previous.identity_key === undefined ? undefined : replacementIds.get(previous.identity_key);
      closures.push({ record_id: previous.record_id, workspace_id: previous.workspace_id, owner_artifact_id: previous.owner_artifact_id, owner_artifact_version_id: previous.owner_artifact_version_id, category: previous.category, kind: previous.kind, universal_kind: previous.universal_kind, closure_reason_code: "core:record_replaced", ...(replacement === undefined ? {} : { replacement_record_id: replacement }), cause_references: [{ cause_type: "artifact", cause_id: previous.owner_artifact_id }] });
    } else {
      closures.push({ record_id: previous.record_id, workspace_id: previous.workspace_id, owner_artifact_id: previous.owner_artifact_id, owner_artifact_version_id: previous.owner_artifact_version_id, category: previous.category, kind: previous.kind, universal_kind: previous.universal_kind, closure_reason_code: "core:record_removed", cause_references: [{ cause_type: "artifact", cause_id: previous.owner_artifact_id }] });
    }
  }

  return { reused: sorted(reused, (entry) => entry), opens: sorted(opens, (entry) => entry.record_without_validity), closures: sorted(closures, (entry) => entry.record_id), identities: sorted(identities, (entry) => entry.identity_assignment_id), proposal_record_ids: proposalRecordIds };
}

function projectionTemplates(input: CandidateMaterializationInput): { readonly opens: readonly CandidateProjectionOpenTemplate[]; readonly closures: readonly CandidateProjectionClosureTemplate[]; readonly reused: readonly string[] } {
  const opens: CandidateProjectionOpenTemplate[] = [];
  const closures: CandidateProjectionClosureTemplate[] = [];
  const reused: string[] = [];
  const current = new Map<string, CandidateProjectionTemplate>();
  const projectionIds = new Set<string>();
  const projectionKeys = new Set<string>();
  const allowedArtifactVersions = new Set(input.known_artifact_versions.map((entry) => entry.artifact_version_id));
  const allowedRecords = new Set([
    ...input.base_records.map((record) => record.record_id),
    ...scopeRecords(input).map((record) => record.proposal_record_key),
    ...input.accepted_deltas.flatMap((delta) => delta.validated_staged_records.flatMap((record) => [record.staged_record_id, record.proposal_record_key])),
    ...(input.record_dependencies ?? []).map((dependency) => dependency.record_id),
  ]);
  const allowedProjections = new Set(input.base_projections.map((projection) => projection.projection_record_id));
  for (const set of input.accepted_projection_sets) for (const projection of set.projections) allowedProjections.add(projection.projection_record_id);
  const projectionFields = ["projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "source_artifact_version_ids", "source_record_ids", "source_projection_record_ids", "generator", "generator_version", "generator_configuration_digest", "payload"].sort().join("\0");
  const validateSourceIds = (value: unknown, field: string, projection: CandidateProjectionTemplate): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0) || new Set(value).size !== value.length) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection source bindings must be unique non-empty ID arrays.", { projection_record_id: projection.projection_record_id, field });
    return [...value] as string[];
  };
  const validateProjection = (projection: CandidateProjectionTemplate, workItem: ProjectionWorkItem): void => {
    if (Object.keys(projection as unknown as Record<string, unknown>).sort().join("\0") !== projectionFields) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection object has an unknown or missing field.", { projection_record_id: projection.projection_record_id });
    for (const field of ["projection_record_id", "projection_kind", "projection_key", "workspace_id", "owner_artifact_id", "owner_artifact_version_id", "generator", "generator_version", "generator_configuration_digest"] as const) {
      if (typeof projection[field] !== "string" || projection[field].length === 0) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection identity fields are required.", { projection_record_id: projection.projection_record_id, field });
    }
    if (projection.projection_kind !== workItem.projection_kind || projection.workspace_id !== input.candidate.workspace_id || projection.owner_artifact_id !== workItem.owner_artifact_id || projection.owner_artifact_version_id !== workItem.owner_artifact_version_id || projection.generator !== workItem.generator || projection.generator_version !== workItem.generator_version || projection.generator_configuration_digest !== workItem.generator_configuration_digest) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection kind, identity, or ownership does not match its work item.", { projection_record_id: projection.projection_record_id, projection_kind: projection.projection_kind });
    const artifactSources = validateSourceIds(projection.source_artifact_version_ids, "source_artifact_version_ids", projection);
    const recordSources = validateSourceIds(projection.source_record_ids, "source_record_ids", projection);
    const projectionSources = validateSourceIds(projection.source_projection_record_ids, "source_projection_record_ids", projection);
    if (!artifactSources.includes(workItem.owner_artifact_version_id)) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection source bindings must include the work-item owner artifact version.", { projection_record_id: projection.projection_record_id, validation_kind: "owner_artifact_version_id" });
    if (artifactSources.length + recordSources.length + projectionSources.length === 0) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection has no source binding.", { projection_record_id: projection.projection_record_id });
    if (artifactSources.some((source) => !allowedArtifactVersions.has(source)) || recordSources.some((source) => !allowedRecords.has(source)) || projectionSources.some((source) => !allowedProjections.has(source))) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection source binding is not visible in the accepted candidate context.", { projection_record_id: projection.projection_record_id });
    try { canonicalJson(projection.payload); } catch { throw new CandidateMaterializationError("core:projection_output_invalid", "Projection payload is not canonical JSON.", { projection_record_id: projection.projection_record_id }); }
    if (projectionIds.has(projection.projection_record_id) || projectionKeys.has(projection.projection_key)) throw new CandidateMaterializationError("core:projection_output_invalid", "Projection IDs and keys must be unique across the candidate.", { projection_record_id: projection.projection_record_id, projection_key: projection.projection_key });
    projectionIds.add(projection.projection_record_id);
    projectionKeys.add(projection.projection_key);
  };
  for (const set of input.accepted_projection_sets) {
    const expectedDigest = digest(set.projections);
    if (set.projection_set_digest !== expectedDigest) throw new CandidateMaterializationError("core:projection_digest_mismatch", "Projection replacement set digest does not match its canonical projections.", { expected_digest: expectedDigest, actual_digest: set.projection_set_digest });
    for (const projection of set.projections) {
      validateProjection(projection, set.work_item);
      current.set(projection.projection_record_id, projection);
    }
  }
  // Excludes workspace_id (decision 11: canonical layer digests stay
  // workspace-free; the row column carries it). Storage independently
  // recomputes this same field set for `projection_occurrences.content_digest`
  // (`projectionContentDigestInput`, publication-authority.ts) -- keep the two in sync.
  const projectionDigest = (projection: CandidateProjectionTemplate): string => digest({ projection_record_id: projection.projection_record_id, projection_kind: projection.projection_kind, projection_key: projection.projection_key, owner_artifact_id: projection.owner_artifact_id, owner_artifact_version_id: projection.owner_artifact_version_id, source_artifact_version_ids: projection.source_artifact_version_ids, source_record_ids: projection.source_record_ids, source_projection_record_ids: projection.source_projection_record_ids, generator: projection.generator, generator_version: projection.generator_version, generator_configuration_digest: projection.generator_configuration_digest, payload: projection.payload });
  const baseProjectionsById = new Map(input.base_projections.map((entry) => [entry.projection_record_id, entry]));
  for (const [projectionId, projection] of current) {
    const base = baseProjectionsById.get(projectionId);
    if (base !== undefined && base.content_digest === projectionDigest(projection)) reused.push(projectionId);
    else {
      const occurrence = base === undefined ? projection : { ...projection, projection_record_id: `projection:${digest({ previous_projection_record_id: base.projection_record_id, projection_digest: projectionDigest(projection) }).slice("sha256:".length)}` };
      opens.push({ projection: canonicalJson(occurrence) });
      if (base !== undefined) current.set(projectionId, occurrence);
    }
  }
  for (const base of input.base_projections) {
    const replacement = current.get(base.projection_record_id);
    if (replacement !== undefined && base.content_digest === projectionDigest(replacement)) continue;
    closures.push({ projection_record_id: base.projection_record_id, projection_kind: base.projection_kind, projection_key: base.projection_key, workspace_id: input.candidate.workspace_id, owner_artifact_id: base.owner_artifact_id, owner_artifact_version_id: base.owner_artifact_version_id, generator: base.generator ?? "", generator_version: base.generator_version ?? "", generator_configuration_digest: base.generator_configuration_digest ?? "", change_reason_code: replacement === undefined ? "core:projection_removed" : "core:projection_replaced", ...(replacement === undefined ? {} : { replacement_projection_record_id: replacement.projection_record_id }), cause_references: [] });
  }
  return { opens: freeze(sorted(opens, (entry) => entry.projection)), closures: freeze(sorted(closures, (entry) => entry.projection_record_id)), reused: freeze(sorted(reused, (entry) => entry)) };
}

function exactBindingKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value);
}

function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

function digestString(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }

const LOOKUP_CONSUMER_TYPES = new Set<PluginInvalidationConsumerType>(["record_set", "projection_set", "partition_set"]);
const LOOKUP_OPERATIONS = new Set<PluginLookupOperation>(["artifact_list", "artifact_find", "record_get", "record_query"]);
const LOOKUP_INVALIDATION_SCOPES = new Set<PluginInvalidationScope>(["exact_address", "exact_selector", "plugin_partition", "plugin", "workspace"]);

function selectorDigestMatches(operation: unknown, normalizedSelectorOrAddress: unknown, selectorDigest: unknown): boolean {
  return typeof operation === "string" && LOOKUP_OPERATIONS.has(operation as PluginLookupOperation) && nonEmptyString(normalizedSelectorOrAddress) && selectorDigest === canonicalSha256({ operation, normalized_selector_or_address: normalizedSelectorOrAddress });
}

function candidateMaterializationError(message: string, scope: Readonly<Record<string, unknown>> = {}): never {
  throw new CandidateMaterializationError("core:dependency_validation_failed", message, scope);
}

function validateBindings(input: CandidateMaterializationInput, proposalRecordIds: ReadonlyMap<string, string>, owners: ReadonlyMap<string, RecordOwner>): {
  readonly record_dependencies: readonly CandidateRecordDependencyTemplate[];
  readonly lookup_bindings: readonly CandidateLookupBindingTemplate[];
  readonly projection_dependencies: readonly CandidateProjectionDependencyTemplate[];
} {
  if (!Array.isArray(input.known_artifact_versions)) candidateMaterializationError("Complete artifact authority is required.", { dependency_failure_kind: "artifact_authority_missing" });
  if (!Array.isArray(input.known_lookup_dependencies)) candidateMaterializationError("Complete lookup authority is required.", { dependency_failure_kind: "lookup_authority_missing" });
  const workspaceId = input.candidate.workspace_id;
  const baseRecords = new Map(input.base_records.map((record) => [record.record_id, record]));
  const proposedRecords = new Map(scopeRecords(input).map((record) => [record.proposal_record_key, record]));
  const proposedRecordsByFinalId = new Map([...proposalRecordIds].flatMap(([proposalKey, recordId]) => {
    const record = proposedRecords.get(proposalKey);
    return record === undefined ? [] : [[recordId, record] as const];
  }));
  // Owner of any record known here, whichever source it came from: a base
  // row already has workspace/owner as row columns; a proposed record's
  // owner is content-free (decision 11) and comes from its replacement scope
  // via `owners`. Used both to build promoted dependencies and to check a
  // supplied dependency binding's declared ownership against the record it
  // names.
  const ownerOf = (recordId: string): (RecordOwner & { readonly workspace_id: string }) | undefined => {
    const base = baseRecords.get(recordId);
    if (base !== undefined) return { workspace_id: base.workspace_id, owner_artifact_id: base.owner_artifact_id, owner_artifact_version_id: base.owner_artifact_version_id };
    const proposed = proposedRecords.get(recordId) ?? proposedRecordsByFinalId.get(recordId);
    const owner = proposed === undefined ? undefined : owners.get(proposed.proposal_record_key);
    return owner === undefined ? undefined : { workspace_id: workspaceId, ...owner };
  };
  const knownRecords = new Set([...baseRecords.keys(), ...proposedRecords.keys(), ...proposedRecordsByFinalId.keys(), ...input.accepted_deltas.flatMap((delta) => delta.validated_staged_records.flatMap((entry) => [entry.staged_record_id, entry.proposal_record_key]))]);
  const knownArtifacts = new Map<string, CandidateKnownArtifactVersion>();
  const addArtifact = (entry: CandidateKnownArtifactVersion): void => {
    const raw = entry as unknown as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["artifact_id", "artifact_version_id", "content_digest"]) || !nonEmptyString(entry.artifact_id) || !nonEmptyString(entry.artifact_version_id) || !digestString(entry.content_digest)) candidateMaterializationError("Artifact authority identity or content digest is invalid.", { dependency_failure_kind: "artifact_authority_invalid", dependency_artifact_version_id: entry.artifact_version_id });
    if (knownArtifacts.has(entry.artifact_version_id)) candidateMaterializationError("Artifact version identity is duplicated.", { dependency_artifact_version_id: entry.artifact_version_id });
    knownArtifacts.set(entry.artifact_version_id, entry);
  };
  for (const entry of input.known_artifact_versions) addArtifact(entry);
  const knownProjections = new Set([...input.base_projections.map((projection) => projection.projection_record_id), ...input.accepted_projection_sets.flatMap((set) => set.projections.map((projection) => projection.projection_record_id))]);
  const roles = new Set(input.known_dependency_roles ?? ["references"]);
  const dependencies: CandidateRecordDependencyTemplate[] = [];
  const dependencyIds = new Set<string>();
  const promotedDependencies: RecordArtifactDependency[] = input.accepted_deltas.flatMap((accepted) => (accepted.delta.proposed_dependencies ?? []).map((dependency) => {
    const recordId = proposalRecordIds.get(dependency.proposal_record_key);
    const owner = owners.get(dependency.proposal_record_key);
    if (owner === undefined || recordId === undefined) throw new CandidateMaterializationError("core:dependency_validation_failed", "Accepted dependency source proposal is absent from the sealed record set.", { dependency_failure_kind: "proposal_record_missing", proposal_record_key: dependency.proposal_record_key });
    // The dependency's owner must match whichever owner its *record*
    // (`recordId`) actually has, not necessarily this scan's own fresh
    // replacement-scope owner (`owner`, above). Those two disagree exactly
    // when `recordId` was *reused* this scan (`recordTemplates`'s reuse
    // branch: unchanged content keeps the record's existing `record_id`, and
    // -- since a record row is immutable once opened -- its stored
    // `record_occurrences.owner_artifact_version_id` is never rewritten to
    // the file's newly minted version). A plugin's fact-delta has no way to
    // know in advance whether a given proposed record will turn out reused
    // or freshly opened (that is decided later, by `recordTemplates`, from
    // the very same `accepted_deltas` this dependency was itself proposed
    // from) -- so `owner` here can legitimately be stale by the time this
    // runs. `ownerOf` (this function's own well-tested "base row wins, else
    // this scan's own proposal" precedence, otherwise used only to validate
    // an *externally supplied* dependency's ownership) resolves the record's
    // actual, current owner regardless of which branch it took, so re-using
    // it here keeps `promotedDependencies` internally consistent with the
    // records they reference instead of only checking consistency for
    // `input.record_dependencies` (never populated by any production caller
    // today, but the shape this validation was originally written against).
    // Before this fix, any incremental scan that reused a record while
    // re-proposing its (unchanged) dependency threw `core:dependency_validation_failed`/
    // `owner_mismatch` here -- not fork-specific, just never exercised by
    // any test with real cross-file dependencies and reused-but-referenced
    // declarations before this fix, since a record's own file must both
    // change (to mint a new owner version) and *not* change (for that one
    // declaration to reuse) in the same scan for the mismatch to surface.
    // Falls back to `owner` only if `ownerOf` cannot resolve the record at
    // all, which should not happen given `recordId` was itself derived from
    // `proposalRecordIds`.
    const resolvedOwner = ownerOf(recordId) ?? owner;
    return {
      dependency_entry_id: `dependency:${digest({ fact_delta_id: accepted.delta.fact_delta_id, proposed_dependency_id: dependency.proposed_dependency_id, record_id: recordId }).slice("sha256:".length)}`,
      workspace_id: workspaceId,
      record_id: recordId,
      owner_artifact_id: resolvedOwner.owner_artifact_id,
      owner_artifact_version_id: resolvedOwner.owner_artifact_version_id,
      dependency_artifact_id: dependency.dependency_artifact_id,
      dependency_artifact_version_id: dependency.dependency_artifact_version_id,
      dependency_role: dependency.dependency_role,
      producer_id: accepted.delta.plugin_id,
      producer_version: accepted.delta.plugin_version,
      valid_from_generation: 0,
    };
  }));
  for (const dependency of [...(input.record_dependencies ?? []), ...promotedDependencies]) {
    const raw = dependency as unknown as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["dependency_entry_id", "workspace_id", "record_id", "owner_artifact_id", "owner_artifact_version_id", "dependency_artifact_id", "dependency_artifact_version_id", "dependency_role", "producer_id", "producer_version", "valid_from_generation"], ["valid_to_generation"]) || !Object.values(raw).every((value) => value !== undefined)) throw new CandidateMaterializationError("core:dependency_validation_failed", "Record dependency binding is incomplete or has unknown fields.", { dependency_failure_kind: "binding_shape" });
    if (!nonEmptyString(dependency.dependency_entry_id) || dependencyIds.has(dependency.dependency_entry_id) || !nonEmptyString(dependency.workspace_id) || dependency.workspace_id !== input.candidate.workspace_id || !nonEmptyString(dependency.record_id) || !knownRecords.has(dependency.record_id) || !nonEmptyString(dependency.owner_artifact_id) || !nonEmptyString(dependency.owner_artifact_version_id) || !nonEmptyString(dependency.dependency_artifact_id) || !nonEmptyString(dependency.dependency_artifact_version_id) || !roles.has(dependency.dependency_role) || !nonEmptyString(dependency.producer_id) || !nonEmptyString(dependency.producer_version) || !Number.isSafeInteger(dependency.valid_from_generation) || (dependency.valid_to_generation !== undefined && (!Number.isSafeInteger(dependency.valid_to_generation) || dependency.valid_to_generation < dependency.valid_from_generation))) throw new CandidateMaterializationError("core:dependency_validation_failed", "Record dependency binding is not owned, visible, complete, unique, or registered.", { dependency_entry_id: dependency.dependency_entry_id, dependency_failure_kind: "binding_identity" });
    const matchedOwner = ownerOf(dependency.record_id);
    if (matchedOwner !== undefined && (matchedOwner.workspace_id !== dependency.workspace_id || matchedOwner.owner_artifact_id !== dependency.owner_artifact_id || matchedOwner.owner_artifact_version_id !== dependency.owner_artifact_version_id)) throw new CandidateMaterializationError("core:dependency_validation_failed", "Record dependency binding ownership does not match its record.", { dependency_entry_id: dependency.dependency_entry_id, dependency_failure_kind: "owner_mismatch" });
    const artifact = knownArtifacts.get(dependency.dependency_artifact_version_id);
    if (artifact === undefined || artifact.artifact_id !== dependency.dependency_artifact_id) throw new CandidateMaterializationError("core:dependency_validation_failed", "Record dependency artifact version is not known or has the wrong artifact owner.", { dependency_entry_id: dependency.dependency_entry_id, dependency_failure_kind: "artifact_version_unknown" });
    dependencyIds.add(dependency.dependency_entry_id);
    const { valid_from_generation: _validFromGeneration, valid_to_generation: _validToGeneration, ...generationNeutral } = dependency;
    dependencies.push(generationNeutral);
  }
  const lookupBindings: CandidateLookupBindingTemplate[] = [];
  const lookupIds = new Set<string>();
  const knownLookupDependencies = new Map<string, CandidateLookupDependencyAuthority>();
  for (const authority of input.known_lookup_dependencies) {
    const raw = authority as unknown as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["lookup_dependency_id", "workspace_id", "consumer_type", "consumer_id", "operation", "normalized_selector_or_address", "selector_digest", "previous_result_set_digest", "invalidation_scope"], ["owner_artifact_id", "owner_artifact_version_id"]) || !Object.values(raw).every((value) => value !== undefined) || !nonEmptyString(authority.lookup_dependency_id) || !nonEmptyString(authority.workspace_id) || !LOOKUP_CONSUMER_TYPES.has(authority.consumer_type) || !nonEmptyString(authority.consumer_id) || !LOOKUP_OPERATIONS.has(authority.operation) || !nonEmptyString(authority.normalized_selector_or_address) || !digestString(authority.selector_digest) || !selectorDigestMatches(authority.operation, authority.normalized_selector_or_address, authority.selector_digest) || !digestString(authority.previous_result_set_digest) || !LOOKUP_INVALIDATION_SCOPES.has(authority.invalidation_scope) || (authority.owner_artifact_version_id !== undefined && authority.owner_artifact_id === undefined)) candidateMaterializationError("Lookup authority identity or completeness is invalid.", { dependency_failure_kind: "lookup_authority_invalid", lookup_dependency_id: authority.lookup_dependency_id });
    if (knownLookupDependencies.has(authority.lookup_dependency_id)) candidateMaterializationError("Lookup dependency identity is duplicated.", { dependency_failure_kind: "lookup_authority_duplicate", lookup_dependency_id: authority.lookup_dependency_id });
    knownLookupDependencies.set(authority.lookup_dependency_id, authority);
  }
  for (const binding of input.lookup_bindings ?? []) {
    const raw = binding as unknown as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["lookup_dependency_id", "workspace_id", "consumer_type", "consumer_id", "operation", "normalized_selector_or_address", "selector_digest", "previous_result_set_digest", "invalidation_scope", "valid_from_generation"], ["owner_artifact_id", "owner_artifact_version_id", "valid_to_generation"]) || !Object.values(raw).every((value) => value !== undefined)) throw new CandidateMaterializationError("core:dependency_validation_failed", "Lookup binding is incomplete or has unknown fields.", { dependency_failure_kind: "lookup_binding_shape" });
    const id = raw["lookup_dependency_id"];
    const authority = nonEmptyString(id) ? knownLookupDependencies.get(id) : undefined;
    const { valid_from_generation: _validFromGeneration, valid_to_generation: _validToGeneration, ...generationNeutral } = binding;
    const visibleConsumer = raw["consumer_type"] === "record_set" ? knownRecords.has(String(raw["consumer_id"])) : raw["consumer_type"] === "projection_set" ? knownProjections.has(String(raw["consumer_id"])) : raw["consumer_type"] === "partition_set" && nonEmptyString(raw["owner_artifact_version_id"]) && knownArtifacts.has(String(raw["owner_artifact_version_id"]));
    if (!nonEmptyString(id) || lookupIds.has(id) || authority === undefined || canonicalJson(generationNeutral) !== canonicalJson(authority) || raw["workspace_id"] !== input.candidate.workspace_id || !visibleConsumer || !LOOKUP_CONSUMER_TYPES.has(raw["consumer_type"] as PluginInvalidationConsumerType) || !nonEmptyString(raw["consumer_id"]) || !LOOKUP_OPERATIONS.has(raw["operation"] as PluginLookupOperation) || !nonEmptyString(raw["normalized_selector_or_address"]) || !digestString(raw["selector_digest"]) || !selectorDigestMatches(raw["operation"], raw["normalized_selector_or_address"], raw["selector_digest"]) || !digestString(raw["previous_result_set_digest"]) || !LOOKUP_INVALIDATION_SCOPES.has(raw["invalidation_scope"] as PluginInvalidationScope) || !Number.isSafeInteger(raw["valid_from_generation"]) || (raw["valid_to_generation"] !== undefined && (!Number.isSafeInteger(raw["valid_to_generation"]) || (raw["valid_to_generation"] as number) < (raw["valid_from_generation"] as number)))) throw new CandidateMaterializationError("core:dependency_validation_failed", "Lookup binding is not known, complete, visible, or unique.", { dependency_failure_kind: "lookup_binding_identity", lookup_dependency_id: id });
    lookupIds.add(id);
    lookupBindings.push(generationNeutral as CandidateLookupBindingTemplate);
  }
  const projectionDependencies: CandidateProjectionDependencyTemplate[] = [];
  const projectionDependencyKeys = new Set<string>();
  for (const dependency of input.projection_dependencies ?? []) {
    const raw = dependency as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["projection_record_id", "source_type", "source_id"])) throw new CandidateMaterializationError("core:dependency_validation_failed", "Projection dependency binding is incomplete or has unknown fields.", { dependency_failure_kind: "projection_dependency_shape" });
    const projectionId = raw["projection_record_id"];
    const sourceType = raw["source_type"];
    const sourceId = raw["source_id"];
    const key = `${String(projectionId)}\0${String(sourceType)}\0${String(sourceId)}`;
    const visible = sourceType === "artifact_version" ? knownArtifacts.has(String(sourceId)) : sourceType === "record" ? knownRecords.has(String(sourceId)) : sourceType === "projection" ? knownProjections.has(String(sourceId)) : false;
    if (!nonEmptyString(projectionId) || !knownProjections.has(projectionId) || (sourceType !== "artifact_version" && sourceType !== "record" && sourceType !== "projection") || !nonEmptyString(sourceId) || !visible || projectionDependencyKeys.has(key)) throw new CandidateMaterializationError("core:dependency_validation_failed", "Projection dependency binding is not known, visible, complete, or unique.", { dependency_failure_kind: "projection_dependency_identity", projection_record_id: projectionId, source_id: sourceId });
    projectionDependencyKeys.add(key);
    projectionDependencies.push(dependency);
  }
  return { record_dependencies: freeze(sorted(dependencies, (entry) => `${entry.record_id}\0${entry.dependency_artifact_version_id}\0${entry.dependency_role}`)), lookup_bindings: freeze(sorted(lookupBindings, (entry) => canonicalJson(entry))), projection_dependencies: freeze(sorted(projectionDependencies, (entry) => canonicalJson(entry))) };
}

function semanticAcceptedDeltaDigest(delta: AcceptedFactDelta): string {
  return digest({
    replacement_sets: delta.replacement_sets,
    input_artifact_version_ids: delta.input_artifact_version_ids,
    input_record_ids: delta.input_record_ids,
    transitive_artifact_version_ids: delta.transitive_artifact_version_ids,
    validated_staged_records: delta.validated_staged_records.map((entry) => ({
      proposal_record_key: entry.proposal_record_key,
      validated_record_digest: entry.validated_record_digest,
      transitive_artifact_version_ids: entry.transitive_artifact_version_ids,
    })),
  });
}

export class CandidateMaterializationError extends Error {
  readonly code: string;
  readonly scope: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, scope: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "CandidateMaterializationError";
    this.code = code;
    this.scope = scope;
  }
}

/**
 * Builds the compact `OrderedSetDescriptor` that a `CandidateMaterialization`
 * template-set field's Text now carries, in place of the template array
 * itself (decision: descriptor-as-text, see module comment above).
 * `content_digest` is computed incrementally via `digestCanonicalArray`, so
 * no aggregate encoding of `entries` is ever materialized.
 */
function orderedSetDescriptor(elementType: string, entries: readonly unknown[]): OrderedSetDescriptor {
  const contentDigest = digestCanonicalArray(entries);
  return {
    descriptor_id: `set:${contentDigest.slice("sha256:".length)}`,
    element_type: elementType,
    element_schema_version: "1",
    comparator_id: "core:lexicographic_uri",
    comparator_version: "1",
    entry_count: entries.length,
    content_digest: contentDigest,
  };
}

export class CandidateMaterializer {
  constructor(_options: CandidateMaterializerOptions = {}) {}

  seal(input: CandidateMaterializationInput): SealedCandidateMaterialization {
    const owners = recordOwners(input);
    const records = recordTemplates(input, owners);
    const bindings = validateBindings(input, records.proposal_record_ids, owners);
    const projections = projectionTemplates(input);
    const recordDependencies = bindings.record_dependencies;
    const lookupBindings = bindings.lookup_bindings;
    const projectionDependencies = bindings.projection_dependencies;
    const lookupRevalidations: readonly Readonly<Record<string, unknown>>[] = [];
    const sourceTransitions = input.source_plan.transitions;
    const barrierKeys = new Set((input.absence_barriers ?? []).map((entry) => `${entry.identity_type}\0${entry.identity_key}`));
    const semanticPayload = {
      workspace_id: input.candidate.workspace_id,
      // Materialization identity is candidate-salted so distinct candidates
      // (e.g. a plugin-upgrade generation over identical analysis output)
      // never collide on the table's UNIQUE (workspace_id,
      // materialization_digest) / immutable candidate_generation_id column.
      // A resumed candidate still re-seals to the identical id and digest,
      // since it re-derives from the same candidate_generation_id.
      candidate_generation_id: input.candidate.candidate_generation_id,
      accepted_fact_delta_digests: sorted(input.accepted_deltas.map(semanticAcceptedDeltaDigest), (entry) => entry),
      source_transition_template_set: canonicalJson(orderedSetDescriptor("core:CandidateSourceTransitionTemplate", sourceTransitions)),
      record_open_template_set: canonicalJson(orderedSetDescriptor("core:CandidateRecordOpenTemplate", records.opens)),
      record_closure_template_set: canonicalJson(orderedSetDescriptor("core:CandidateRecordClosureTemplate", records.closures)),
      identity_assignment_template_set: canonicalJson(orderedSetDescriptor("core:CandidateIdentityAssignmentTemplate", records.identities)),
      projection_open_template_sets: projections.opens,
      projection_closure_template_sets: projections.closures,
      capability_state_entries: input.capability_state_entries,
      source_observation_watermarks: input.source_observation_watermarks,
      artifact_dependency_template_set: canonicalJson(orderedSetDescriptor("core:RecordArtifactDependency", recordDependencies)),
      lookup_dependency_template_set: canonicalJson(orderedSetDescriptor("core:PluginLookupInvalidationDependency", lookupBindings)),
      lookup_revalidation_template_set: canonicalJson(orderedSetDescriptor("core:LookupRevalidationTemplate", lookupRevalidations)),
    };
    const semanticDigest = digest({ ...semanticPayload, projection_dependencies: projectionDependencies });
    const materialization = freeze({
      candidate_materialization_id: `materialization:${semanticDigest.slice("sha256:".length)}`,
      ...semanticPayload,
      materialization_digest: semanticDigest,
    });
    return freeze({ materialization, reused_record_ids: freeze(records.reused), source_transitions: freeze([...sourceTransitions]), record_opens: freeze(records.opens), record_closures: freeze(records.closures), identity_assignments: freeze(records.identities), record_dependencies: recordDependencies, lookup_bindings: lookupBindings, lookup_revalidations: freeze([...lookupRevalidations]), projection_dependencies: projectionDependencies, reused_projection_record_ids: projections.reused, absence_barrier_keys: [...barrierKeys].sort() });
  }
}

export type { CandidatePlan, ProjectionWorkItem };
