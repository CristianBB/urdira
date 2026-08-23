import { canonicalJson, canonicalSha256 } from "@urdira/plugin-sdk";
import { canonicalBytes, digestBytes, digestCanonicalArray, digestCanonicalMapWithArrayFields, digestMappedCanonicalArray, LogicalDigestWriter } from "@urdira/canonical";
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
import type { MaterializationAcceptedFactDelta, MaterializationProposedRecord, BaseCandidateRecord } from "./fact-delta.js";
import type { BaseCandidateProjection } from "./candidate-planning.js";
import type { ProviderWatermark, SnapshotCapabilityStateEntry, CandidateWorkManifest } from "@urdira/contracts";
import { timedSync } from "./debug-timing.js";

export interface CandidateMaterializationInput {
  readonly candidate: IndexCandidate;
  readonly manifest: CandidateWorkManifest;
  readonly source_plan: SourceCandidatePlan;
  readonly accepted_deltas: readonly MaterializationAcceptedFactDelta[];
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

/**
 * The per-record id/digest pair `storage/publication-authority.ts`'s
 * `memoizeRecordOpens`/`parseRecordOpens` would otherwise re-derive by
 * `JSON.parse`ing and re-hashing `record_without_validity` (see decision 11
 * and that file's own doc comments). `recordTemplates`/
 * `CandidateRecordTemplateAccumulator` below already compute both values
 * directly from the source record on every open -- this type just carries
 * them out-of-band so publish can look them up instead of recomputing them
 * (3c). Structurally identical to storage's own internal `RecordOpenMemoEntry`;
 * kept as a separate declaration rather than an import so this package does
 * not need to depend on `@urdira/storage`'s internals for a two-field shape.
 */
export interface CandidateRecordOpenMemoEntry {
  readonly recordId: string;
  readonly recordDigest: string;
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
  /** Keyed by object identity of each entry in `record_opens` (3c). */
  readonly record_open_memo: ReadonlyMap<CandidateRecordOpenTemplate, CandidateRecordOpenMemoEntry>;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  }
  return value;
}

// Sort a shallow copy without a Schwartzian transform. The old transform
// allocated a key buffer and wrapper object for every proposed record, then a
// second array for the unwrapped values; on a large first scan that temporary
// graph was enough to exceed V8's heap while the accepted deltas were live.
function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function sortOwned<T>(values: T[], key: (value: T) => string): T[] {
  return values.sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function digest(value: unknown, limits: CanonicalEncodingLimits = {}): string {
  return digestBytes(canonicalBytes(value, limits));
}

interface PackedCandidateTemplate {
  readonly canonical_template: string;
}

const PACKED_CREATED_IDENTITY_MARKER = "urdira:created-identity:v1";
const PACKED_IDENTITY_THRESHOLD = 10_000;
type PackedCreatedIdentityAssignment = readonly [
  typeof PACKED_CREATED_IDENTITY_MARKER,
  workspace_id: string,
  identity_type: string,
  identity_key: string,
  record_id: string,
  owner_artifact_id: string,
  owner_artifact_version_id: string,
];

function isPackedCreatedIdentityAssignment(value: unknown): value is PackedCreatedIdentityAssignment {
  return Array.isArray(value)
    && value.length === 7
    && value[0] === PACKED_CREATED_IDENTITY_MARKER
    && value.every((entry) => typeof entry === "string");
}

function unpackCreatedIdentityAssignment(value: PackedCreatedIdentityAssignment): CandidateIdentityAssignmentTemplate {
  const [, workspaceId, identityType, identityKey, recordId, ownerArtifactId, ownerArtifactVersionId] = value;
  return {
    identity_assignment_id: digest({ record_id: recordId, identity_key: identityKey }),
    workspace_id: workspaceId,
    identity_type: identityType,
    identity_id: `${identityType}:${digest({ identity_key: identityKey }).slice("sha256:".length)}`,
    assignment_kind: "created",
    identity_key: identityKey,
    identity_key_digest: digest(identityKey),
    record_id: recordId,
    owner_artifact_id: ownerArtifactId,
    owner_artifact_version_id: ownerArtifactVersionId,
  };
}

function isPackedCandidateTemplate(value: unknown): boolean {
  return isPackedCreatedIdentityAssignment(value)
    || value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["canonical_template"] === "string";
}

function packedTemplateValue(value: unknown): unknown {
  if (isPackedCreatedIdentityAssignment(value)) return unpackCreatedIdentityAssignment(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)["canonical_template"] === "string") {
    return JSON.parse((value as PackedCandidateTemplate).canonical_template);
  }
  return value;
}

function digestTemplateArray(entries: readonly unknown[]): string {
  return digestMappedCanonicalArray(entries, "urdira:candidate-template-logical-value:v2", packedTemplateValue);
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
// the active publication call; durable recovery replays confirmed FactDelta batches.
export interface CandidateMaterializerOptions {}

type RetainedProposedRecord = ProposedRecord | MaterializationProposedRecord;

function isMaterializationProposedRecord(record: RetainedProposedRecord): record is MaterializationProposedRecord {
  return "canonical_record" in record;
}

const recordDigestMemo = new WeakMap<RetainedProposedRecord, string>();

function decodeMaterializationRecord(record: RetainedProposedRecord): ProposedRecord {
  return isMaterializationProposedRecord(record) ? JSON.parse(record.canonical_record) as ProposedRecord : record;
}

function recordDigest(record: RetainedProposedRecord): string {
  // Compacted production records are visited exactly once on the first-open
  // path. Retaining one WeakMap entry per record therefore buys no reuse and
  // keeps the million-record VS Code candidate live through sealing. Generic
  // providers can revisit full ProposedRecord objects during replacement and
  // closure handling, so keep memoization for that compatibility path.
  if (isMaterializationProposedRecord(record)) return digest(decodeMaterializationRecord(record));
  const cached = recordDigestMemo.get(record);
  if (cached !== undefined) return cached;
  const value = digest(decodeMaterializationRecord(record));
  recordDigestMemo.set(record, value);
  return value;
}

function causes(ownerArtifactId: string): readonly ChangeCauseReference[] {
  return [{ cause_type: "artifact", cause_id: ownerArtifactId }];
}

const scopedRecordsMemo = new WeakMap<object, RetainedProposedRecord[]>();

function scopeRecords(input: CandidateMaterializationInput): RetainedProposedRecord[] {
  const cached = scopedRecordsMemo.get(input as object);
  if (cached !== undefined) return cached;
  const records: RetainedProposedRecord[] = [];
  for (const delta of input.accepted_deltas) for (const set of delta.replacement_sets) for (const record of set.records) records.push(record);
  const sortedRecords = sorted(records, (record) => record.proposal_record_key);
  scopedRecordsMemo.set(input as object, sortedRecords);
  return sortedRecords;
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
  // Compacted production records promote their owner alongside the canonical
  // record string. Do not rebuild a million-entry proposal->owner Map at
  // seal; generic providers retaining full ProposedRecord objects continue
  // to use this compatibility index.
  for (const delta of input.accepted_deltas) for (const set of delta.replacement_sets) for (const record of set.records) {
    if (isMaterializationProposedRecord(record)) continue;
    owners.set(record.proposal_record_key, { owner_artifact_id: set.scope.owner_artifact_id, owner_artifact_version_id: set.scope.owner_artifact_version_id });
  }
  return owners;
}

function retainedRecordOwner(record: RetainedProposedRecord, owners: ReadonlyMap<string, RecordOwner>): RecordOwner | undefined {
  return isMaterializationProposedRecord(record)
    ? { owner_artifact_id: record.owner_artifact_id, owner_artifact_version_id: record.owner_artifact_version_id }
    : owners.get(record.proposal_record_key);
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
  /** 3c: id/digest of every pushed open, keyed by that exact template object. */
  readonly record_open_memo: ReadonlyMap<CandidateRecordOpenTemplate, CandidateRecordOpenMemoEntry>;
} {
  const recordOpenMemo = new Map<CandidateRecordOpenTemplate, CandidateRecordOpenMemoEntry>();
  const desired = scopeRecords(input);
  const workspaceId = input.candidate.workspace_id;
  const noPriorRecordAuthority = input.base_records.length === 0
    && (input.global_identity_records?.length ?? 0) === 0
    && (input.absence_barriers?.length ?? 0) === 0;
  if (noPriorRecordAuthority && desired.every(isMaterializationProposedRecord)) {
    const dependencyProposalKeys = new Set<string>();
    for (const accepted of input.accepted_deltas) for (const dependency of accepted.delta.proposed_dependencies ?? []) dependencyProposalKeys.add(dependency.proposal_record_key);
    const retainEveryProposalId = (input.record_dependencies?.length ?? 0) > 0
      || (input.lookup_bindings?.length ?? 0) > 0
      || (input.projection_dependencies?.length ?? 0) > 0;
    const opens: CandidateRecordOpenTemplate[] = [];
    const identities: CandidateIdentityAssignmentTemplate[] = [];
    const packIdentities = desired.length >= PACKED_IDENTITY_THRESHOLD;
    const proposalRecordIds = new Map<string, string>();
    for (const record of desired) {
      const owner = retainedRecordOwner(record, owners)!;
      const identityType = identityTypeForCategory(record.category) ?? "entity";
      const recordContentDigest = recordDigest(record);
      const recordId = `record:${recordContentDigest.slice("sha256:".length)}`;
      if (retainEveryProposalId || dependencyProposalKeys.has(record.proposal_record_key)) proposalRecordIds.set(record.proposal_record_key, recordId);
      const openTemplate = { record_without_validity: record.canonical_record, open_reason_code: "core:record_created", owner_artifact_id: owner.owner_artifact_id, owner_artifact_version_id: owner.owner_artifact_version_id, cause_references: causes(owner.owner_artifact_id), record_id_hint: recordId, record_digest_hint: recordContentDigest } as CandidateRecordOpenTemplate;
      opens.push(openTemplate);
      recordOpenMemo.set(openTemplate, { recordId, recordDigest: recordContentDigest });
      if (packIdentities) {
        identities.push([
          PACKED_CREATED_IDENTITY_MARKER,
          workspaceId,
          identityType,
          record.identity_key,
          recordId,
          owner.owner_artifact_id,
          owner.owner_artifact_version_id,
        ] as unknown as CandidateIdentityAssignmentTemplate);
      } else {
        identities.push({
          identity_assignment_id: digest({ record_id: recordId, identity_key: record.identity_key }),
          workspace_id: workspaceId,
          identity_type: identityType,
          identity_id: `${identityType}:${digest({ identity_key: record.identity_key }).slice("sha256:".length)}`,
          assignment_kind: "created",
          identity_key: record.identity_key,
          identity_key_digest: digest(record.identity_key),
          record_id: recordId,
          owner_artifact_id: owner.owner_artifact_id,
          owner_artifact_version_id: owner.owner_artifact_version_id,
        });
      }
    }
    return {
      reused: [],
      opens: sortOwned(opens, (entry) => String((entry as unknown as Record<string, unknown>)["record_id_hint"] ?? entry.record_without_validity)),
      closures: [],
      identities: packIdentities ? identities : sortOwned(identities, (entry) => entry.identity_assignment_id),
      proposal_record_ids: proposalRecordIds,
      record_open_memo: recordOpenMemo,
    };
  }
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
  const desiredByKey = new Map<string, RetainedProposedRecord>();
  for (const record of desired) if (!desiredByKey.has(record.identity_key)) desiredByKey.set(record.identity_key, record);
  const reused: string[] = [];
  const opens: CandidateRecordOpenTemplate[] = [];
  const closures: CandidateRecordClosureTemplate[] = [];
  const identities: CandidateIdentityAssignmentTemplate[] = [];
  const replacementIds = new Map<string, string>();
  const proposalRecordIds = new Map<string, string>();
  const migrationPredecessors = new Map<string, BaseCandidateRecord>();

  for (const record of desired) {
    const owner = retainedRecordOwner(record, owners)!;
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
    const decodedRecord = decodeMaterializationRecord(record);
    const digestInput = hasSalt ? { record: decodedRecord, ...salt } : decodedRecord;
    const newRecordDigest = digest(digestInput);
    const newRecordId = `record:${newRecordDigest.slice("sha256:".length)}`;
    proposalRecordIds.set(record.proposal_record_key, newRecordId);
    replacementIds.set(record.identity_key, newRecordId);
    // `record_without_validity` carries the canonical JSON of exactly the digest
    // input above, so storage (`memoizeRecordOpens`, publication-authority.ts)
    // re-derives the identical id byte-for-byte from the template alone.
    const openTemplate = { record_without_validity: hasSalt ? canonicalJson(digestInput) : isMaterializationProposedRecord(record) ? record.canonical_record : canonicalJson(record), open_reason_code: previous === undefined ? "core:record_created" : "core:record_replaced", ...(previous === undefined ? {} : { previous_record_id: previous.record_id }), owner_artifact_id: owner.owner_artifact_id, owner_artifact_version_id: owner.owner_artifact_version_id, cause_references: causes(owner.owner_artifact_id), record_id_hint: newRecordId, record_digest_hint: newRecordDigest } as CandidateRecordOpenTemplate;
    opens.push(openTemplate);
    recordOpenMemo.set(openTemplate, { recordId: newRecordId, recordDigest: newRecordDigest });
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
      const desiredOwner = desiredRecord === undefined ? undefined : retainedRecordOwner(desiredRecord, owners);
      if (desiredRecord !== undefined && desiredOwner?.owner_artifact_id === previous.owner_artifact_id && previous.record_digest === recordDigest(desiredRecord)) continue;
      const replacement = previous.identity_key === undefined ? undefined : replacementIds.get(previous.identity_key);
      closures.push({ record_id: previous.record_id, workspace_id: previous.workspace_id, owner_artifact_id: previous.owner_artifact_id, owner_artifact_version_id: previous.owner_artifact_version_id, category: previous.category, kind: previous.kind, universal_kind: previous.universal_kind, closure_reason_code: "core:record_replaced", ...(replacement === undefined ? {} : { replacement_record_id: replacement }), cause_references: [{ cause_type: "artifact", cause_id: previous.owner_artifact_id }] });
    } else {
      closures.push({ record_id: previous.record_id, workspace_id: previous.workspace_id, owner_artifact_id: previous.owner_artifact_id, owner_artifact_version_id: previous.owner_artifact_version_id, category: previous.category, kind: previous.kind, universal_kind: previous.universal_kind, closure_reason_code: "core:record_removed", cause_references: [{ cause_type: "artifact", cause_id: previous.owner_artifact_id }] });
    }
  }

  return { reused: sorted(reused, (entry) => entry), opens: sorted(opens, (entry) => String((entry as unknown as Record<string, unknown>)["record_id_hint"] ?? entry.record_without_validity)), closures: sorted(closures, (entry) => entry.record_id), identities: sorted(identities, (entry) => entry.identity_assignment_id), proposal_record_ids: proposalRecordIds, record_open_memo: recordOpenMemo };
}

function projectionTemplates(input: CandidateMaterializationInput): { readonly opens: readonly CandidateProjectionOpenTemplate[]; readonly closures: readonly CandidateProjectionClosureTemplate[]; readonly reused: readonly string[] } {
  // There is no projection authority to validate or reconcile on a genuine
  // projection-free stage. Returning before constructing `allowedRecords`
  // avoids a million-entry Set of proposal keys during JS/TS stage 1, whose
  // registry contributes records only. Any base or proposed projection keeps
  // the full validation/replacement path below.
  if (input.accepted_projection_sets.length === 0 && input.base_projections.length === 0) {
    return { opens: freeze([]), closures: freeze([]), reused: freeze([]) };
  }
  const opens: CandidateProjectionOpenTemplate[] = [];
  const closures: CandidateProjectionClosureTemplate[] = [];
  const reused: string[] = [];
  const current = new Map<string, CandidateProjectionTemplate>();
  const projectionIds = new Set<string>();
  const projectionKeys = new Set<string>();
  const allowedArtifactVersions = new Set(input.known_artifact_versions.map((entry) => entry.artifact_version_id));
  const allowedRecords = new Set<string>(input.base_records.map((record) => record.record_id));
  for (const record of scopeRecords(input)) allowedRecords.add(record.proposal_record_key);
  for (const delta of input.accepted_deltas) for (const record of delta.validated_staged_records) {
    allowedRecords.add(record.staged_record_id);
    allowedRecords.add(record.proposal_record_key);
  }
  for (const dependency of input.record_dependencies ?? []) allowedRecords.add(dependency.record_id);
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
    // The worker payload may contain a large replacement set. Hash its
    // canonical array incrementally so validation never builds one aggregate
    // encoding merely to recompute the declared digest.
    const expectedDigest = digestCanonicalArray(set.projections);
    const logicalDigest = new LogicalDigestWriter("urdira:projection-set:v3").value(set.projections).digest();
    if (set.projection_set_digest !== expectedDigest && set.projection_set_digest !== logicalDigest) throw new CandidateMaterializationError("core:projection_digest_mismatch", "Projection replacement set digest does not match its canonical or logical projections.", { expected_digest: logicalDigest, legacy_expected_digest: expectedDigest, actual_digest: set.projection_set_digest });
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
  const dependencyProposalKeys = new Set<string>();
  for (const accepted of input.accepted_deltas) for (const dependency of accepted.delta.proposed_dependencies ?? []) dependencyProposalKeys.add(dependency.proposal_record_key);
  const requiresCompleteRecordAuthority = (input.record_dependencies?.length ?? 0) > 0
    || (input.lookup_bindings?.length ?? 0) > 0
    || (input.projection_dependencies?.length ?? 0) > 0;
  const proposedRecords = new Map<string, RetainedProposedRecord>();
  for (const record of scopeRecords(input)) if (requiresCompleteRecordAuthority || dependencyProposalKeys.has(record.proposal_record_key)) proposedRecords.set(record.proposal_record_key, record);
  const proposedRecordsByFinalId = new Map<string, RetainedProposedRecord>();
  for (const [proposalKey, recordId] of proposalRecordIds) {
    const record = proposedRecords.get(proposalKey);
    if (record !== undefined) proposedRecordsByFinalId.set(recordId, record);
  }
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
    const owner = proposed === undefined ? undefined : retainedRecordOwner(proposed, owners);
    return owner === undefined ? undefined : { workspace_id: workspaceId, ...owner };
  };
  const knownRecords = new Set<string>(baseRecords.keys());
  for (const proposalKey of proposedRecords.keys()) knownRecords.add(proposalKey);
  for (const recordId of proposedRecordsByFinalId.keys()) knownRecords.add(recordId);
  // Full staged-record visibility is required only for externally supplied
  // record/lookup/projection bindings. Promoted analyzer dependencies refer to
  // `dependencyProposalKeys`, already retained above. Expanding every staged
  // record here on a first scan otherwise creates a second million-entry Set
  // after record sealing, with no validation consumer.
  if (requiresCompleteRecordAuthority) for (const delta of input.accepted_deltas) for (const entry of delta.validated_staged_records) {
    knownRecords.add(entry.staged_record_id);
    knownRecords.add(entry.proposal_record_key);
  }
  const knownArtifacts = new Map<string, CandidateKnownArtifactVersion>();
  const addArtifact = (entry: CandidateKnownArtifactVersion): void => {
    const raw = entry as unknown as Record<string, unknown>;
    if (!exactBindingKeys(raw, ["artifact_id", "artifact_version_id", "content_digest"]) || !nonEmptyString(entry.artifact_id) || !nonEmptyString(entry.artifact_version_id) || !digestString(entry.content_digest)) candidateMaterializationError("Artifact authority identity or content digest is invalid.", { dependency_failure_kind: "artifact_authority_invalid", dependency_artifact_version_id: entry.artifact_version_id });
    if (knownArtifacts.has(entry.artifact_version_id)) candidateMaterializationError("Artifact version identity is duplicated.", { dependency_artifact_version_id: entry.artifact_version_id });
    knownArtifacts.set(entry.artifact_version_id, entry);
  };
  for (const entry of input.known_artifact_versions) addArtifact(entry);
  const knownProjections = new Set<string>(input.base_projections.map((projection) => projection.projection_record_id));
  for (const set of input.accepted_projection_sets) for (const projection of set.projections) knownProjections.add(projection.projection_record_id);
  const roles = new Set(input.known_dependency_roles ?? ["references"]);
  const dependencies: CandidateRecordDependencyTemplate[] = [];
  const dependencyIds = new Set<string>();
  const promotedDependencies: RecordArtifactDependency[] = [];
  for (const accepted of input.accepted_deltas) for (const dependency of accepted.delta.proposed_dependencies ?? []) {
    const recordId = proposalRecordIds.get(dependency.proposal_record_key);
    const proposed = proposedRecords.get(dependency.proposal_record_key);
    const owner = proposed === undefined ? undefined : retainedRecordOwner(proposed, owners);
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
    promotedDependencies.push({
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
    });
  }
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

function semanticAcceptedDeltaDigest(delta: MaterializationAcceptedFactDelta): string {
  return digestCanonicalMapWithArrayFields({}, {
    replacement_sets: delta.replacement_sets.map((set) => ({
      scope: set.scope,
      record_set_digest: set.record_set_digest,
      record_count: set.records.length,
    })),
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
  const contentDigest = entries.some(isPackedCandidateTemplate)
    ? digestTemplateArray(entries)
    : digestCanonicalArray(entries);
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

interface FastPathIdentityRaw {
  readonly identityType: "entity" | "relation" | "diagnostic";
  readonly identityKey: string;
  readonly recordId: string;
  readonly ownerArtifactId: string;
  readonly ownerArtifactVersionId: string;
  /** Carried only to reproduce `desired`'s global proposal_record_key order at finish() (see below). */
  readonly proposalRecordKey: string;
}

/**
 * (3a) Additive, incremental twin of `recordTemplates`'s "no prior record
 * authority" fast branch (the one-shot path stays completely unchanged and
 * is still what every other caller -- and `seal()` itself, when this isn't
 * supplied or doesn't apply -- goes through). Eligible ONLY for a candidate
 * with zero base/global-identity/absence-barrier authority (a genuine first
 * scan: `workspace-indexing-session.ts` only ever constructs one when
 * `currentState === undefined`, which is exactly when those three are
 * guaranteed empty without waiting for the DB reads that confirm it) and
 * whose records are all the compacted `MaterializationProposedRecord` shape.
 * `accept()` is called once per accepted delta as the delta arrives (during
 * the analysis/acceptance loop, overlapping with that loop's own I/O awaits)
 * instead of once for the whole candidate at the end, so the dominant
 * per-record cost -- `recordDigest`'s canonical-encode-and-hash of the
 * record body -- lands on the main thread while other awaited work is in
 * flight, rather than as one 60+ second blocking tail.
 *
 * DETERMINISM: per-record output (open template, identity raw fields,
 * proposal-id entry) depends only on that record and its own delta/scope --
 * never on any other delta -- so accepting deltas one at a time or all at
 * once produces the identical unordered result set. The one order-sensitive
 * piece is packed identity tuples, which `recordTemplates` never re-sorts
 * because it relies on `desired` (all records, globally sorted by
 * `proposal_record_key`) already being in that order before its loop runs;
 * `finish()` reproduces that exact order with an explicit sort keyed by
 * `proposalRecordKey`, so insertion order during accumulation is irrelevant.
 * `dependencyProposalKeys` is computed per accepted delta (not globally, as
 * `recordTemplates` does) -- safe because `fact-delta.ts`'s own acceptance
 * validation already guarantees a delta's `proposed_dependencies` only ever
 * reference that same delta's own `proposal_record_key`s (see
 * `validateAcceptedFactDelta`'s "not locally resolvable" check), so the
 * global and per-delta sets agree on every key that could possibly matter.
 */
export class CandidateRecordTemplateAccumulator {
  private readonly workspaceId: string;
  private readonly retainEveryProposalId: boolean;
  private disqualified = false;
  private readonly acceptedDeltas: MaterializationAcceptedFactDelta[] = [];
  private readonly opens: CandidateRecordOpenTemplate[] = [];
  private readonly identityRaw: FastPathIdentityRaw[] = [];
  private readonly proposalRecordIds = new Map<string, string>();
  private readonly recordOpenMemo = new Map<CandidateRecordOpenTemplate, CandidateRecordOpenMemoEntry>();

  constructor(workspaceId: string, retainEveryProposalId: boolean) {
    this.workspaceId = workspaceId;
    this.retainEveryProposalId = retainEveryProposalId;
  }

  get isDisqualified(): boolean { return this.disqualified; }
  get acceptedDeltaCount(): number { return this.acceptedDeltas.length; }

  /**
   * Whether this accumulator's accepted deltas are exactly `deltas`, as a
   * set of object references -- order-independent, since `finish()` below
   * never relies on acceptance order (every order-sensitive output is
   * explicitly re-sorted there). This lets the caller feed deltas in
   * whatever order they naturally become available (e.g. interleaved with
   * native-batch acceptance) rather than `input.accepted_deltas`'s own order.
   */
  matchesAcceptedDeltas(deltas: readonly MaterializationAcceptedFactDelta[]): boolean {
    if (this.acceptedDeltas.length !== deltas.length) return false;
    const seen = new Set(this.acceptedDeltas);
    return seen.size === this.acceptedDeltas.length && deltas.every((delta) => seen.has(delta));
  }

  matchesRetainEveryProposalId(retainEveryProposalId: boolean): boolean {
    return this.retainEveryProposalId === retainEveryProposalId;
  }

  accept(delta: MaterializationAcceptedFactDelta): void {
    this.acceptedDeltas.push(delta);
    if (this.disqualified) return;
    const dependencyProposalKeys = this.retainEveryProposalId ? undefined : (() => {
      const keys = new Set<string>();
      for (const dependency of delta.delta.proposed_dependencies ?? []) keys.add(dependency.proposal_record_key);
      return keys;
    })();
    for (const set of delta.replacement_sets) {
      for (const record of set.records) {
        if (!isMaterializationProposedRecord(record)) {
          // A generic (non-compacted) ProposedRecord disqualifies the whole
          // candidate from this fast path, exactly like `desired.every(...)`
          // in `recordTemplates`. Discard partial work; `seal()` falls back
          // to the untouched general/one-shot path over the full input.
          this.disqualified = true;
          this.opens.length = 0;
          this.identityRaw.length = 0;
          this.proposalRecordIds.clear();
          this.recordOpenMemo.clear();
          return;
        }
        const identityType = identityTypeForCategory(record.category) ?? "entity";
        const recordContentDigest = recordDigest(record);
        const recordId = `record:${recordContentDigest.slice("sha256:".length)}`;
        if (this.retainEveryProposalId || dependencyProposalKeys!.has(record.proposal_record_key)) this.proposalRecordIds.set(record.proposal_record_key, recordId);
        const openTemplate = { record_without_validity: record.canonical_record, open_reason_code: "core:record_created", owner_artifact_id: record.owner_artifact_id, owner_artifact_version_id: record.owner_artifact_version_id, cause_references: causes(record.owner_artifact_id), record_id_hint: recordId, record_digest_hint: recordContentDigest } as CandidateRecordOpenTemplate;
        this.opens.push(openTemplate);
        this.recordOpenMemo.set(openTemplate, { recordId, recordDigest: recordContentDigest });
        this.identityRaw.push({ identityType, identityKey: record.identity_key, recordId, ownerArtifactId: record.owner_artifact_id, ownerArtifactVersionId: record.owner_artifact_version_id, proposalRecordKey: record.proposal_record_key });
      }
    }
  }

  /**
   * Sort, freeze, and (for a small candidate) compute the two identity
   * digests `recordTemplates`'s packed branch defers past the threshold --
   * the only work left for the final synchronous pass. Throws if called
   * while disqualified; callers must check `isDisqualified` first (`seal()`
   * does, via the eligibility check that also calls this).
   */
  finish(): { readonly reused: readonly string[]; readonly opens: readonly CandidateRecordOpenTemplate[]; readonly closures: readonly CandidateRecordClosureTemplate[]; readonly identities: readonly CandidateIdentityAssignmentTemplate[]; readonly proposal_record_ids: ReadonlyMap<string, string>; readonly record_open_memo: ReadonlyMap<CandidateRecordOpenTemplate, CandidateRecordOpenMemoEntry> } {
    if (this.disqualified) throw new CandidateMaterializationError("core:dependency_validation_failed", "CandidateRecordTemplateAccumulator.finish() called after disqualification.", {});
    const opens = sortOwned(this.opens, (entry) => String((entry as unknown as Record<string, unknown>)["record_id_hint"] ?? entry.record_without_validity));
    const packIdentities = this.identityRaw.length >= PACKED_IDENTITY_THRESHOLD;
    const identities: CandidateIdentityAssignmentTemplate[] = packIdentities
      ? sortOwned([...this.identityRaw], (entry) => entry.proposalRecordKey).map((raw) => ([
          PACKED_CREATED_IDENTITY_MARKER,
          this.workspaceId,
          raw.identityType,
          raw.identityKey,
          raw.recordId,
          raw.ownerArtifactId,
          raw.ownerArtifactVersionId,
        ] as unknown as CandidateIdentityAssignmentTemplate))
      : sortOwned(this.identityRaw.map((raw) => ({
          identity_assignment_id: digest({ record_id: raw.recordId, identity_key: raw.identityKey }),
          workspace_id: this.workspaceId,
          identity_type: raw.identityType,
          identity_id: `${raw.identityType}:${digest({ identity_key: raw.identityKey }).slice("sha256:".length)}`,
          assignment_kind: "created",
          identity_key: raw.identityKey,
          identity_key_digest: digest(raw.identityKey),
          record_id: raw.recordId,
          owner_artifact_id: raw.ownerArtifactId,
          owner_artifact_version_id: raw.ownerArtifactVersionId,
        }) as CandidateIdentityAssignmentTemplate), (entry) => entry.identity_assignment_id);
    return { reused: [], opens, closures: [], identities, proposal_record_ids: this.proposalRecordIds, record_open_memo: this.recordOpenMemo };
  }
}

export class CandidateMaterializer {
  constructor(_options: CandidateMaterializerOptions = {}) {}

  /**
   * `accumulator`: an optional, pre-fed `CandidateRecordTemplateAccumulator`
   * (3a) covering exactly `input.accepted_deltas`. Used only when it applies
   * cleanly (matching deltas, matching `retainEveryProposalId`, and `input`
   * itself has no base/global-identity/absence-barrier authority); otherwise
   * ignored and the untouched one-shot `recordTemplates` path runs, so a
   * mismatched or absent accumulator can never change the result, only the
   * cost of producing it.
   */
  seal(input: CandidateMaterializationInput, accumulator?: CandidateRecordTemplateAccumulator): SealedCandidateMaterialization {
    const owners = recordOwners(input);
    const retainEveryProposalId = (input.record_dependencies?.length ?? 0) > 0 || (input.lookup_bindings?.length ?? 0) > 0 || (input.projection_dependencies?.length ?? 0) > 0;
    const accumulatorEligible = accumulator !== undefined
      && !accumulator.isDisqualified
      && accumulator.matchesRetainEveryProposalId(retainEveryProposalId)
      && accumulator.matchesAcceptedDeltas(input.accepted_deltas)
      && input.base_records.length === 0
      && (input.global_identity_records?.length ?? 0) === 0
      && (input.absence_barriers?.length ?? 0) === 0;
    // `seal_finish`: the dominant per-record cost inside `seal()` -- either
    // the pre-fed accumulator's own `finish()` (3a's incremental-accept
    // path) or, when ineligible, the one-shot `recordTemplates` pass over
    // every accepted delta. Named separately from the outer `seal` bucket
    // (`workspace-indexing-session.ts`) so it's possible to tell whether a
    // slow seal is dominated by this record-templating work or by
    // everything seal() does afterward (bindings, projections, digesting).
    const records = timedSync("seal_finish", () => accumulatorEligible ? accumulator.finish() : recordTemplates(input, owners));
    // `seal_validate_bindings`: `validateBindings`'s own record/lookup/
    // projection-dependency validation -- including its unconditional
    // `scopeRecords(input)` walk (the first, and only, full sort of every
    // proposed record by `proposal_record_key` on the fast accumulator path,
    // since `accumulator.finish()`, above, never calls it).
    const bindings = timedSync("seal_validate_bindings", () => validateBindings(input, records.proposal_record_ids, owners));
    // `seal_projection_templates`: near-zero whenever a scan has no
    // projection authority to reconcile (the production JS/TS scan path
    // never populates `accepted_projection_sets`/`base_projections`), kept
    // as its own span so a registry that DOES use projections shows up
    // distinctly instead of being folded into `seal_validate_bindings` or
    // `seal_ordered_digests`.
    const projections = timedSync("seal_projection_templates", () => projectionTemplates(input));
    // `seal_freeze`: the deep-freeze pass over every produced template array.
    // `freeze` (above) is recursive over `Object.values`, which for an array
    // visits every element -- so `freeze(records.opens)`/`freeze(records.identities)`
    // (potentially one entry per record in the whole candidate) each walk
    // and freeze every open/identity-assignment object, not just the array
    // reference. Named separately so a slow seal that is dominated by this
    // recursive walk shows up distinctly from `seal_finish`'s
    // record-templating or `seal_ordered_digests`'s content hashing below.
    // `bindings.record_dependencies`/`bindings.lookup_bindings` are already
    // frozen by `validateBindings` itself, so freezing them again here is a
    // cheap `Object.isFrozen` no-op; included anyway so this bucket's total
    // matches every `freeze` call between `seal_finish` and the materialization
    // build, exactly as before this change.
    const recordDependencies = timedSync("seal_freeze", () => freeze(bindings.record_dependencies));
    const lookupBindings = timedSync("seal_freeze", () => freeze(bindings.lookup_bindings));
    const projectionDependencies = bindings.projection_dependencies;
    const lookupRevalidations: readonly Readonly<Record<string, unknown>>[] = timedSync("seal_freeze", () => freeze([]));
    // Freeze the exact transport arrays before computing their descriptors.
    // @urdira/canonical can then memoize the digest against the immutable
    // array identity, allowing publication to verify the same in-process
    // materialization without encoding a million-entry set a second time.
    const sourceTransitions = timedSync("seal_freeze", () => freeze([...input.source_plan.transitions]));
    const recordOpens = timedSync("seal_freeze", () => freeze(records.opens));
    const recordClosures = timedSync("seal_freeze", () => freeze(records.closures));
    const identityAssignments = timedSync("seal_freeze", () => freeze(records.identities));
    const barrierKeys = new Set((input.absence_barriers ?? []).map((entry) => `${entry.identity_type}\0${entry.identity_key}`));
    // `seal_ordered_digests`: building each template set's `OrderedSetDescriptor`
    // (`orderedSetDescriptor`, below -- an incremental `digestCanonicalArray`/
    // `digestMappedCanonicalArray` pass over every entry in that set) plus
    // this materialization's own top-level semantic digest. This is a
    // separate full-corpus content-hashing pass over the very same
    // (already-templated) records `seal_finish`/`seal_freeze` just built and
    // froze -- not record-templating or freezing work itself, but the digest
    // computation every one of those templates still needs before it can be
    // durably published.
    const semanticPayload = timedSync("seal_ordered_digests", () => ({
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
      record_open_template_set: canonicalJson(orderedSetDescriptor("core:CandidateRecordOpenTemplate", recordOpens)),
      record_closure_template_set: canonicalJson(orderedSetDescriptor("core:CandidateRecordClosureTemplate", recordClosures)),
      identity_assignment_template_set: canonicalJson(orderedSetDescriptor("core:CandidateIdentityAssignmentTemplate", identityAssignments)),
      projection_open_template_sets: projections.opens,
      projection_closure_template_sets: projections.closures,
      capability_state_entries: input.capability_state_entries,
      source_observation_watermarks: input.source_observation_watermarks,
      artifact_dependency_template_set: canonicalJson(orderedSetDescriptor("core:RecordArtifactDependency", recordDependencies)),
      lookup_dependency_template_set: canonicalJson(orderedSetDescriptor("core:PluginLookupInvalidationDependency", lookupBindings)),
      lookup_revalidation_template_set: canonicalJson(orderedSetDescriptor("core:LookupRevalidationTemplate", lookupRevalidations)),
    }));
    const semanticDigest = timedSync("seal_ordered_digests", () => digest({ ...semanticPayload, projection_dependencies: projectionDependencies }));
    const materialization = timedSync("seal_ordered_digests", () => freeze({
      candidate_materialization_id: `materialization:${semanticDigest.slice("sha256:".length)}`,
      ...semanticPayload,
      materialization_digest: semanticDigest,
    }));
    return freeze({ materialization, reused_record_ids: freeze(records.reused), source_transitions: sourceTransitions, record_opens: recordOpens, record_closures: recordClosures, identity_assignments: identityAssignments, record_dependencies: recordDependencies, lookup_bindings: lookupBindings, lookup_revalidations: lookupRevalidations, projection_dependencies: projectionDependencies, reused_projection_record_ids: projections.reused, absence_barrier_keys: [...barrierKeys].sort(), record_open_memo: records.record_open_memo });
  }
}

export type { CandidatePlan, ProjectionWorkItem };
