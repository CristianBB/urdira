import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalBytes, computeDigest, decodeCanonical, digestBytes, digestCanonicalArray, encodeCanonical } from "@urdira/canonical";
import {
  createDurableStorage,
  createFaultInjector,
  canonicalFrozenCandidateBaseTuple,
  frozenCandidateBaseTupleDigest,
  normalizeObservationBatchIds,
  projectionSetDigestEntries,
  sameFrozenCandidateBaseTuple,
  type CandidatePublicationInput,
  type CandidateTemplateSets,
  type FaultInjector,
  type SqliteDatabase,
  type SqliteValue,
  type WorkspaceDatabase,
} from "../packages/storage/src/index.js";
import { buildCandidatePublicationPlan, buildForkPublicationPlan, buildManifestDescriptors, buildPublicationPlan, buildPublicationTransactionCommands, checkedPublicationCommand, computeSnapshotDigestFields, jsonArray, manifestRow, publicationFaultCommand, rowMatches, sameBytes, snapshotDigest, sqliteValue, toBytes, translateCompatibilityPublication, type ProjectionSetDigestCorpusEntry, type RecordSetDigestCorpusEntry } from "../packages/storage/src/publication-authority.js";
import { compactPublicationPhase } from "../packages/storage/src/publication-compaction.js";

const workspace = {
  workspace_id: "ws-phase9-publication",
  canonical_root: "/phase9-publication",
  display_root: "/phase9-publication",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-10T00:00:00.000000000Z",
};

const now = "2026-08-10T00:00:00.000000000Z";
const digest = (value: unknown): string => computeDigest("test:phase9", "test:phase9", 1, "test:phase9", 1, value);

it("bounds compacted publication INSERT parameters below SQLite's variable limit", () => {
  const sql = `INSERT INTO artifact_dependencies (dependency_entry_id) VALUES (${Array.from({ length: 13 }, () => "?").join(",")}) ON CONFLICT(dependency_entry_id) DO NOTHING`;
  const commands = Array.from({ length: 3_001 }, (_, index) => [
    { kind: "transaction_checkpoint" as const },
    { kind: "run" as const, sql, params: Array.from({ length: 13 }, (_, parameter) => `dependency-${index}-${parameter}`) },
    { kind: "assert_transaction_changes" as const, expected: 1 },
  ]).flat();

  const compacted = compactPublicationPhase(commands);
  const runs = compacted.filter((command) => command.kind === "run");
  expect(runs.length).toBeGreaterThan(1);
  expect(runs.every((command) => (command.params?.length ?? 0) <= 30_000)).toBe(true);
});

type CandidateRepositoryShape = {
  acceptDelta(value: Record<string, unknown>): Promise<{ status: string }>;
};

// Mirrors `packages/engine/src/candidate-materialization.ts`'s `orderedSetDescriptor`:
// `CandidateMaterialization`'s template-set fields carry a small, bounded
// `OrderedSetDescriptor` (descriptor-as-text), not the template array itself.
function orderedSetDescriptorJson(elementType: string, entries: readonly unknown[]): string {
  const contentDigest = digestCanonicalArray(entries);
  return JSON.stringify({
    descriptor_id: `set:${contentDigest.slice("sha256:".length)}`,
    element_type: elementType,
    element_schema_version: "1",
    comparator_id: "core:lexicographic_uri",
    comparator_version: "1",
    entry_count: entries.length,
    content_digest: contentDigest,
  });
}

const emptyTemplateSets: CandidateTemplateSets = { source_transitions: [], record_opens: [], record_closures: [], identity_assignments: [], artifact_dependencies: [], lookup_dependencies: [], lookup_revalidations: [] };

const TEMPLATE_SET_ELEMENT_TYPES = {
  source_transitions: "core:CandidateSourceTransitionTemplate",
  record_opens: "core:CandidateRecordOpenTemplate",
  record_closures: "core:CandidateRecordClosureTemplate",
  identity_assignments: "core:CandidateIdentityAssignmentTemplate",
  artifact_dependencies: "core:RecordArtifactDependency",
  lookup_dependencies: "core:PluginLookupInvalidationDependency",
  lookup_revalidations: "core:LookupRevalidationTemplate",
} as const;

const TEMPLATE_SET_FIELD_NAMES = {
  source_transitions: "source_transition_template_set",
  record_opens: "record_open_template_set",
  record_closures: "record_closure_template_set",
  identity_assignments: "identity_assignment_template_set",
  artifact_dependencies: "artifact_dependency_template_set",
  lookup_dependencies: "lookup_dependency_template_set",
  lookup_revalidations: "lookup_revalidation_template_set",
} as const;

/**
 * Overrides one or more of a `CandidatePublicationInput`'s seven out-of-band
 * template arrays (`template_sets`), regenerating the matching
 * `OrderedSetDescriptor` text on `materialization` so the two stay
 * consistent -- `buildCandidatePublicationPlan` verifies each array against
 * its descriptor (`storage:template_set_mismatch` on any mismatch) before
 * using it. Entries are carried through exactly as given, including
 * deliberately malformed ones (`null`, `{}`, wrong-typed fields), since many
 * tests exist specifically to exercise the row-builders' defensive handling
 * of malformed template entries.
 */
function withTemplateSets(input: CandidatePublicationInput, overrides: Partial<CandidateTemplateSets>, materializationOverrides: Record<string, unknown> = {}): CandidatePublicationInput {
  const templateSets: CandidateTemplateSets = { ...emptyTemplateSets, ...input.template_sets, ...overrides };
  const materializationPatch: Record<string, unknown> = {};
  for (const key of Object.keys(TEMPLATE_SET_FIELD_NAMES) as (keyof CandidateTemplateSets)[]) {
    if (overrides[key] !== undefined) materializationPatch[TEMPLATE_SET_FIELD_NAMES[key]] = orderedSetDescriptorJson(TEMPLATE_SET_ELEMENT_TYPES[key], overrides[key]!);
  }
  return {
    ...input,
    materialization: { ...input.materialization, ...materializationPatch, ...materializationOverrides },
    template_sets: templateSets,
  } as CandidatePublicationInput;
}

function emptyMaterialization(id: string, workspaceId = workspace.workspace_id): Record<string, unknown> {
  return {
    candidate_materialization_id: id,
    workspace_id: workspaceId,
    accepted_fact_delta_digests: [],
    source_transition_template_set: orderedSetDescriptorJson("core:CandidateSourceTransitionTemplate", []),
    record_open_template_set: orderedSetDescriptorJson("core:CandidateRecordOpenTemplate", []),
    record_closure_template_set: orderedSetDescriptorJson("core:CandidateRecordClosureTemplate", []),
    identity_assignment_template_set: orderedSetDescriptorJson("core:CandidateIdentityAssignmentTemplate", []),
    projection_open_template_sets: [],
    projection_closure_template_sets: [],
    capability_state_entries: [],
    source_observation_watermarks: [],
    materialization_digest: digest(id),
  };
}

function targetObjects(suffix: string): {
  registry: Record<string, unknown>;
  lock: Record<string, unknown>;
  configuration: Record<string, unknown>;
  freshness: Record<string, unknown>;
} {
  const registryId = `registry-${suffix}`;
  const lockId = `lock-${suffix}`;
  const configurationId = `configuration-${suffix}`;
  const snapshotId = `snapshot-${suffix}`;
  return {
    registry: {
      registry_snapshot_id: registryId,
      registry_contract_version: "1",
      core_registry_digest: `core-${suffix}`,
      resolution_lock_id: lockId,
      namespace_bindings: [],
      registry_digest: digest(registryId),
    },
    lock: {
      resolution_lock_id: lockId,
      workspace_id: workspace.workspace_id,
      resolver_version: "1",
      resolved_plugins: [],
      lock_digest: digest(lockId),
      created_at: now,
    },
    configuration: {
      configuration_revision_id: configurationId,
      schema_version: 1,
      workspace_id: workspace.workspace_id,
      effective_configuration_schema_id: "core:configuration",
      effective_configuration_schema_version: 1,
      effective_configuration: new Uint8Array([1]),
      installation_policy_digest: digest("installation"),
      user_policy_digest: digest("user"),
      workspace_file_digest: digest("workspace"),
      administrative_override_digest: digest("admin"),
      analysis_configuration_digest: digest("analysis"),
      query_configuration_digest: digest("query"),
      resolved_embedding_binding_digests: [],
      created_at: now,
      reason_code: "test",
      revision_digest: digest(configurationId),
    },
    freshness: {
      freshness_checkpoint_id: `freshness-${suffix}`,
      workspace_id: workspace.workspace_id,
      snapshot_id: snapshotId,
      source_state_digest: `source-${suffix}`,
      provider_watermarks: "[]",
      verification_status: "complete",
      unavailable_artifact_ids: "[]",
      verified_at: now,
      checkpoint_digest: digest(`freshness-${suffix}`),
    },
  };
}

function publication(
  candidateId: string,
  suffix: string,
  base: { snapshot_id?: string; generation?: number; registry_snapshot_id?: string; resolution_lock_id?: string; configuration_revision_id?: string; source_state_digest: string; source_observation_batch_ids: readonly string[]; tuple_digest: string },
): CandidatePublicationInput {
  const targets = targetObjects(suffix);
  const targetSnapshotId = `snapshot-${suffix}`;
  return {
    candidate: {
      candidate_generation_id: candidateId,
      workspace_id: workspace.workspace_id,
      ...(base.snapshot_id === undefined ? {} : { base_snapshot_id: base.snapshot_id }),
      ...(base.generation === undefined ? {} : { base_generation: base.generation }),
      ...(base.registry_snapshot_id === undefined ? {} : { base_registry_snapshot_id: base.registry_snapshot_id }),
      target_registry_snapshot_id: targets.registry["registry_snapshot_id"] as string,
      ...(base.configuration_revision_id === undefined ? {} : { base_configuration_revision_id: base.configuration_revision_id }),
      target_configuration_revision_id: targets.configuration["configuration_revision_id"] as string,
      trigger_kind: "test",
      state: "ready",
      source_observation_batch_ids: [...base.source_observation_batch_ids],
      created_at: now,
      issue_ids: [],
    },
    frozen_base: base,
    materialization: emptyMaterialization(`materialization-${candidateId}`),
    template_sets: emptyTemplateSets,
    target_registry: targets.registry,
    target_resolution_lock: targets.lock,
    target_configuration: targets.configuration,
    freshness_checkpoint: { ...targets.freshness, snapshot_id: base.snapshot_id ?? targetSnapshotId, source_state_digest: base.source_state_digest },
    publication_kind: "incremental",
  } as unknown as CandidatePublicationInput;
}

it("builds fork snapshots both with and without optional v2 stage and capability metadata", () => {
  const targets = targetObjects("fork-plan-optionals");
  const base = {
    workspaceId: workspace.workspace_id,
    candidateId: "candidate-fork-plan-optionals",
    generation: 1,
    publishedAt: now,
    sourceStateDigest: digest("fork-source-state"),
    sourceObservationBatchIds: ["batch-b", "batch-a", "batch-a"],
    canonicalRecordSetDigest: digest("fork-canonical-records"),
    projectionSetDigests: "[]",
    recordOpenSetEntries: [],
    identityAssignmentSetEntries: [],
    targetRegistry: targets.registry,
    targetResolutionLock: targets.lock,
    targetConfiguration: targets.configuration,
    freshnessCheckpoint: targets.freshness,
  } as const;

  const withoutOptionals = buildForkPublicationPlan(base as never);
  const withoutSnapshotRun = withoutOptionals.snapshot.find((command) => command.kind === "run");
  const withoutSnapshot = decodeCanonical(withoutSnapshotRun?.params?.at(-1) as Uint8Array) as Record<string, unknown>;
  expect(withoutSnapshot).not.toHaveProperty("source_snapshot_id");
  expect(withoutSnapshot).not.toHaveProperty("publication_stage_id");
  expect(withoutSnapshot["capability_state_digest"]).toBe(digestCanonicalArray([]));

  const capabilityStateEntries = [{ capability_id: "capability:fork-plan", availability: "available" }];
  const withOptionals = buildForkPublicationPlan({
    ...base,
    candidateId: "candidate-fork-plan-optionals-v2",
    sourceSnapshotId: "source-snapshot:fork-plan",
    publicationStageId: "jsts:structural_stage_1",
    publicationStageOrdinal: 1,
    publicationStageCount: 3,
    capabilityStateEntries,
  } as never);
  const withSnapshotRun = withOptionals.snapshot.find((command) => command.kind === "run");
  const withSnapshot = decodeCanonical(withSnapshotRun?.params?.at(-1) as Uint8Array) as Record<string, unknown>;
  expect(withSnapshot).toMatchObject({
    source_snapshot_id: "source-snapshot:fork-plan",
    snapshot_contract_version: 2,
    publication_stage_id: "jsts:structural_stage_1",
    publication_stage_ordinal: 1,
    publication_stage_count: 3,
  });
  expect(withOptionals.targetControls.length).toBeGreaterThan(withoutOptionals.targetControls.length);
});

async function withWorkspace(test: (workspaceDatabase: WorkspaceDatabase) => Promise<void>, fault?: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-phase9-publication-"));
  const storage = fault === undefined ? await createDurableStorage({ rootDir: root }) : await createDurableStorage({ rootDir: root, fault_injector: createFaultInjector([fault as never]) });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    try { await test(opened); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function publishStoredCandidate(opened: WorkspaceDatabase, input: CandidatePublicationInput): Promise<Awaited<ReturnType<WorkspaceDatabase["publishCandidate"]>>> {
  await opened.candidates.insert(input.candidate, input.frozen_base);
  return await opened.publishCandidate(input);
}

const publicationRowTables = [
  "registry_snapshots", "control_plane_state", "artifact_versions", "artifact_tombstones", "record_occurrences",
  "identity_assignments", "artifact_dependencies", "candidate_lookup_dependencies", "projection_occurrences",
  "projection_occurrence_dependencies", "candidate_materializations", "candidate_state", "generation_manifests",
  "snapshots", "candidate_publication_journal", "workspace_current_state",
] as const;

async function publicationRows(opened: WorkspaceDatabase): Promise<Record<string, readonly Record<string, unknown>[]>> {
  const result: Record<string, readonly Record<string, unknown>[]> = {};
  for (const table of publicationRowTables) result[table] = await opened.database.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
  return result;
}

const tupleDigest = (base: { snapshot_id?: string; generation?: number; registry_snapshot_id?: string; resolution_lock_id?: string; configuration_revision_id?: string; source_state_digest: string; source_observation_batch_ids: readonly string[] }): string => digestBytes(canonicalBytes({ ...base, source_observation_batch_ids: [...new Set(base.source_observation_batch_ids)].sort() }));
const initialBase = { source_state_digest: "source-initial", source_observation_batch_ids: [], tuple_digest: tupleDigest({ source_state_digest: "source-initial", source_observation_batch_ids: [] }) };

describe("Phase 9 durable candidate publication", () => {
  it("keeps both public publication paths on the authority-owned semantic SQL plan", async () => {
    const authoritySource = await readFile(new URL("../packages/storage/src/publication-authority.ts", import.meta.url), "utf8");
    const storageSource = await readFile(new URL("../packages/storage/src/storage.ts", import.meta.url), "utf8");
    expect(authoritySource).toContain("candidate_materializations");
    expect(authoritySource).toContain("generation_manifests");
    expect(authoritySource).toContain("candidate_publication_journal");
    expect(authoritySource).toContain("assertPublicationImmutableRows");
    expect(storageSource).not.toContain("INSERT INTO candidate_materializations");
    expect(storageSource).not.toContain("INSERT INTO generation_manifests");
    expect(storageSource).not.toContain("INSERT INTO candidate_publication_journal");
    expect(storageSource).not.toContain("assertPublicationImmutableRows");
  });

  it("builds both projection template encodings into the authority-owned candidate plan", async () => {
    const input = publication("candidate-authority-projection-shapes", "authority-projection-shapes", initialBase);
    const projection = {
      projection_record_id: "projection-authority-shapes",
      projection_kind: "generic",
      projection_key: "authority-projection-shapes",
      owner_artifact_id: "artifact",
      owner_artifact_version_id: "version",
      source_artifact_version_ids: [],
      source_record_ids: [],
      source_projection_record_ids: [],
      generator: "test",
      generator_version: "1",
      generator_configuration_digest: digest("projection-config"),
      payload: { value: 1 },
    };
    const materialization = {
      ...input.materialization,
      projection_open_template_sets: [JSON.stringify([projection]), { projection: JSON.stringify([projection]) }],
    };
    const plan = await buildCandidatePublicationPlan({
      input: { ...input, materialization } as unknown as CandidatePublicationInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    });
    expect(plan.projections.some((command) => command.kind === "run" && command.sql.includes("projection_occurrences"))).toBe(true);
  });

  it("covers every semantic publication template shape through the authority builder", async () => {
    const input = publication("candidate-authority-template-shapes", "authority-template-shapes", initialBase);
    const sourceTransition = {
      artifact_change: {
        artifact_change_id: "change-authority-shapes",
        previous_artifact_version_id: "previous-version",
        previous_tombstone_id: "previous-tombstone",
      },
      target_artifact_version_without_generation: {
        artifact_version_id: "version-authority-shapes",
        artifact_id: "artifact-authority-shapes",
        content_blob_id: new Uint8Array([1, 2, 3]),
        content_hash: "hash-authority-shapes",
        byte_length: 1,
        encoding: "utf8",
        language_hint: null,
        analysis_metadata_digest: "metadata-authority-shapes",
        created_from_observation_id: "observation-authority-shapes",
      },
      target_artifact_tombstone_without_generation: {
        artifact_tombstone_id: "tombstone-authority-shapes",
        artifact_id: "artifact-authority-shapes",
        absence_kind: "deleted",
        absence_reason_code: "source_deleted",
        last_artifact_version_id: "previous-version",
        opening_artifact_change_id: "change-authority-shapes",
        // Unlike `ArtifactChange.cause_references` (a real array, see the
        // sibling `change` object elsewhere in this file), `ArtifactTombstone.cause_references`/
        // `.lineage_evidence_record_ids` (`packages/contracts/src/models.ts`)
        // are typed `string` -- already-JSON-encoded, matching what
        // `SourceCandidatePlanner.addAbsence` and stage-1 source cataloging
        // actually produce (`packages/engine/src/source-candidate-planning.ts`,
        // `packages/engine/src/source-indexer.ts`).
        cause_references: "[]",
        lineage_evidence_record_ids: "[]",
      },
    };
    const record = {
      category: "fact",
      kind: "authority-shape",
      universal_kind: "authority-shape",
      schema_version: 1,
      body: { value: 1 },
    };
    const projection = {
      projection_record_id: "projection-authority-shapes-complete",
      projection_kind: "generic",
      projection_key: "authority-shapes",
      owner_artifact_id: "artifact-authority-shapes",
      owner_artifact_version_id: "version-authority-shapes",
      source_artifact_version_ids: ["version-authority-shapes"],
      source_record_ids: ["record-authority-shapes"],
      source_projection_record_ids: ["projection-source-authority-shapes"],
      generator: "test",
      generator_version: "1",
      generator_configuration_digest: digest("projection-authority-shapes"),
      payload: { value: 1 },
    };
    const templatedInput = withTemplateSets(input, {
      source_transitions: [null, {}, sourceTransition, { target_artifact_tombstone_without_generation: { artifact_tombstone_id: "tombstone-authority-shapes-defaults", artifact_id: "artifact-authority-shapes", absence_kind: "deleted", absence_reason_code: "source_deleted", last_artifact_version_id: "previous-version", opening_artifact_change_id: "change-defaults" } }],
      record_opens: [null, {}, { record_without_validity: 1 }, { record_without_validity: JSON.stringify(record), owner_artifact_id: "artifact-authority-shapes", owner_artifact_version_id: "version-authority-shapes" }, { record_without_validity: JSON.stringify({ body: null }), owner_artifact_id: "artifact-authority-shapes", owner_artifact_version_id: "version-authority-shapes" }],
      record_closures: [null, {}, { record_id: "record-authority-shapes" }],
      identity_assignments: [null, {}, { identity_assignment_id: 1 }, { identity_assignment_id: "identity-authority-shapes", identity_type: "entity", identity_id: "entity-authority-shapes", identity_key: "key-authority-shapes", record_id: "record-authority-shapes" }, { identity_assignment_id: "identity-authority-shapes-full", identity_type: "entity", identity_id: "entity-authority-shapes-full", assignment_kind: "updated", identity_key: "key-authority-shapes-full", identity_key_digest: digest("key-authority-shapes-full"), record_id: "record-authority-shapes-full", previous_record_id: "record-authority-shapes", owner_artifact_id: "artifact-authority-shapes", owner_artifact_version_id: "version-authority-shapes" }],
      artifact_dependencies: [null, {}, { dependency_entry_id: 1 }, { dependency_entry_id: "dependency-authority-shapes", record_id: "record-authority-shapes" }, { dependency_entry_id: "dependency-authority-shapes-full", record_id: "record-authority-shapes", owner_artifact_id: "artifact-authority-shapes", owner_artifact_version_id: "version-authority-shapes", dependency_artifact_id: "dependency-artifact", dependency_artifact_version_id: "dependency-version", dependency_role: "import", producer_id: "producer", producer_version: "2" }],
      lookup_dependencies: [null, {}, { lookup_dependency_id: 1 }, { lookup_dependency_id: "lookup-authority-shapes" }, { lookup_dependency_id: "lookup-authority-shapes-full", consumer_type: "artifact", consumer_id: "consumer", owner_artifact_id: "artifact-authority-shapes", owner_artifact_version_id: "version-authority-shapes", operation: "resolve", normalized_selector_or_address: "selector-full", selector_digest: digest("selector-full"), previous_result_set_digest: digest("previous-full"), invalidation_scope: "workspace", dependency_digest: digest("dependency-full") }],
      lookup_revalidations: [null, {}, {}, { lookup_dependency_id: "lookup-authority-shapes" }],
    });
    const materialization = {
      ...templatedInput.materialization,
      projection_open_template_sets: [JSON.stringify([null, {}, { projection_record_id: 1 }, projection, { projection_record_id: "projection-authority-shapes-defaults" }]), { projection: JSON.stringify([{ ...projection, projection_record_id: "projection-authority-shapes-object" }]) }],
      projection_closure_template_sets: [{}, { projection_record_id: "projection-authority-shapes" }],
      capability_state_entries: [null, { capability_id: "capability-authority-shapes" }],
    };
    const plan = await buildCandidatePublicationPlan({
      input: { ...templatedInput, materialization } as unknown as CandidatePublicationInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    });
    expect(plan.source.length).toBeGreaterThan(2);
    expect(plan.canonical.length).toBeGreaterThan(10);
    expect(plan.projections.length).toBeGreaterThan(5);
    expect(plan.manifest).toHaveLength(3);
  });

  it("revalidates exact authoritative rows on a second authority-plan build", async () => {
    await withWorkspace(async (opened) => {
      const candidateId = "candidate-authority-exact-rows";
      const inputWithoutFreshnessOverride = publication(candidateId, "authority-exact-rows", initialBase);
      const input = {
        ...inputWithoutFreshnessOverride,
        freshness_checkpoint: { ...inputWithoutFreshnessOverride.freshness_checkpoint, snapshot_id: `snapshot:${candidateId}` },
      };
      await expect(publishStoredCandidate(opened, input)).resolves.toMatchObject({ generation: 1 });
      const published = await opened.database.get<{ published_at: string }>("SELECT published_at FROM generation_manifests WHERE generation_manifest_id = ?", [`generation-manifest:${candidateId}`]);
      const arrayBufferDatabase = {
        get: async <T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) => {
          const row = await opened.database.get<T>(sql, params);
          return row;
        },
        all: <T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) => opened.database.all<T>(sql, params),
      };
      const plan = await buildCandidatePublicationPlan({
        input,
        storedCandidate: { ...input.candidate, state: "published" } as never,
        workspaceId: workspace.workspace_id,
        database: arrayBufferDatabase as never,
        faults: createFaultInjector([]),
        generation: 1,
        publishedAt: published?.published_at ?? now,
      });
      expect(plan.mode).toBe("candidate");
    });
  });

  it("publishes v2 source and ordered structural stage coordinates", async () => {
    await withWorkspace(async (opened) => {
      const input = {
        ...publication("candidate-authority-stage-v2", "authority-stage-v2", initialBase),
        source_snapshot_id: "source-snapshot:1",
        publication_stage_id: "jsts:structural_stage_1",
        publication_stage_ordinal: 1,
        publication_stage_count: 3,
      } as unknown as CandidatePublicationInput;
      const published = await publishStoredCandidate(opened, input);
      const snapshot = await opened.repositories.snapshots.get(published.snapshot_id);
      expect(snapshot).toMatchObject({
        source_snapshot_id: "source-snapshot:1",
        snapshot_contract_version: 2,
        publication_stage_id: "jsts:structural_stage_1",
        publication_stage_ordinal: 1,
        publication_stage_count: 3,
      });
    });
  });

  it("covers authority scalar, byte, row, and template validation helpers", () => {
    expect(sqliteValue(null)).toBeNull();
    expect(sqliteValue("text")).toBe("text");
    expect(sqliteValue(1)).toBe(1);
    expect(sqliteValue(1n)).toBe(1n);
    expect(sqliteValue(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
    expect(sqliteValue({ value: 1 })).toEqual(encodeCanonical({ value: 1 }));
    expect(toBytes(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
    expect(toBytes(new Uint8Array([1]).buffer)).toEqual(new Uint8Array([1]));
    expect(() => toBytes("not-binary")).toThrowError(/non-binary/);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(rowMatches({ bytes: new Uint8Array([1]), text: "text", object: encodeCanonical({ value: 1 }) }, { bytes: new Uint8Array([1]), text: "text", object: { value: 1 } })).toBe(true);
    expect(rowMatches({ bytes: new Uint8Array([1]) }, { bytes: new Uint8Array([2]) })).toBe(false);
    expect(jsonArray([1, 2])).toEqual([1, 2]);
    expect(jsonArray("")).toEqual([]);
    expect(jsonArray("[]")).toEqual([]);
    expect(jsonArray("{}" as unknown)).toEqual([]);
    expect(() => jsonArray("{")).toThrowError(/template set/);
  });

  it("rejects a non-binary authoritative payload while validating the publication plan", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-authority-invalid-row", "authority-invalid-row", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const database = {
        get: async <T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) => {
          const row = await opened.database.get<T>(sql, params);
          if (sql.includes("registry_snapshots")) return {
            registry_snapshot_id: input.target_registry.registry_snapshot_id,
            workspace_id: workspace.workspace_id,
            registry_contract_version: input.target_registry.registry_contract_version,
            core_registry_digest: input.target_registry.core_registry_digest,
            resolution_lock_id: input.target_resolution_lock.resolution_lock_id,
            registry_digest: input.target_registry.registry_digest,
            registry_payload: "not-binary",
          } as unknown as T;
          return row;
        },
        all: <T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) => opened.database.all<T>(sql, params),
      };
      await expect(buildCandidatePublicationPlan({
        input,
        storedCandidate: input.candidate as never,
        workspaceId: workspace.workspace_id,
        database: database as never,
        faults: createFaultInjector([]),
        generation: 1,
        publishedAt: now,
      })).rejects.toMatchObject({ code: "storage:publication_conflict" });
    });
  });

  it.each(["artifact_versions", "artifact_tombstones"] as const)("maps a pre-existing %s mismatch to a typed authority conflict", async (table) => {
    const input = publication(`candidate-authority-${table}-conflict`, `authority-${table}-conflict`, initialBase);
    const sourceTransition = table === "artifact_versions"
      ? { target_artifact_version_without_generation: { artifact_version_id: "version-authority-conflict" } }
      : { target_artifact_tombstone_without_generation: { artifact_tombstone_id: "tombstone-authority-conflict" } };
    // The authority builder batches this existence check via `database.all`
    // (`fetchExistingRowsById`, `packages/storage/src/publication-authority.ts`)
    // instead of one `database.get` per entry, so the stub must return the
    // "existing" row tagged with the id column the batched lookup keys by.
    const idColumn = table === "artifact_versions" ? "artifact_version_id" : "artifact_tombstone_id";
    const idValue = table === "artifact_versions" ? "version-authority-conflict" : "tombstone-authority-conflict";
    const database = {
      get: async <T>() => undefined as T | undefined,
      // Match only the batched existence check's own "SELECT * FROM <table>"
      // shape, not any other query that happens to reference the same table
      // name with a narrower column list (e.g. `projectionSetDigestEntries`,
      // `packages/storage/src/lifecycle.ts`, reads `artifact_dependencies`
      // for an unrelated projection digest).
      all: async <T>(sql: string) => (sql.includes(`SELECT * FROM ${table} WHERE`) ? [{ [idColumn]: idValue }] as T[] : [] as T[]),
    };
    await expect(buildCandidatePublicationPlan({
      input: withTemplateSets(input, { source_transitions: [sourceTransition] }),
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  it("rejects a descriptor that does not match its supplied template array", async () => {
    const input = publication("candidate-authority-invalid-template", "authority-invalid-template", initialBase);
    await expect(buildCandidatePublicationPlan({
      input: { ...input, materialization: { ...input.materialization, record_open_template_set: "{" } } as CandidatePublicationInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:template_set_mismatch" });
  });

  it.each([
    ["artifact_versions", { source_transitions: [{ target_artifact_version_without_generation: { artifact_version_id: "version-authority-sparse" } }] }],
    ["artifact_tombstones", { source_transitions: [{ target_artifact_tombstone_without_generation: { artifact_tombstone_id: "tombstone-authority-sparse" } }] }],
    ["record_occurrences", { record_opens: [{ record_without_validity: JSON.stringify({ body: null }) }] }],
    ["identity_assignments", { identity_assignments: [{ identity_assignment_id: "identity-authority-sparse" }] }],
    ["projection_occurrences", {}],
    ["artifact_dependencies", { artifact_dependencies: [{ dependency_entry_id: "dependency-authority-sparse" }] }],
    ["candidate_lookup_dependencies", { lookup_dependencies: [{ lookup_dependency_id: "lookup-authority-sparse" }] }],
    ["lookup_revalidation", { lookup_revalidations: [{ lookup_dependency_id: "lookup-revalidation-authority-sparse" }] }],
  ] as const)("evaluates sparse authoritative %s rows before rejecting conflicts", async (table, templateSetOverrides) => {
    const input = publication(`candidate-authority-sparse-${table}`, `authority-sparse-${table}`, initialBase);
    const materializationPatch = table === "projection_occurrences" ? { projection_open_template_sets: [JSON.stringify([{ projection_record_id: "projection-authority-sparse" }])] } : {};
    // Same batched-existence-check adaptation as the mismatch test above: the
    // stub's `all` must return a row tagged with the exact id (and, for the
    // control-plane-state-backed `lookup_revalidation` case, the exact
    // composite `state_key`) the batched lookup will key its result by.
    const recordId = `record:${digestBytes(canonicalBytes({ body: null })).slice("sha256:".length)}`;
    const idColumnByTable: Record<string, string> = {
      artifact_versions: "artifact_version_id",
      artifact_tombstones: "artifact_tombstone_id",
      record_occurrences: "record_id",
      identity_assignments: "identity_assignment_id",
      projection_occurrences: "projection_record_id",
      artifact_dependencies: "dependency_entry_id",
      candidate_lookup_dependencies: "lookup_dependency_id",
      lookup_revalidation: "state_key",
    };
    const idValueByTable: Record<string, string> = {
      artifact_versions: "version-authority-sparse",
      artifact_tombstones: "tombstone-authority-sparse",
      record_occurrences: recordId,
      identity_assignments: "identity-authority-sparse",
      projection_occurrences: "projection-authority-sparse",
      artifact_dependencies: "dependency-authority-sparse",
      candidate_lookup_dependencies: "lookup-authority-sparse",
      lookup_revalidation: `lookup_revalidation:${input.candidate.candidate_generation_id}:lookup-revalidation-authority-sparse`,
    };
    const targetTable = table === "lookup_revalidation" ? "control_plane_state" : table;
    const idColumn = String(idColumnByTable[table]);
    const idValue = String(idValueByTable[table]);
    const database = {
      get: async <T>() => undefined as T | undefined,
      // Same "SELECT * FROM <table>" disambiguation as the mismatch test
      // above -- `artifact_dependencies` in particular is also read by
      // `projectionSetDigestEntries` (`packages/storage/src/lifecycle.ts`)
      // with a narrower column list for an unrelated projection digest.
      all: async <T>(sql: string) => (sql.includes(`SELECT * FROM ${targetTable} WHERE`) ? [{ [idColumn]: idValue }] as T[] : [] as T[]),
    };
    await expect(buildCandidatePublicationPlan({
      input: withTemplateSets(input, templateSetOverrides, materializationPatch),
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  // P0 regression, publish-assertion side: a `record_occurrences` row already
  // sitting under the exact `record_id` a fresh open computes, but which is a
  // CLOSED row (`valid_to_generation` set) opened in a strictly earlier
  // generation than this publish, is not this publish replaying its own
  // prior attempt -- it is a genuine id collision with someone ELSE's
  // history (the failure mode a missing/failed absence-barrier salt
  // produces, see `closedIdentitiesForOwners`,
  // `packages/storage/src/repositories.ts`). `assertPublicationImmutableRows`
  // (`publication-authority.ts`) must raise the distinct `storage:record_id_reuse`
  // code for this shape instead of the generic `storage:publication_conflict`
  // a resumed/ordinary replay divergence gets, so this class stays
  // diagnosable and is never silently treated as retry-safe.
  it("classifies a closed historical record_occurrences row as record_id_reuse, not a replay conflict", async () => {
    const input = publication("candidate-authority-closed-row-reuse", "authority-closed-row-reuse", initialBase);
    const recordId = `record:${digestBytes(canonicalBytes({ body: null })).slice("sha256:".length)}`;
    const database = {
      get: async <T>() => undefined as T | undefined,
      all: async <T>(sql: string) => (sql.includes("SELECT * FROM record_occurrences WHERE") ? [{
        record_id: recordId,
        workspace_id: workspace.workspace_id,
        category: "entity",
        kind: "test:symbol",
        universal_kind: "definition",
        schema_version: 1,
        producer_id: "candidate",
        producer_version: "1",
        owner_artifact_id: "artifact:owner",
        owner_artifact_version_id: "version:owner",
        // Closed two generations before this publish's own generation (5) --
        // the historical row this fresh open must never be mistaken for.
        valid_from_generation: 1,
        valid_to_generation: 3,
        record_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        payload_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        payload_byte_length: 0,
        payload_inline: new Uint8Array(),
        payload_cas_digest: null,
        record_payload: new Uint8Array(),
      }] as T[] : [] as T[]),
    };
    await expect(buildCandidatePublicationPlan({
      input: withTemplateSets(input, { record_opens: [{ record_without_validity: JSON.stringify({ body: null }), owner_artifact_id: "artifact:owner", owner_artifact_version_id: "version:owner" }] }),
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 5,
      publishedAt: now,
    })).rejects.toMatchObject({
      code: "storage:record_id_reuse",
      details: { table: "record_occurrences", row_id: recordId, closed_valid_from_generation: 1, closed_valid_to_generation: 3, publishing_generation: 5 },
    });
  });

  it("builds sparse command templates through every defaulting path", async () => {
    const input = publication("candidate-authority-sparse-commands", "authority-sparse-commands", initialBase);
    const templatedInput = withTemplateSets(input, {
      source_transitions: [
        { artifact_change: { artifact_change_id: null, previous_tombstone_id: "previous-tombstone" }, target_artifact_tombstone_without_generation: { artifact_tombstone_id: "tombstone-sparse-one", artifact_id: null, absence_kind: null, absence_reason_code: null, last_artifact_version_id: null } },
        { artifact_change: { artifact_change_id: "change-sparse" }, target_artifact_tombstone_without_generation: { artifact_tombstone_id: "tombstone-sparse-two", artifact_id: null, absence_kind: null, absence_reason_code: null, last_artifact_version_id: null } },
      ],
      identity_assignments: [{ identity_assignment_id: "identity-sparse-command" }],
      artifact_dependencies: [{ dependency_entry_id: "dependency-sparse-command" }],
      lookup_dependencies: [{ lookup_dependency_id: "lookup-sparse-command" }],
      lookup_revalidations: [{ lookup_dependency_id: "revalidation-sparse-command" }],
    });
    const materialization = {
      ...templatedInput.materialization,
      projection_open_template_sets: [JSON.stringify([{ projection_record_id: "projection-sparse-command" }])],
      projection_closure_template_sets: [{}, { projection_record_id: "projection-closure-sparse-command" }],
    };
    const plan = await buildCandidatePublicationPlan({
      input: { ...templatedInput, materialization } as unknown as CandidatePublicationInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    });
    expect(plan.source.length).toBeGreaterThan(0);
    expect(plan.canonical.length).toBeGreaterThan(0);
    expect(plan.projections.length).toBeGreaterThan(0);
  });

  it("rejects a mismatched pre-existing publication journal row", async () => {
    const input = publication("candidate-authority-journal-conflict", "authority-journal-conflict", initialBase);
    const database = {
      get: async () => undefined,
      all: async <T>(sql: string) => sql.includes("candidate_publication_journal") ? [{} as T] : [],
    };
    await expect(buildCandidatePublicationPlan({
      input,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  it("covers both projection dependency presence branches on an exact authoritative row", async () => {
    const input = publication("candidate-authority-projection-dependencies", "authority-projection-dependencies", initialBase);
    const projection = {
      projection_record_id: "projection-authority-dependencies",
      projection_kind: "generic",
      projection_key: "projection-authority-dependencies",
      owner_artifact_id: "artifact-authority-dependencies",
      owner_artifact_version_id: "version-authority-dependencies",
      source_artifact_version_ids: ["version-authority-dependencies"],
      source_record_ids: ["record-authority-dependencies"],
      source_projection_record_ids: ["projection-source-authority-dependencies"],
      generator: "test",
      generator_version: "1",
      generator_configuration_digest: digest("projection-authority-dependencies"),
      payload: { value: 1 },
    };
    const materialization = { ...input.materialization, projection_open_template_sets: [JSON.stringify([projection])] };
    const projectionRow = {
      projection_record_id: projection.projection_record_id,
      workspace_id: workspace.workspace_id,
      projection_kind: projection.projection_kind,
      projection_key: projection.projection_key,
      owner_artifact_id: projection.owner_artifact_id,
      owner_artifact_version_id: projection.owner_artifact_version_id,
      source_artifact_version_ids: JSON.stringify(projection.source_artifact_version_ids),
      source_record_ids: JSON.stringify(projection.source_record_ids),
      source_projection_record_ids: JSON.stringify(projection.source_projection_record_ids),
      generator: projection.generator,
      generator_version: projection.generator_version,
      generator_configuration_digest: projection.generator_configuration_digest,
      valid_from_generation: 1,
      valid_to_generation: null,
      content_digest: digestBytes(canonicalBytes(projection)),
      projection_payload: encodeCanonical(projection.payload),
    };
    const run = async (dependencyRow: Record<string, unknown> | undefined) => {
      // The authority builder batches both the top-level projection existence
      // check and the per-source-tuple dependency existence check via
      // `database.all` (`fetchExistingRowsById`/`fetchExistingProjectionDependencies`,
      // `packages/storage/src/publication-authority.ts`), keyed respectively
      // by `projection_record_id` and the compound
      // `projection_record_id/source_type/source_id` tuple. `dependencyRow`
      // undefined means "no existing dependency row for any source tuple";
      // `{}` means "an existing-but-mismatched row for every source tuple"
      // (matching the original per-tuple stub, which returned the same
      // `dependencyRow` regardless of which tuple was queried).
      const database = {
        get: async <T>() => undefined as T | undefined,
        all: async <T>(sql: string) => {
          if (sql.includes("SELECT * FROM projection_occurrence_dependencies WHERE")) {
            if (dependencyRow === undefined) return [] as T[];
            return [
              { projection_record_id: projection.projection_record_id, source_type: "artifact_version", source_id: "version-authority-dependencies", ...dependencyRow },
              { projection_record_id: projection.projection_record_id, source_type: "record", source_id: "record-authority-dependencies", ...dependencyRow },
              { projection_record_id: projection.projection_record_id, source_type: "projection", source_id: "projection-source-authority-dependencies", ...dependencyRow },
            ] as T[];
          }
          if (sql.includes("SELECT * FROM projection_occurrences WHERE")) return [projectionRow] as T[];
          return [] as T[];
        },
      };
      return buildCandidatePublicationPlan({
        input: { ...input, materialization } as unknown as CandidatePublicationInput,
        storedCandidate: input.candidate as never,
        workspaceId: workspace.workspace_id,
        database: database as never,
        faults: createFaultInjector([]),
        generation: 1,
        publishedAt: now,
      });
    };
    await expect(run(undefined)).resolves.toMatchObject({ mode: "candidate" });
    await expect(run({})).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  it("evaluates the explicit lookup dependency digest branch on an existing row", async () => {
    const input = publication("candidate-authority-lookup-digest", "authority-lookup-digest", initialBase);
    const templatedInput = withTemplateSets(input, { lookup_dependencies: [{ lookup_dependency_id: "lookup-authority-digest", dependency_digest: "explicit-digest" }] });
    const database = {
      get: async <T>() => undefined as T | undefined,
      all: async <T>(sql: string) => (sql.includes("SELECT * FROM candidate_lookup_dependencies WHERE") ? [{ lookup_dependency_id: "lookup-authority-digest" }] as T[] : [] as T[]),
    };
    await expect(buildCandidatePublicationPlan({
      input: templatedInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  it.each([
    ["plugin_resolution_lock", "plugin-resolution-authority-sparse", { resolution_lock_id: "plugin-resolution-authority-sparse" }],
    ["workspace_configuration_revision", "configuration-authority-sparse", { configuration_revision_id: "configuration-authority-sparse" }],
    ["workspace_freshness_checkpoint", "freshness-authority-sparse", { freshness_checkpoint_id: "freshness-authority-sparse" }],
  ] as const)("evaluates sparse immutable %s state before rejecting conflicts", async (stateKind, stateId, override) => {
    const input = publication(`candidate-authority-${stateKind}`, `authority-${stateKind}`, initialBase);
    const patched = stateKind === "plugin_resolution_lock"
      ? { target_resolution_lock: { ...input.target_resolution_lock, ...override } }
      : stateKind === "workspace_configuration_revision"
        ? { target_configuration: { ...input.target_configuration, ...override } }
        : { freshness_checkpoint: { ...input.freshness_checkpoint, ...override } };
    const key = `${stateKind}:${stateId}`;
    const database = {
      get: async <T>(sql: string, params?: readonly unknown[]) => sql.includes("control_plane_state") && params?.[1] === key ? {} as T : undefined,
      all: async <T>() => [] as T[],
    };
    await expect(buildCandidatePublicationPlan({
      input: { ...input, ...patched } as CandidatePublicationInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: database as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:publication_conflict" });
  });

  it("builds compatibility and candidate intents through the same typed semantic plan", () => {
    const run = (sql: string) => ({ kind: "run" as const, sql });
    const compatibility = buildPublicationPlan({
      mode: "compatibility",
      phases: {
        snapshot: () => [run("compatibility-snapshot")],
        current: () => [run("compatibility-current")],
      },
    });
    const candidate = buildPublicationPlan({
      mode: "candidate",
      phases: {
        candidateState: () => [run("candidate-state")],
        targetControls: () => [run("target-controls")],
        source: () => [run("source")],
        canonical: () => [run("canonical")],
        projections: () => [run("projections")],
        manifest: () => [run("manifest")],
        snapshot: () => [run("snapshot")],
        journal: () => [run("journal")],
        candidateFinalization: () => [run("candidate-finalization")],
        current: () => [run("current")],
      },
    });
    expect(buildPublicationTransactionCommands(compatibility).map((command) => (command as { sql: string }).sql)).toEqual([
      "compatibility-snapshot", "compatibility-current",
    ]);
    expect(buildPublicationTransactionCommands(candidate).map((command) => (command as { sql: string }).sql)).toEqual([
      "candidate-state", "target-controls", "source", "canonical", "projections", "manifest", "snapshot", "journal", "candidate-finalization", "current",
    ]);
    const candidateWithoutOptionalSnapshot = buildPublicationPlan({
      mode: "candidate",
      phases: {
        candidateState: () => [run("candidate-state")],
        journal: () => [run("journal")],
        current: () => [run("current")],
      },
    });
    expect(candidateWithoutOptionalSnapshot.snapshot).toEqual([]);
  });

  it("uses one semantic authority ordering for compatibility and candidate publications", () => {
    const run = (label: string) => ({ kind: "run" as const, sql: label });
    const empty = { candidateState: [], targetControls: [], source: [], canonical: [], projections: [], manifest: [], snapshot: [], journal: [], candidateFinalization: [], current: [] };
    const compatibility = buildPublicationTransactionCommands(translateCompatibilityPublication(run("snapshot"), [run("current")]) as never);
    const candidate = buildPublicationTransactionCommands({ mode: "candidate", ...empty, candidateState: [run("candidate")], targetControls: [run("target")], source: [run("source")], canonical: [run("canonical")], projections: [run("projection")], manifest: [run("manifest")], snapshot: [run("snapshot")], journal: [run("journal")], candidateFinalization: [run("final")], current: [run("current")] } as never);
    expect(checkedPublicationCommand(run("checked"))).toHaveLength(3);
    expect(publicationFaultCommand(createFaultInjector([]), "candidate_publication.before_begin")).toEqual([]);
    expect(publicationFaultCommand(createFaultInjector(["candidate_publication.before_begin"]), "candidate_publication.before_begin")).toHaveLength(1);
    expect(compatibility.map((command) => (command as { sql: string }).sql)).toEqual(["snapshot", "current"]);
    expect(candidate.map((command) => (command as { sql: string }).sql)).toEqual(["candidate", "target", "source", "canonical", "projection", "manifest", "snapshot", "journal", "final", "current"]);
    expect(() => buildPublicationTransactionCommands({ mode: "compatibility", ...empty, candidateState: [run("candidate")] } as never)).toThrow("Compatibility publication");
    expect(() => buildPublicationTransactionCommands({ mode: "candidate", ...empty, snapshot: [run("snapshot")] } as never)).toThrow("Candidate publication requires");
  });

  it("covers canonical candidate tuple normalization and digest identity", () => {
    expect(normalizeObservationBatchIds(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(canonicalFrozenCandidateBaseTuple(initialBase)).toEqual({ source_state_digest: "source-initial", source_observation_batch_ids: [] });
    const complete = { snapshot_id: "snapshot", generation: 1, registry_snapshot_id: "registry", resolution_lock_id: "lock", configuration_revision_id: "configuration", source_state_digest: "source", source_observation_batch_ids: ["batch"], tuple_digest: "" };
    const sealed = { ...complete, tuple_digest: frozenCandidateBaseTupleDigest(complete) };
    expect(sameFrozenCandidateBaseTuple(sealed, { ...sealed, source_observation_batch_ids: ["batch", "batch"] })).toBe(true);
    expect(sameFrozenCandidateBaseTuple(sealed, { ...sealed, tuple_digest: "sha256:wrong" })).toBe(false);
    try { normalizeObservationBatchIds([""]); throw new Error("expected invalid observation IDs"); } catch (error) { expect(error).toMatchObject({ code: "storage:publication_invalid" }); }
  });

  it("requires an owned ready candidate and never overwrites its immutable payload", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-integrity", "integrity", initialBase);
      await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:candidate_not_found" });
      await expect(opened.candidates.insert(input.candidate, input.frozen_base)).resolves.toBe("inserted");
      await expect(publishStoredCandidate(opened, { ...input, candidate: { ...input.candidate, trigger_kind: "tampered" } })).rejects.toMatchObject({ code: "storage:candidate_digest_conflict" });
      expect(await opened.candidates.get("candidate-integrity")).toMatchObject({ trigger_kind: "test", state: "ready" });
      await opened.candidates.transition("candidate-integrity", "ready", "failed");
      await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:candidate_state_conflict" });
    });
  });

  it("validates the frozen tuple digest before opening publication", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-tuple-digest", "tuple-digest", { ...initialBase, tuple_digest: digest("wrong-tuple") });
      await expect(opened.candidates.insert(input.candidate, input.frozen_base)).resolves.toBe("inserted");
      await expect(publishStoredCandidate(opened, input)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: 0 });
    });
  });

  it("rejects publication input that differs from the persisted frozen base", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-persisted-base", "persisted-base", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const changedBaseWithoutDigest = { ...initialBase, source_state_digest: "source-sealed-mismatch" };
      const changedBase = { ...changedBaseWithoutDigest, tuple_digest: tupleDigest(changedBaseWithoutDigest) };
      await expect(opened.publishCandidate({ ...input, frozen_base: changedBase })).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: 0 });
    });
  });

  it("publishes a materialization after it was persisted by the candidate repository", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-materialization-round-trip", "materialization-round-trip", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await expect(opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, input.materialization)).resolves.toBe("inserted");
      await expect(opened.publishCandidate(input)).resolves.toMatchObject({ status: "published", generation: 1 });
    });
  });

  // Regression test for a confirmed real-world bug: `CandidateMaterializer.seal()`
  // (`packages/engine/src/candidate-materialization.ts`) used to embed every newly
  // opened record's full body directly inside `CandidateMaterialization.record_open_template_set`,
  // one aggregate Text field holding every record of the *whole candidate*, which crashed
  // full-repo indexing. Phase 2 replaces that with a small `OrderedSetDescriptor` (see
  // `packages/engine/src/candidate-materialization.ts`'s `orderedSetDescriptor`) and
  // carries the real array out-of-band: `WorkspaceCandidateRepository.saveMaterialization`
  // (`packages/storage/src/candidates.ts`) now chunks it into bounded CAS-backed
  // segments (`candidate_template_segments`) instead of inlining it into the
  // materialization blob. This synthesizes a `record_opens` array whose aggregate text
  // (10,000,000+ characters across several records, each individually bounded) is exactly
  // the kind of aggregate that used to overflow a single canonical-encoding call, and
  // proves the segmented persist + `readTemplateSet` round trip is lossless.
  it("persists a large record-open template set as CAS-backed segments and reads it back losslessly", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-materialization-large-text", "materialization-large-text", initialBase);
      const bigBody = "x".repeat(500_000);
      const recordOpens = Array.from({ length: 20 }, (_, index) => ({ record_without_validity: JSON.stringify({ owner_artifact_id: "artifact-large-text", owner_artifact_version_id: "version-large-text", body: { index, text: bigBody } }), open_reason_code: "core:record_created", cause_references: [] }));
      const templateSets: CandidateTemplateSets = { ...emptyTemplateSets, record_opens: recordOpens };
      const materialization = { ...input.materialization, record_open_template_set: orderedSetDescriptorJson("core:CandidateRecordOpenTemplate", recordOpens) };
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await expect(opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, materialization as never, templateSets)).resolves.toBe("inserted");
      await expect(opened.candidates.getMaterialization(input.candidate.candidate_generation_id)).resolves.toMatchObject({ record_open_template_set: materialization.record_open_template_set });
      const roundTripped = await opened.candidates.readTemplateSet(materialization["candidate_materialization_id"] as string, "record_opens");
      expect(roundTripped).toEqual(recordOpens);
      const segmentCount = await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_template_segments WHERE candidate_materialization_id = ? AND set_kind = 'record_opens'", [materialization["candidate_materialization_id"]]);
      expect(segmentCount?.count).toBeGreaterThan(1); // Exercises the batched `putMany` persist path (Fix B) over more than one segment, not just a single-segment shortcut.
      // Re-saving is idempotent (regression for the batched `cas.putMany`
      // persist path replacing the old per-segment serial `cas.put` loop):
      // the second call must still return "already_present", write no
      // duplicate rows, and leave every row's bytes untouched.
      await expect(opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, materialization as never, templateSets)).resolves.toBe("already_present");
      const segmentCountAfterReplay = await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_template_segments WHERE candidate_materialization_id = ? AND set_kind = 'record_opens'", [materialization["candidate_materialization_id"]]);
      expect(segmentCountAfterReplay?.count).toBe(segmentCount?.count);
      const roundTrippedAfterReplay = await opened.candidates.readTemplateSet(materialization["candidate_materialization_id"] as string, "record_opens");
      expect(roundTrippedAfterReplay).toEqual(recordOpens);
    });
  });

  // Regression test for a second confirmed real-world bug found in the same
  // investigation: `assertPublicationImmutableRows` and its sibling command-building
  // logic (`packages/storage/src/publication-authority.ts`) used to independently
  // recompute `GenerationChangeManifest.manifest_digest` and
  // `Snapshot.canonical_record_set_digest` over the *parsed* `record_open_template_set`
  // text, carrying the identical aggregate per-record text as the materialization
  // itself. Phase 2's `buildCandidatePublicationPlan` instead takes the template arrays
  // directly from `CandidatePublicationInput.template_sets` (verified against each
  // field's small `OrderedSetDescriptor`, never parsed from a giant string), so this now
  // proves a large publication plan builds successfully using the `template_sets` input.
  it("builds a publication plan whose aggregate record text exceeds the old default per-field canonical text limit, via template_sets", async () => {
    const input = publication("candidate-authority-large-text", "authority-large-text", initialBase);
    // Each individual record stays comfortably under the (unwidened, default)
    // per-element `max_text_code_points` (4,000,000) -- the aggregate across all of them
    // (well over 5,000,000 characters) is what used to overflow the old giant single-field
    // digest computation. `digestCanonicalArray` (see `packages/canonical/src/digests.ts`)
    // hashes each element independently, so this aggregate is no longer a limit at all.
    const bigBody = "x".repeat(1_500_000);
    const records = [0, 1, 2, 3].map((index) => ({
      category: "fact",
      kind: "authority-large-text",
      universal_kind: "authority-large-text",
      schema_version: 1,
      body: { index, text: bigBody },
    }));
    const templatedInput = withTemplateSets(input, { record_opens: records.map((record) => ({ record_without_validity: JSON.stringify(record), owner_artifact_id: "artifact-authority-large-text", owner_artifact_version_id: "version-authority-large-text" })) });
    const plan = await buildCandidatePublicationPlan({
      input: templatedInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    });
    expect(plan.manifest).toHaveLength(3);
    expect(plan.canonical.some((command) => command.kind === "run" && command.sql.includes("record_occurrences"))).toBe(true);
  });

  // Regression test for the record-open fusion (`buildRecordOpens` in
  // `packages/storage/src/publication-authority.ts`): `memoizeRecordOpens`
  // (id/digest over the whole parsed `record_without_validity`) and
  // `recordOpenCommands` (the `record_occurrences` row, including a SECOND
  // independent re-encode+re-hash of the body for `payload_digest`) used to
  // be two separate passes. This recomputes every id/digest/row-byte field
  // using the OLD formula's primitives directly (`JSON.parse` +
  // `canonicalBytes`/`digestBytes`, exactly as `memoizeRecordOpens` and
  // `recordOpenCommands` used to call them, inlined here rather than through
  // the fused implementation) and asserts the fused pass's actual
  // `record_occurrences` INSERT commands match byte-for-byte -- covering
  // both a bare record entry and a `{record, previous_record_id}`-wrapped
  // replacement entry (decision 11's two `record_without_validity` shapes).
  it("computes record-open ids/digests/row bytes identical to the pre-fusion two-pass formula", async () => {
    const input = publication("candidate-record-open-fusion", "record-open-fusion", initialBase);
    const generation = 1;
    const bareRecord = { category: "fact", kind: "fusion-kind", universal_kind: "fusion-universal", schema_version: 1, primary_source_span: { artifact_version_id: "version-fusion-a", start_byte: "10", end_byte: "24", start_line: "4", end_line: "5" }, body: { text: "hello", n: 1 } };
    const wrappedRecord = { record: { category: "fact", kind: "fusion-kind-b", universal_kind: "fusion-universal-b", schema_version: 1, body: { text: "world", n: 2 } }, previous_record_id: "record:previous" };
    const entries = [
      { record_without_validity: JSON.stringify(bareRecord), owner_artifact_id: "artifact-fusion-a", owner_artifact_version_id: "version-fusion-a", open_reason_code: "core:record_created", cause_references: [] },
      { record_without_validity: JSON.stringify(wrappedRecord), owner_artifact_id: "artifact-fusion-b", owner_artifact_version_id: "version-fusion-b", open_reason_code: "core:record_replaced", cause_references: [] },
    ];
    const templatedInput = withTemplateSets(input, { record_opens: entries });
    const plan = await buildCandidatePublicationPlan({
      input: templatedInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation,
      publishedAt: now,
    });
    const recordOccurrenceInserts = plan.canonical.filter((command): command is { kind: "run"; sql: string; params: readonly SqliteValue[] } => command.kind === "run" && command.sql.includes("INSERT INTO record_occurrences"));
    expect(recordOccurrenceInserts).toHaveLength(entries.length);
    for (const entry of entries) {
      const parsed = JSON.parse(entry.record_without_validity) as Record<string, unknown>;
      // Old formula (`memoizeRecordOpens`): digest the whole parsed value,
      // wrapped or not -- `canonicalSha256(x) === digestBytes(canonicalBytes(x))`.
      const expectedRecordDigest = digestBytes(canonicalBytes(parsed));
      const expectedRecordId = `record:${expectedRecordDigest.slice("sha256:".length)}`;
      const innerRecord = parsed["record"];
      const unwrapped = (innerRecord !== null && typeof innerRecord === "object" && !Array.isArray(innerRecord) ? innerRecord : parsed) as Record<string, unknown>;
      const expectedBodyPayload = canonicalBytes(unwrapped["body"] ?? null);
      // Old formula (`recordOpenCommands`): payload_digest was a SECOND,
      // independent `canonicalSha256(record["body"] ?? null)` call, re-encoding
      // the same body a second time rather than reusing `bodyPayload`.
      const expectedPayloadDigest = digestBytes(canonicalBytes(unwrapped["body"] ?? null));
      const expectedRecordPayload = canonicalBytes({
        ...unwrapped,
        record_id: expectedRecordId,
        category: unwrapped["category"] ?? "fact",
        kind: unwrapped["kind"] ?? "unknown",
        universal_kind: unwrapped["universal_kind"] ?? "unknown",
        schema_version: unwrapped["schema_version"] ?? 1,
        valid_from_generation: generation,
        producer_id: "candidate",
        producer_version: "1",
        record_digest: expectedRecordDigest,
        payload: unwrapped["body"] ?? null,
      });
      const command = recordOccurrenceInserts.find((candidate) => candidate.params[0] === expectedRecordId);
      expect(command).toBeDefined();
      const params = command!.params;
      expect(params[0]).toBe(expectedRecordId); // record_id
      expect(params[1]).toBe(workspace.workspace_id); // workspace_id
      const expectedSpan = unwrapped["primary_source_span"] as Record<string, unknown> | undefined;
      expect(params[10]).toBe(expectedSpan?.["artifact_version_id"] ?? null); // primary_source_span_artifact_version_id
      expect(params[11]).toBe(expectedSpan?.["start_byte"] ?? null); // primary_source_span_start_byte
      expect(params[12]).toBe(expectedSpan?.["end_byte"] ?? null); // primary_source_span_end_byte
      expect(params[13]).toBe(expectedSpan?.["start_line"] ?? null); // primary_source_span_start_line
      expect(params[14]).toBe(expectedSpan?.["end_line"] ?? null); // primary_source_span_end_line
      expect(params[15]).toBe(generation); // valid_from_generation
      expect(params[16]).toBe(expectedRecordDigest); // record_digest
      expect(params[17]).toBe(expectedPayloadDigest); // payload_digest
      expect(params[18]).toBe(expectedBodyPayload.byteLength); // payload_byte_length
      expect(new Uint8Array(params[19] as Uint8Array)).toEqual(expectedBodyPayload); // payload_inline
      expect(new Uint8Array(params[20] as Uint8Array)).toEqual(expectedRecordPayload); // record_payload
    }
  });

  it.each(["metadata", "payload"] as const)("rejects a persisted materialization %s conflict", async (variant) => {
    await withWorkspace(async (opened) => {
      const input = publication(`candidate-materialization-conflict-${variant}`, `materialization-conflict-${variant}`, initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, input.materialization);
      if (variant === "metadata") {
        await expect(opened.publishCandidate({ ...input, materialization: { ...input.materialization, materialization_digest: digest("different-materialization") } } as CandidatePublicationInput)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      } else {
        await opened.database.run("UPDATE candidate_materializations SET materialization_payload = ? WHERE workspace_id = ? AND candidate_materialization_id = ?", [new Uint8Array([8]), workspace.workspace_id, input.materialization.candidate_materialization_id]);
        await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      }
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: 0 });
    });
  });

  it.each([
    ["generation_manifests", "metadata"], ["generation_manifests", "payload"],
    ["snapshots", "metadata"], ["snapshots", "payload"],
    ["candidate_publication_journal", "metadata"], ["candidate_publication_journal", "payload"],
  ] as const)("maps a pre-existing %s %s mismatch to a typed publication conflict", async (table, variant) => {
    await withWorkspace(async (opened) => {
      const input = publication(`candidate-${table}-${variant}`, `${table}-${variant}`, initialBase);
      const candidateId = input.candidate.candidate_generation_id;
      const snapshotId = `snapshot:${candidateId}`;
      const manifestId = `generation-manifest:${candidateId}`;
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await opened.database.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [input.target_registry.registry_snapshot_id, workspace.workspace_id, input.target_registry.registry_contract_version, input.target_registry.core_registry_digest, input.target_resolution_lock.resolution_lock_id, input.target_registry.registry_digest, encodeCanonical(input.target_registry)]);
      const payload = variant === "payload" ? new Uint8Array([9]) : new Uint8Array([1]);
      if (table === "generation_manifests") {
        await opened.database.run("INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest, manifest_payload) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [manifestId, workspace.workspace_id, candidateId, variant === "metadata" ? 99 : 1, snapshotId, input.target_registry.registry_snapshot_id, input.publication_kind, now, "[]", "[]", "[]", "[]", "{}", "manifest-conflict", payload]);
      } else if (table === "snapshots") {
        await opened.database.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [snapshotId, workspace.workspace_id, variant === "metadata" ? 99 : 1, manifestId, input.target_registry.registry_snapshot_id, input.target_resolution_lock.resolution_lock_id, input.target_configuration.configuration_revision_id, initialBase.source_state_digest, "{}", "records", "projections", "capabilities", now, "snapshot-conflict", payload]);
      } else {
        await opened.database.run("INSERT INTO candidate_publication_journal (candidate_generation_id, workspace_id, status, snapshot_id, generation_manifest_id, generation, published_at, publication_digest, journal_payload) VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?)", [candidateId, workspace.workspace_id, snapshotId, manifestId, variant === "metadata" ? 99 : 1, now, "journal-conflict", payload]);
      }
      await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: table === "snapshots" ? 1 : 0 });
    });
  });

  it.each(["materialization", "manifest", "snapshot"] as const)("maps a different-ID same-digest %s collision to a typed publication conflict", async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    try {
      await withWorkspace(async (opened) => {
        const input = publication(`candidate-digest-collision-${kind}`, `digest-collision-${kind}`, initialBase);
        const candidateId = input.candidate.candidate_generation_id;
        const snapshotId = `snapshot:${candidateId}`;
        const manifestId = `generation-manifest:${candidateId}`;
        const canonicalDigest = (value: unknown): string => digestBytes(canonicalBytes(value));
        await opened.candidates.insert(input.candidate, input.frozen_base);

        // The real publish attempt below computes `manifest_digest`/`canonical_record_set_digest`/
        // `projection_set_digests` per `packages/storage/src/publication-authority.ts`'s
        // `manifestRow`/`computeSnapshotDigestFields` (descriptor-based, not the old giant-string
        // formulas), against a fresh workspace at generation 1, `publishedAt`
        // "2026-08-10T00:00:00.000Z" (this test's frozen clock). Seeding rows here with those exact
        // digests but a *different* identity (generation 99, `*:different-id`) reproduces a
        // same-digest, different-identity collision using the authoritative formula.
        const descriptors = buildManifestDescriptors([], [], [], [], [], []);
        if (kind === "materialization") {
          await opened.database.run("INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_payload) VALUES (?, ?, NULL, ?, ?, ?)", ["materialization:different-id", workspace.workspace_id, input.materialization.materialization_digest, now, encodeCanonical(input.materialization)]);
        } else if (kind === "manifest") {
          // The digest payload must embed the *real* identity (`manifestId`/`snapshotId`/
          // generation 1) -- that is exactly what makes this a same-digest, *different*
          // stored-identity collision once the row is inserted under generation 99 and
          // `*:different-id` below.
          const manifest = manifestRow(manifestId, workspace.workspace_id, candidateId, 1, snapshotId, undefined, input.target_registry.registry_snapshot_id, input.publication_kind, "2026-08-10T00:00:00.000Z", descriptors);
          await opened.database.run("INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest, manifest_payload) VALUES (?, ?, ?, 99, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["generation-manifest:different-id", workspace.workspace_id, candidateId, "snapshot:different-id", input.target_registry.registry_snapshot_id, input.publication_kind, now, manifest.artifact_change_set, manifest.record_open_set, manifest.record_closure_set, manifest.identity_assignment_set, manifest.projection_change_sets, manifest.manifest_digest, new Uint8Array([1])]);
        } else {
          const manifest = manifestRow("generation-manifest:different-id", workspace.workspace_id, candidateId, 1, "snapshot:different-id", undefined, input.target_registry.registry_snapshot_id, input.publication_kind, "2026-08-10T00:00:00.000Z", descriptors);
          await opened.database.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [input.target_registry.registry_snapshot_id, workspace.workspace_id, input.target_registry.registry_contract_version, input.target_registry.core_registry_digest, input.target_resolution_lock.resolution_lock_id, input.target_registry.registry_digest, encodeCanonical(input.target_registry)]);
          await opened.database.run("INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest, manifest_payload) VALUES (?, ?, ?, 99, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["generation-manifest:different-id", workspace.workspace_id, candidateId, "snapshot:different-id", input.target_registry.registry_snapshot_id, input.publication_kind, now, manifest.artifact_change_set, manifest.record_open_set, manifest.record_closure_set, manifest.identity_assignment_set, manifest.projection_change_sets, "manifest-for-snapshot-collision", new Uint8Array([1])]);
          const sourceWatermarks = JSON.stringify({ watermarks: [], source_observation_batch_ids: [] });
          const snapshotDigests = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, [], []);
          const snapshotWithoutDigest = {
            snapshot_id: snapshotId,
            workspace_id: workspace.workspace_id,
            generation: 1,
            generation_manifest_id: manifestId,
            registry_snapshot_id: input.target_registry.registry_snapshot_id,
            resolution_lock_id: input.target_resolution_lock.resolution_lock_id,
            configuration_revision_id: input.target_configuration.configuration_revision_id,
            source_state_digest: initialBase.source_state_digest,
            source_observation_watermarks: sourceWatermarks,
            canonical_record_set_digest: snapshotDigests.canonical_record_set_digest,
            projection_set_digests: snapshotDigests.projection_set_digests,
            capability_state_digest: canonicalDigest([]),
            published_at: "2026-08-10T00:00:00.000Z",
            snapshot_digest: "",
          };
          await opened.database.run("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest, snapshot_payload) VALUES (?, ?, 99, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["snapshot:different-id", workspace.workspace_id, "generation-manifest:different-id", input.target_registry.registry_snapshot_id, input.target_resolution_lock.resolution_lock_id, input.target_configuration.configuration_revision_id, initialBase.source_state_digest, sourceWatermarks, snapshotWithoutDigest.canonical_record_set_digest, snapshotWithoutDigest.projection_set_digests, snapshotWithoutDigest.capability_state_digest, snapshotWithoutDigest.published_at, snapshotDigest(snapshotWithoutDigest), new Uint8Array([1])]);
        }

        await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:publication_conflict" });
        expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: kind === "snapshot" ? 1 : 0 });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a deletion tombstone as part of the source transition", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-delete", "delete", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const tombstone = {
        artifact_tombstone_id: "tombstone-delete",
        workspace_id: workspace.workspace_id,
        artifact_id: "artifact-delete",
        absence_kind: "deleted",
        absence_reason_code: "source_deleted",
        last_artifact_version_id: "version-delete",
        opening_artifact_change_id: "change-delete",
        // `ArtifactTombstone.cause_references`/`.lineage_evidence_record_ids`
        // are typed `string` (already-JSON-encoded) -- see the matching note
        // on the "authority-shapes" tombstone fixture above.
        cause_references: "[]",
        lineage_evidence_record_ids: "[]",
      };
      const change = {
        artifact_change_id: "change-delete",
        workspace_id: workspace.workspace_id,
        artifact_id: "artifact-delete",
        change_kind: "deleted",
        previous_artifact_version_id: "version-delete",
        new_tombstone_id: "tombstone-delete",
        cause_references: [],
        lineage_evidence_record_ids: [],
      };
      await expect(opened.database.run("INSERT INTO source_artifacts (artifact_id, workspace_id, normalized_uri, artifact_kind, artifact_payload) VALUES (?, ?, ?, ?, ?)", ["artifact-delete", workspace.workspace_id, "file:///delete", "file", new Uint8Array([1])])).resolves.toBeDefined();
      await opened.database.run("INSERT INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?, ?, ?, ?)", ["blob-delete", "hash-delete", 0, "inline"]);
      await opened.database.run("INSERT INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest, observation_batch_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)", ["batch-delete", workspace.workspace_id, "binding-delete", "test", "1", "test", "full", "[]", "complete", "authoritative", now, now, 1, 0, digest("batch-delete"), new Uint8Array([3])]);
      await opened.database.run("INSERT INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at, observation_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)", ["observation-delete", "batch-delete", workspace.workspace_id, "artifact-delete", "binding-delete", "test", "1", "test", "full", "present", "hash-delete", "metadata-delete", now, now, new Uint8Array([4])]);
      await opened.database.run("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation, artifact_version_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)", ["version-delete", workspace.workspace_id, "artifact-delete", "blob-delete", "hash-delete", 0, "utf8", null, "metadata-delete", "observation-delete", 0, new Uint8Array([2])]);
      const templatedInput = withTemplateSets(input, { source_transitions: [{ artifact_change: change, target_artifact_tombstone_without_generation: tombstone }] }, { materialization_digest: digest("delete-materialization") });
      await expect(publishStoredCandidate(opened, templatedInput)).resolves.toMatchObject({ generation: 1 });
      const tombstoneCount = await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM artifact_tombstones WHERE artifact_tombstone_id = ?", ["tombstone-delete"]);
      expect(tombstoneCount?.count).toBe(1);
    });
  });

  it("rejects a pre-existing sealed target with a different authoritative payload", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-authority-conflict", "authority-conflict", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await opened.database.run("INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest, registry_payload) VALUES (?, ?, ?, ?, ?, ?, ?)", [input.target_registry.registry_snapshot_id, workspace.workspace_id, input.target_registry.registry_contract_version, input.target_registry.core_registry_digest, input.target_resolution_lock.resolution_lock_id, "different-digest", new Uint8Array([9])]);
      await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: 0 });
    });
  });

  it("installs lookup revalidation and capability state inside publication", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-dependencies", "dependencies", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const templatedInput = withTemplateSets(input, {
        lookup_dependencies: [{ lookup_dependency_id: "lookup-publication", consumer_type: "record", consumer_id: "record-1", operation: "resolve", normalized_selector_or_address: "selector", previous_result_set_digest: "digest:previous", invalidation_scope: "record" }],
        lookup_revalidations: [{ lookup_dependency_id: "lookup-publication", current_result_set_digest: "digest:current", completeness: "complete" }],
      });
      const materialization = { ...templatedInput.materialization, capability_state_entries: [{ capability_id: "capability:test", state: "complete" }] };
      await expect(opened.publishCandidate({ ...templatedInput, materialization } as unknown as CandidatePublicationInput)).resolves.toMatchObject({ generation: 1 });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM candidate_lookup_dependencies WHERE candidate_generation_id = ?", [input.candidate.candidate_generation_id]))?.toEqual({ count: 1 });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM control_plane_state WHERE state_kind IN ('lookup_revalidation', 'capability_state')"))?.toEqual({ count: 2 });
    });
  });

  it("rejects conflicting pre-existing capability and lookup rows without overwriting them", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-immutable-dependencies", "immutable-dependencies", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const capabilityKey = `capability_state:${input.candidate.candidate_generation_id}:${digestBytes(canonicalBytes({ capability_id: "capability:test" }))}`;
      await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'capability_state', ?, ?, NULL, NULL, ?)", [capabilityKey, workspace.workspace_id, new Uint8Array([8]), workspace.workspace_id, now]);
      const materialization = { ...input.materialization, capability_state_entries: [{ capability_id: "capability:test" }], materialization_digest: digest("immutable-dependencies") };
      await expect(opened.publishCandidate({ ...input, materialization } as unknown as CandidatePublicationInput)).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ payload: Uint8Array }>("SELECT payload FROM control_plane_state WHERE state_key = ?", [capabilityKey])).toMatchObject({ payload: new Uint8Array([8]) });
    });
  });

  it("rejects capability and revalidation reference-only conflicts", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-reference-conflict", "reference-conflict", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const capability = { capability_id: "capability:reference", state: "complete" };
      const capabilityKey = `capability_state:${input.candidate.candidate_generation_id}:${digestBytes(canonicalBytes(capability))}`;
      await opened.database.run("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, payload, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?, ?, 'capability_state', ?, ?, 'tampered-snapshot', 'tampered-source', ?)", [capabilityKey, workspace.workspace_id, encodeCanonical(capability), workspace.workspace_id, now]);
      const materialization = { ...input.materialization, capability_state_entries: [capability], materialization_digest: digest("reference-conflict") };
      await expect(opened.publishCandidate({ ...input, materialization } as unknown as CandidatePublicationInput)).rejects.toMatchObject({ code: "storage:publication_conflict" });
    });
  });

  it("persists identical delta writes idempotently and rejects a digest conflict", async () => {
    await withWorkspace(async (opened) => {
      const candidates = opened.candidates as unknown as CandidateRepositoryShape;
      const delta = { fact_delta_id: "delta-1", candidate_generation_id: "candidate-1", workspace_id: workspace.workspace_id, delta_digest: digest("delta-1"), payload: { records: [] } };
      await opened.candidates.insert({ candidate_generation_id: "candidate-1", workspace_id: workspace.workspace_id, target_registry_snapshot_id: "registry-1", target_configuration_revision_id: "configuration-1", trigger_kind: "test", state: "queued", source_observation_batch_ids: [], created_at: now, issue_ids: [] } as never, initialBase);
      await expect(candidates.acceptDelta(delta)).resolves.toEqual({ status: "inserted" });
      await expect(candidates.acceptDelta(delta)).resolves.toEqual({ status: "already_accepted" });
      await expect(candidates.acceptDelta({ ...delta, delta_digest: digest("delta-1-conflict") })).rejects.toMatchObject({ code: "storage:candidate_digest_conflict" });
    });
  });

  it("persists candidate state, manifests, materializations, issues, leases, cleanup, and generic occurrences idempotently", async () => {
    await withWorkspace(async (opened) => {
      const candidate = {
        candidate_generation_id: "candidate-repository",
        workspace_id: workspace.workspace_id,
        target_registry_snapshot_id: "registry-repository",
        target_configuration_revision_id: "configuration-repository",
        trigger_kind: "test",
        state: "queued",
        source_observation_batch_ids: [],
        created_at: now,
        issue_ids: [],
      } as never;
      const frozen = { ...initialBase };
      await expect(opened.candidates.insert(candidate, frozen)).resolves.toBe("inserted");
      await expect(opened.candidates.insert(candidate, frozen)).resolves.toBe("already_present");
      const issue = { candidate_issue_id: "issue-repository", candidate_generation_id: "candidate-repository", issue_code: "test_issue", phase: "validation", severity: "warning", scope: { scope_type: "workspace", workspace_id: workspace.workspace_id }, retryability: "retryable", summary: "summary", detail: "detail", cause_references: "cause", payload: { key: "value" }, created_at: now } as Record<string, unknown>;
      await expect(opened.candidates.appendIssue(issue as never)).resolves.toBe("inserted");
      await expect(opened.candidates.appendIssue(issue as never)).resolves.toBe("already_present");
      expect(await opened.candidates.listIssues("candidate-repository")).toEqual([issue]);
      await expect(opened.candidates.appendIssue({ ...issue, severity: "error" } as never)).rejects.toMatchObject({ code: "storage:candidate_digest_conflict" });
      const root = { root_id: "root-repository", workspace_id: workspace.workspace_id, candidate_generation_id: "candidate-repository", resource_type: "manifest", content_digest: digest("root"), state: "sealed", payload: { root: true } } as Record<string, unknown>;
      await expect(opened.candidates.putRoot(root as never)).resolves.toBe("inserted");
      await expect(opened.candidates.putRoot({ ...root, state: "rejected" } as never)).rejects.toMatchObject({ code: "storage:candidate_digest_conflict" });
      await expect(opened.candidates.transition("candidate-repository", "queued", "planning", { analysis_started_at: now })).resolves.toBeUndefined();
      await expect(opened.candidates.selectManifest("candidate-repository", { work_manifest_id: "manifest-repository", workspace_id: workspace.workspace_id, candidate_generation_id: "candidate-repository", invalidation_plan_id: "plan", artifact_work_set: {}, projection_work_set: {}, target_registry_snapshot_id: "registry-repository", target_configuration_revision_id: "configuration-repository", created_at: now, work_digest: digest("manifest") } as never)).resolves.toBe("inserted");
      await expect(opened.candidates.saveMaterialization("candidate-repository", emptyMaterialization("materialization-repository") as never)).resolves.toBe("inserted");
      await expect(opened.candidates.acquireLease("candidate-repository", undefined)).resolves.toBe("inserted");
      await expect(opened.candidates.markCleanup({ candidate_generation_id: "candidate-repository", resource_type: "temporary_blob", resource_id: "blob" })).resolves.toBe("marked");
      await expect(opened.candidates.markCleanup({ candidate_generation_id: "candidate-repository", resource_type: "temporary_blob", resource_id: "blob", state: "cleaned" })).resolves.toBe("marked");
      expect(await opened.candidates.listRecoverable()).toHaveLength(1);
      const occurrences = opened.projectionOccurrences as import("../packages/storage/src/index.js").WorkspaceProjectionOccurrenceRepository;
      const projection = { projection_record_id: "projection-generic", projection_kind: "generic", projection_key: "key", workspace_id: workspace.workspace_id, owner_artifact_id: "artifact", owner_artifact_version_id: "version", source_artifact_version_ids: ["version"], source_record_ids: [], source_projection_record_ids: [], generator: "generator", generator_version: "1", generator_configuration_digest: digest("configuration"), valid_from_generation: 1, payload: { value: 1 } };
      await expect(occurrences.put(projection)).resolves.toBe("inserted");
      await expect(occurrences.put(projection)).resolves.toBe("already_present");
      await expect(occurrences.putDependency({ projection_record_id: "projection-generic", valid_from_generation: 1, source_type: "artifact_version", source_id: "version" })).resolves.toBe("inserted");
      await expect(occurrences.putDependency({ projection_record_id: "projection-generic", valid_from_generation: 1, source_type: "artifact_version", source_id: "version" })).resolves.toBe("already_present");
      expect(await occurrences.get("projection-generic")).toMatchObject({ projection_kind: "generic" });
      expect(await occurrences.listByOwner("artifact", "version")).toHaveLength(1);
      expect(await occurrences.dependencies("projection-generic")).toEqual([expect.objectContaining({ source_id: "version" })]);
    });
  });

  it("assigns gapless generations only in committed candidate publications", async () => {
    await withWorkspace(async (opened) => {
      const first = await publishStoredCandidate(opened, publication("candidate-1", "one", initialBase));
      await expect(publishStoredCandidate(opened, publication("candidate-stale", "stale", initialBase))).rejects.toMatchObject({ code: "storage:publication_conflict" });
      const secondBaseWithoutDigest = { snapshot_id: first.snapshot_id, generation: first.generation, registry_snapshot_id: "registry-one", resolution_lock_id: "lock-one", configuration_revision_id: "configuration-one", source_state_digest: "source-initial", source_observation_batch_ids: [] };
      const secondBase = { ...secondBaseWithoutDigest, tuple_digest: tupleDigest(secondBaseWithoutDigest) };
      const second = await publishStoredCandidate(opened, publication("candidate-2", "two", secondBase));
      expect([first.generation, second.generation]).toEqual([1, 2]);
      expect(await opened.candidates.getPublication("candidate-1")).toMatchObject({ generation: 1, status: "published" });
    });
  });

  it("binds a first publication freshness checkpoint to the newly minted snapshot when no source snapshot is supplied", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-freshness-new-snapshot", "freshness-new-snapshot", initialBase);
      const { snapshot_id: _omittedSnapshotId, ...freshnessWithoutSnapshot } = input.freshness_checkpoint as unknown as Record<string, unknown>;
      const published = await publishStoredCandidate(opened, { ...input, freshness_checkpoint: freshnessWithoutSnapshot } as unknown as CandidatePublicationInput);
      const row = await opened.database.get<{ reference_snapshot_id: string }>("SELECT reference_snapshot_id FROM control_plane_state WHERE state_key = ?", [`workspace_freshness_checkpoint:${freshnessWithoutSnapshot["freshness_checkpoint_id"]}`]);
      expect(row?.reference_snapshot_id).toBe(published.snapshot_id);
    });
  });

  it("binds an incremental freshness checkpoint to its parent snapshot when no source snapshot is supplied", async () => {
    await withWorkspace(async (opened) => {
      const first = await publishStoredCandidate(opened, publication("candidate-freshness-parent-base", "freshness-parent-base", initialBase));
      const baseWithoutDigest = { snapshot_id: first.snapshot_id, generation: first.generation, registry_snapshot_id: "registry-freshness-parent-base", resolution_lock_id: "lock-freshness-parent-base", configuration_revision_id: "configuration-freshness-parent-base", source_state_digest: "source-initial", source_observation_batch_ids: [] };
      const base = { ...baseWithoutDigest, tuple_digest: tupleDigest(baseWithoutDigest) };
      const input = publication("candidate-freshness-parent", "freshness-parent", base);
      const { snapshot_id: _omittedSnapshotId, ...freshnessWithoutSnapshot } = input.freshness_checkpoint as unknown as Record<string, unknown>;
      await publishStoredCandidate(opened, { ...input, freshness_checkpoint: freshnessWithoutSnapshot } as unknown as CandidatePublicationInput);
      const row = await opened.database.get<{ reference_snapshot_id: string }>("SELECT reference_snapshot_id FROM control_plane_state WHERE state_key = ?", [`workspace_freshness_checkpoint:${freshnessWithoutSnapshot["freshness_checkpoint_id"]}`]);
      expect(row?.reference_snapshot_id).toBe(first.snapshot_id);
    });
  });

  it.each([
    ["snapshot_id", { snapshot_id: "different-snapshot" }],
    ["generation", { generation: 99 }],
    ["registry_snapshot_id", { registry_snapshot_id: "different-registry" }],
    ["resolution_lock_id", { resolution_lock_id: "different-lock" }],
    ["configuration_revision_id", { configuration_revision_id: "different-configuration" }],
    ["source_state_digest", { source_state_digest: "different-source" }],
    ["source_observation_batch_ids", { source_observation_batch_ids: ["different-batch"] }],
  ] as const)("rejects a stale frozen-base component without consuming a generation (%s)", async (_name, change) => {
    await withWorkspace(async (opened) => {
      const first = await publishStoredCandidate(opened, publication("candidate-base", "base", initialBase));
      const baseWithoutDigest = { snapshot_id: first.snapshot_id, generation: first.generation, registry_snapshot_id: "registry-base", resolution_lock_id: "lock-base", configuration_revision_id: "configuration-base", source_state_digest: "source-initial", source_observation_batch_ids: [] };
      const base = { ...baseWithoutDigest, tuple_digest: tupleDigest(baseWithoutDigest) };
      const stale = { ...base, ...change };
      await expect(publishStoredCandidate(opened, publication(`candidate-stale-${_name}`, "stale-component", stale))).rejects.toMatchObject({ code: "storage:publication_conflict" });
      expect(await opened.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots"))?.toEqual({ count: 1 });
    });
  });

  const publicationFaultBoundaries = [
    "candidate_publication.before_begin",
    "candidate_publication.after_validate_base",
    "candidate_publication.after_install_source",
    "candidate_publication.after_install_canonical",
    "candidate_publication.after_install_projections",
    "candidate_publication.after_install_manifest",
    "candidate_publication.before_swap_current",
    "candidate_publication.before_commit",
  ] as const;

  it.each(publicationFaultBoundaries)("rolls back every publication object at %s", async (boundary) => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-fault", "fault", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const before = await publicationRows(opened);
      await expect(opened.publishCandidate(input)).rejects.toMatchObject({ code: "storage:fault_injected" });
      expect(await publicationRows(opened)).toEqual(before);
    }, boundary);
  });

  it("commits once when the acknowledgement is lost and exposes recovery state", async () => {
    await withWorkspace(async (opened) => {
      await expect(publishStoredCandidate(opened, publication("candidate-ack", "ack", initialBase))).rejects.toMatchObject({ code: "storage:fault_injected" });
      const afterCommit = await publicationRows(opened);
      expect(afterCommit["snapshots"]).toHaveLength(1);
      expect(await opened.candidates.getPublication("candidate-ack")).toMatchObject({ status: "published", generation: 1 });
      await expect(opened.publishCandidate(publication("candidate-ack", "ack", initialBase))).resolves.toMatchObject({ status: "already_published", generation: 1 });
      expect(await publicationRows(opened)).toEqual(afterCommit);
    }, "candidate_publication.after_commit_ack");
  });
});

// Seeds a single owning artifact + artifact version through the real typed source-catalog
// repository (not raw SQL), so their canonical payloads are self-consistent with their
// typed columns -- required for `StorageMaintenance.verify()` to accept them.
// `storage_reference: "inline"` (not `cas:...`) tells `verify()`'s CAS-backed-blob check to
// skip reading real CAS bytes, so no real blob needs to be written.
async function seedReconciliationOwner(opened: WorkspaceDatabase, workspaceId: string, artifactId: string, artifactVersionId: string): Promise<void> {
  await opened.repositories.sourceCatalog.putArtifact({ artifact_id: artifactId, workspace_id: workspaceId, normalized_uri: `file:///${artifactId}`, normalized_path: `/${artifactId}`, display_path: artifactId, artifact_kind: "file" });
  await opened.repositories.sourceCatalog.putContentBlob({ content_blob_id: `blob-${artifactVersionId}`, content_hash: digest(`content-${artifactVersionId}`), byte_length: 0, storage_reference: "inline" });
  const batchId = `batch-${artifactVersionId}`;
  const observationId = `observation-${artifactVersionId}`;
  await opened.repositories.sourceCatalog.putObservationBatch({ observation_batch_id: batchId, workspace_id: workspaceId, source_provider_binding_id: "provider-reconciliation", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", coverage_scopes: "all", coverage_completeness: "complete", deletion_authority: "test", provider_cursor_before: "", provider_cursor_after: "", started_at: now, completed_at: now, observation_count: 1, unavailable_count: 0, batch_digest: digest(batchId) });
  await opened.repositories.sourceCatalog.putObservation({ source_observation_id: observationId, observation_batch_id: batchId, workspace_id: workspaceId, artifact_id: artifactId, source_provider_binding_id: "provider-reconciliation", source_provider: "test", source_provider_version: "1", ordering_domain: "test", observation_mode: "full", observed_state: "present", observed_content_hash: digest(`content-${artifactVersionId}`), observed_metadata_digest: digest(`metadata-${artifactVersionId}`), provider_event_token: `event-${artifactVersionId}`, provider_sequence: "1", observed_at: now, received_at: now });
  await opened.repositories.sourceCatalog.putArtifactVersion({ artifact_version_id: artifactVersionId, workspace_id: workspaceId, artifact_id: artifactId, content_blob_id: `blob-${artifactVersionId}`, content_hash: digest(`content-${artifactVersionId}`), byte_length: 0, encoding: "utf-8", analysis_metadata_digest: digest(`analysis-${artifactVersionId}`), created_from_observation_id: observationId, valid_from_generation: 1 } as never);
}

describe("Phase 2 template-set descriptors, segments, and verifyIntegrity reconciliation", () => {
  it("rejects re-persisting a candidate template segment with different content at the same ordinal (immutability conflict)", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-segment-immutable", "segment-immutable", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const entries = [{ record_without_validity: JSON.stringify({ owner_artifact_id: "artifact-segment", owner_artifact_version_id: "version-segment", body: null }), open_reason_code: "core:record_created", cause_references: [] }];
      const templateSets: CandidateTemplateSets = { ...emptyTemplateSets, record_opens: entries };
      const materialization = { ...input.materialization, record_open_template_set: orderedSetDescriptorJson("core:CandidateRecordOpenTemplate", entries) };
      await expect(opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, materialization as never, templateSets)).resolves.toBe("inserted");
      const conflictingEntries = [{ record_without_validity: JSON.stringify({ owner_artifact_id: "artifact-segment", owner_artifact_version_id: "version-segment", body: { changed: true } }), open_reason_code: "core:record_created", cause_references: [] }];
      const conflictingTemplateSets: CandidateTemplateSets = { ...emptyTemplateSets, record_opens: conflictingEntries };
      await expect(opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, materialization as never, conflictingTemplateSets)).rejects.toMatchObject({ code: "storage:candidate_digest_conflict" });
      // The original segment survives untouched.
      await expect(opened.candidates.readTemplateSet(materialization["candidate_materialization_id"] as string, "record_opens")).resolves.toEqual(entries);
    });
  });

  it("detects a tampered candidate template segment blob during verifyIntegrity", async () => {
    await withWorkspace(async (opened) => {
      const input = publication("candidate-segment-tamper", "segment-tamper", initialBase);
      await opened.candidates.insert(input.candidate, input.frozen_base);
      const entries = [{ record_without_validity: JSON.stringify({ owner_artifact_id: "artifact-tamper", owner_artifact_version_id: "version-tamper", body: null }), open_reason_code: "core:record_created", cause_references: [] }];
      const templateSets: CandidateTemplateSets = { ...emptyTemplateSets, record_opens: entries };
      const materialization = { ...input.materialization, record_open_template_set: orderedSetDescriptorJson("core:CandidateRecordOpenTemplate", entries) };
      await opened.candidates.saveMaterialization(input.candidate.candidate_generation_id, materialization as never, templateSets);
      expect((await opened.maintenance.verify()).ok).toBe(true);
      await opened.database.run("UPDATE candidate_template_segments SET content_digest = ? WHERE candidate_materialization_id = ? AND set_kind = 'record_opens'", ["sha256:0000000000000000000000000000000000000000000000000000000000000000", materialization["candidate_materialization_id"]]);
      const report = await opened.maintenance.verify();
      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ component_id: expect.stringContaining("record_opens") })]));
    });
  });

  it("throws storage:template_set_mismatch when a supplied template array does not match its committed descriptor", async () => {
    const input = publication("candidate-template-set-mismatch", "template-set-mismatch", initialBase);
    // The descriptor commits to zero entries (from the base `publication()` helper), but
    // `template_sets.record_opens` supplies one -- entry_count and content_digest both
    // disagree with the descriptor that is inside the digested materialization.
    const mismatchedInput: CandidatePublicationInput = {
      ...input,
      template_sets: { ...emptyTemplateSets, record_opens: [{ record_without_validity: JSON.stringify({ owner_artifact_id: "artifact-mismatch", owner_artifact_version_id: "version-mismatch", body: null }) }] },
    };
    await expect(buildCandidatePublicationPlan({
      input: mismatchedInput,
      storedCandidate: input.candidate as never,
      workspaceId: workspace.workspace_id,
      database: { get: async () => undefined, all: async () => [] } as never,
      faults: createFaultInjector([]),
      generation: 1,
      publishedAt: now,
    })).rejects.toMatchObject({ code: "storage:template_set_mismatch" });
  });

  // The key reconciliation test: publishes a small, fully self-consistent candidate (one
  // new record, one identity assignment, owned by a real, typed-catalog artifact version)
  // end-to-end through the real `publishCandidate` path, then runs
  // `StorageMaintenance.verify()` and asserts it finds zero issues. This is what proves the
  // writer (`buildCandidatePublicationPlan`'s `computeSnapshotDigestFields`/
  // `buildManifestDescriptors`) and the verifier (`StorageMaintenance.verify()` in
  // `packages/storage/src/lifecycle.ts`) agree on `canonical_record_set_digest` and
  // `projection_set_digests` for a freshly published generation.
  it("publishes a small self-consistent candidate end-to-end and passes verifyIntegrity with zero issues", async () => {
    await withWorkspace(async (opened) => {
      const draftInput = publication("candidate-reconciliation", "reconciliation", initialBase);
      // `publication()`'s synthetic `target_registry.registry_digest` and
      // `freshness_checkpoint.snapshot_id` are placeholders that no test before this one
      // ever ran through `verify()`; this test does, so both must be exactly what
      // `StorageMaintenance.verify()` (`packages/storage/src/lifecycle.ts`) recomputes:
      // the real registry-snapshot digest recipe, and a freshness checkpoint whose own
      // `snapshot_id` matches the real published snapshot id the publish installs as
      // `control_plane_state.reference_snapshot_id`.
      const realSnapshotId = `snapshot:${draftInput.candidate.candidate_generation_id}`;
      const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, {
        registry_snapshot_id: draftInput.target_registry.registry_snapshot_id,
        registry_contract_version: draftInput.target_registry.registry_contract_version,
        core_registry_digest: draftInput.target_registry.core_registry_digest,
        resolution_lock_id: draftInput.target_resolution_lock.resolution_lock_id,
        namespace_bindings: [],
      });
      const input: CandidatePublicationInput = {
        ...draftInput,
        target_registry: { ...draftInput.target_registry, registry_digest: registryDigest },
        freshness_checkpoint: { ...draftInput.freshness_checkpoint, snapshot_id: realSnapshotId },
      };
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-reconciliation", "version-reconciliation");
      const record = { category: "entity", kind: "test:symbol", universal_kind: "definition", schema_version: 1, body: { name: "Reconciliation" } };
      const recordId = `record:${digestBytes(canonicalBytes(record)).slice("sha256:".length)}`;
      const identity = {
        identity_assignment_id: "identity-reconciliation",
        workspace_id: workspace.workspace_id,
        identity_type: "entity",
        identity_id: "entity-reconciliation",
        assignment_kind: "created",
        identity_key: "key-reconciliation",
        identity_key_digest: digest("key-reconciliation"),
        record_id: recordId,
        owner_artifact_id: "artifact-reconciliation",
        owner_artifact_version_id: "version-reconciliation",
      };
      const templatedInput = withTemplateSets(input, {
        record_opens: [{ record_without_validity: JSON.stringify(record), open_reason_code: "core:record_created", owner_artifact_id: "artifact-reconciliation", owner_artifact_version_id: "version-reconciliation", cause_references: [] }],
        identity_assignments: [identity],
      });
      await expect(opened.publishCandidate(templatedInput)).resolves.toMatchObject({ status: "published", generation: 1 });
      const report = await opened.maintenance.verify();
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  // Decision 05 (content-derived record identity): record_payload no longer
  // embeds workspace_id/owner_artifact_id/owner_artifact_version_id -- those
  // are row columns only, sourced from the open template's own sibling
  // fields. Publishes a real record end-to-end, decodes the persisted
  // record_payload directly, and asserts it round-trips with the record's
  // content plus occurrence-identity fields but none of the three removed
  // ones, while verifyIntegrity still finds zero issues (proving the
  // verifier's own recomputed occurrence-identity shape agrees).
  it("persists record_payload without workspace_id or owner fields, and verifyIntegrity still passes", async () => {
    await withWorkspace(async (opened) => {
      const draftInput = publication("candidate-payload-shape", "payload-shape", initialBase);
      const realSnapshotId = `snapshot:${draftInput.candidate.candidate_generation_id}`;
      const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, {
        registry_snapshot_id: draftInput.target_registry.registry_snapshot_id,
        registry_contract_version: draftInput.target_registry.registry_contract_version,
        core_registry_digest: draftInput.target_registry.core_registry_digest,
        resolution_lock_id: draftInput.target_resolution_lock.resolution_lock_id,
        namespace_bindings: [],
      });
      const input: CandidatePublicationInput = {
        ...draftInput,
        target_registry: { ...draftInput.target_registry, registry_digest: registryDigest },
        freshness_checkpoint: { ...draftInput.freshness_checkpoint, snapshot_id: realSnapshotId },
      };
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-payload-shape", "version-payload-shape");
      const record = { category: "entity", kind: "test:symbol", universal_kind: "definition", schema_version: 1, body: { name: "PayloadShape" } };
      const recordId = `record:${digestBytes(canonicalBytes(record)).slice("sha256:".length)}`;
      const identity = {
        identity_assignment_id: "identity-payload-shape",
        workspace_id: workspace.workspace_id,
        identity_type: "entity",
        identity_id: "entity-payload-shape",
        assignment_kind: "created",
        identity_key: "key-payload-shape",
        identity_key_digest: digest("key-payload-shape"),
        record_id: recordId,
        owner_artifact_id: "artifact-payload-shape",
        owner_artifact_version_id: "version-payload-shape",
      };
      const templatedInput = withTemplateSets(input, {
        record_opens: [{ record_without_validity: JSON.stringify(record), open_reason_code: "core:record_created", owner_artifact_id: "artifact-payload-shape", owner_artifact_version_id: "version-payload-shape", cause_references: [] }],
        identity_assignments: [identity],
      });
      await expect(opened.publishCandidate(templatedInput)).resolves.toMatchObject({ status: "published", generation: 1 });
      const row = await opened.database.get<{ workspace_id: string; owner_artifact_id: string; owner_artifact_version_id: string; record_payload: Uint8Array }>("SELECT workspace_id, owner_artifact_id, owner_artifact_version_id, record_payload FROM record_occurrences WHERE workspace_id = ? AND record_id = ?", [workspace.workspace_id, recordId]);
      expect(row).toBeDefined();
      // The row columns are still fully populated...
      expect(row!.workspace_id).toBe(workspace.workspace_id);
      expect(row!.owner_artifact_id).toBe("artifact-payload-shape");
      expect(row!.owner_artifact_version_id).toBe("version-payload-shape");
      // ...but the stored payload never carries them.
      const decoded = decodeCanonical(row!.record_payload instanceof Uint8Array ? row!.record_payload : new Uint8Array(row!.record_payload)) as Record<string, unknown>;
      expect(decoded).not.toHaveProperty("workspace_id");
      expect(decoded).not.toHaveProperty("owner_artifact_id");
      expect(decoded).not.toHaveProperty("owner_artifact_version_id");
      expect(decoded).toMatchObject({ record_id: recordId, category: "entity", kind: "test:symbol", universal_kind: "definition", body: { name: "PayloadShape" }, payload: { name: "PayloadShape" } });
      const report = await opened.maintenance.verify();
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  // `buildCandidatePublicationPlan` now memoizes each `record_open` template
  // entry's canonical digest/id once (`memoizeRecordOpens`) and threads that
  // memo through `computeSnapshotDigestFields`, `assertPublicationImmutableRows`,
  // and `recordOpenCommands` instead of each independently re-parsing and
  // re-hashing the same record. This publishes several distinct records in one
  // generation (stressing the memo across more than one entry, unlike the
  // single-record reconciliation test above) and asserts, for every one of
  // them, that the persisted `record_id`/`record_digest` columns are
  // byte-for-byte identical to a digest computed independently -- via the
  // plain, non-memoized `digestBytes(canonicalBytes(record))` recipe (the
  // exact recipe `recordOpenCommands` used before memoization existed) --
  // rather than only checking internal self-consistency via `verify()`. This
  // is the fixture-comparison Change B's task brief calls for: the memo must
  // never change a record's digest, id, or byte-for-byte content, only
  // eliminate recomputation.
  it("memoizes record-open digests without changing any persisted record_id/record_digest from its independently-computed value", async () => {
    await withWorkspace(async (opened) => {
      const draftInput = publication("candidate-memo-fixture", "memo-fixture", initialBase);
      const realSnapshotId = `snapshot:${draftInput.candidate.candidate_generation_id}`;
      const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, {
        registry_snapshot_id: draftInput.target_registry.registry_snapshot_id,
        registry_contract_version: draftInput.target_registry.registry_contract_version,
        core_registry_digest: draftInput.target_registry.core_registry_digest,
        resolution_lock_id: draftInput.target_resolution_lock.resolution_lock_id,
        namespace_bindings: [],
      });
      const input: CandidatePublicationInput = {
        ...draftInput,
        target_registry: { ...draftInput.target_registry, registry_digest: registryDigest },
        freshness_checkpoint: { ...draftInput.freshness_checkpoint, snapshot_id: realSnapshotId },
      };
      await opened.candidates.insert(input.candidate, input.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-memo-fixture", "version-memo-fixture");
      const records = Array.from({ length: 5 }, (_unused, index) => ({
        category: "entity", kind: "test:symbol", universal_kind: "definition", schema_version: 1,
        body: { name: `MemoFixture${index}`, ordinal: index },
      }));
      const expected = new Map(records.map((record) => [
        `record:${digestBytes(canonicalBytes(record)).slice("sha256:".length)}`,
        digestBytes(canonicalBytes(record)),
      ]));
      const templatedInput = withTemplateSets(input, {
        record_opens: records.map((record) => ({ record_without_validity: JSON.stringify(record), open_reason_code: "core:record_created", owner_artifact_id: "artifact-memo-fixture", owner_artifact_version_id: "version-memo-fixture", cause_references: [] })),
      });
      await expect(opened.publishCandidate(templatedInput)).resolves.toMatchObject({ status: "published", generation: 1 });
      const report = await opened.maintenance.verify();
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      const rows = await opened.database.all<{ record_id: string; record_digest: string }>("SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ?", [workspace.workspace_id]);
      expect(rows).toHaveLength(records.length);
      for (const row of rows) {
        expect(expected.has(row.record_id)).toBe(true);
        expect(row.record_digest).toBe(expected.get(row.record_id));
      }
    });
  });

  it("computeSnapshotDigestFields' memo-less fallback digests identically to the memoized production path and skips malformed entries", async () => {
    await withWorkspace(async (opened) => {
      // `computeSnapshotDigestFields`' optional `recordOpenMemo` is always
      // threaded by `buildCandidatePublicationPlan`; the memo-less form is the
      // documented fallback for direct callers. It must (a) skip non-object
      // entries and entries without a string `record_without_validity` exactly
      // like the production memo builder does, and (b) produce the identical
      // digest fields the memoized call produces for the well-formed entries.
      const wellFormed = Array.from({ length: 2 }, (_unused, index) => ({
        record_without_validity: JSON.stringify({ category: "entity", kind: "test:symbol", universal_kind: "definition", schema_version: 1, body: { name: `FallbackFixture${index}` } }),
        open_reason_code: "core:record_created", owner_artifact_id: "artifact-fallback", owner_artifact_version_id: "version-fallback", cause_references: [],
      }));
      const recordOpens = [null, 42, { open_reason_code: "core:record_created" }, ...wellFormed];
      const withoutMemo = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, recordOpens, []);
      const withEmptyOpens = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, [null, { open_reason_code: "x" }], []);
      const onlyWellFormed = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, wellFormed, []);
      // Malformed entries contribute nothing: dropping them entirely yields the
      // same digests, and a list of ONLY malformed entries digests like [].
      expect(withoutMemo).toEqual(onlyWellFormed);
      expect(withEmptyOpens).toEqual(await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, [], []));
      expect(withoutMemo.canonical_record_set_digest).not.toBe(withEmptyOpens.canonical_record_set_digest);
    });
  });
});

// Warm per-workspace-handle `canonical_record_set_digest` corpus
// (`RecordSetDigestCorpusEntry`, `packages/storage/src/publication-authority.ts`):
// `computeSnapshotDigestFields` skips its `record_occurrences` re-read on an edit
// publish when the calling `WorkspaceDatabase` handle's warm corpus matches
// `(workspaceId, oldGeneration)`, reusing its own prior-publish `sortedVisible`
// output instead. `WorkspaceDatabase.publishCandidateSerialized` (`storage.ts`)
// only installs a new corpus entry once its publication transaction actually
// commits, so the correctness bar is: byte-identical to the unconditional SQL
// path in every case, a generation/workspace mismatch always falls back to SQL,
// and a failed/rolled-back publish never poisons the entry a later publish reads.
describe("Warm record-set digest corpus (RecordSetDigestCorpusEntry)", () => {
  // Same recipe as the "publishes a small self-consistent candidate" reconciliation
  // test above: fills in `publication()`'s synthetic `target_registry.registry_digest`
  // and `freshness_checkpoint.snapshot_id` placeholders with the real values
  // `StorageMaintenance.verify()` recomputes, so a real end-to-end publish through
  // this input can pass `verify()` with zero issues.
  function sealedInput(candidateId: string, suffix: string, base: Parameters<typeof publication>[2]): CandidatePublicationInput {
    const draftInput = publication(candidateId, suffix, base);
    const registryDigest = computeDigest("core:registry_snapshot", "core:registry_snapshot_digest", 1, "core:RegistrySnapshotDigestPayload", 1, {
      registry_snapshot_id: draftInput.target_registry.registry_snapshot_id,
      registry_contract_version: draftInput.target_registry.registry_contract_version,
      core_registry_digest: draftInput.target_registry.core_registry_digest,
      resolution_lock_id: draftInput.target_resolution_lock.resolution_lock_id,
      namespace_bindings: [],
    });
    // `control_plane_state`'s freshness-checkpoint row must reference the
    // snapshot the checkpoint was verified against: this publish's OWN new
    // snapshot on a true first-ever publish (`base.snapshot_id === undefined`,
    // matching `snapshotParent ?? snapshotId` -- see `buildCandidatePublicationPlan`'s
    // `targetControlCommands`), or the PRIOR snapshot `base.snapshot_id` already
    // names on every later publish -- `publication()`'s own default already
    // does the latter, so only the first-publish placeholder needs replacing.
    return {
      ...draftInput,
      target_registry: { ...draftInput.target_registry, registry_digest: registryDigest },
      freshness_checkpoint: { ...draftInput.freshness_checkpoint, snapshot_id: base.snapshot_id ?? `snapshot:${candidateId}` },
    };
  }

  // Builds the frozen base for a follow-up publish against a prior successful
  // publish's result, exactly like "assigns gapless generations only in committed
  // candidate publications" above -- the target registry/lock/configuration ids a
  // publish installs are `publication()`'s `targetObjects(suffix)` outputs, so the
  // next publish's frozen base must reference them by the PRIOR publish's suffix.
  function nextBase(previous: { snapshot_id: string; generation: number }, previousSuffix: string): typeof initialBase {
    const withoutDigest = {
      snapshot_id: previous.snapshot_id,
      generation: previous.generation,
      registry_snapshot_id: `registry-${previousSuffix}`,
      resolution_lock_id: `lock-${previousSuffix}`,
      configuration_revision_id: `configuration-${previousSuffix}`,
      source_state_digest: initialBase.source_state_digest,
      source_observation_batch_ids: [],
    };
    return { ...withoutDigest, tuple_digest: tupleDigest(withoutDigest) };
  }

  function recordTemplate(name: string, owner?: { artifactId: string; artifactVersionId: string }): Record<string, unknown> {
    const record = { category: "entity", kind: "test:symbol", universal_kind: "definition", schema_version: 1, body: { name } };
    return {
      record_without_validity: JSON.stringify(record),
      open_reason_code: "core:record_created",
      cause_references: [],
      ...(owner ? { owner_artifact_id: owner.artifactId, owner_artifact_version_id: owner.artifactVersionId } : {}),
    };
  }

  // Wraps a real `SqliteDatabase` so any `.all` query that touches
  // `record_occurrences` throws instead of running -- used to PROVE the corpus
  // path was taken (no throw) or that a fallback to SQL happened (throw), rather
  // than only inferring it from the resulting digest.
  function explodingRecordOccurrencesDatabase(db: SqliteDatabase): SqliteDatabase {
    return {
      filename: db.filename,
      async exec(sql: string) { return db.exec(sql); },
      async run(sql: string, params?: readonly SqliteValue[]) { return db.run(sql, params); },
      async get<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) { return db.get<T>(sql, params); },
      async all<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<readonly T[]> {
        if (sql.includes("record_occurrences")) throw new Error("computeSnapshotDigestFields must not re-read record_occurrences when its warm corpus is valid.");
        return db.all<T>(sql, params);
      },
      async transaction(commands) { return db.transaction(commands); },
      async transactionChunked(commands, chunkSize, options) { return db.transactionChunked(commands, chunkSize, options); },
      async close() { return db.close(); },
    };
  }

  it("computeSnapshotDigestFields uses a matching corpus instead of the SQL read, and produces the SQL-path digest byte-for-byte", async () => {
    await withWorkspace(async (opened) => {
      const templateA = recordTemplate("CorpusUnitA");
      const templateB = recordTemplate("CorpusUnitB");
      // The workspace's `record_occurrences` table is empty (no candidate has ever
      // been published here) -- both the corpus-fed call and the plain SQL-path
      // call below therefore start generation 1 from the same true empty base, so
      // any divergence between them can only come from the corpus plumbing itself.
      const corpus: RecordSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 1, sortedVisible: [] };
      const explodingDatabase = explodingRecordOccurrencesDatabase(opened.database);
      const withCorpus = await computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, corpus);
      const viaSql = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], []);
      expect(withCorpus.sortedVisible).toEqual(viaSql.sortedVisible);
      expect(withCorpus.canonical_record_set_digest).toBe(viaSql.canonical_record_set_digest);
      expect(withCorpus.projection_set_digests).toBe(viaSql.projection_set_digests);
      // Sanity: the corpus/SQL agreement above isn't vacuous because both sides
      // saw an empty base -- seed the corpus with a real prior-generation record
      // and confirm it actually changes the resulting visible set.
      const seededCorpus: RecordSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 1, sortedVisible: (await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, [templateA], [])).sortedVisible };
      const withSeededCorpus = await computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, seededCorpus);
      expect(withSeededCorpus.sortedVisible.map((row) => row.record_id).sort()).toEqual([...seededCorpus.sortedVisible, ...withCorpus.sortedVisible].map((row) => row.record_id).sort());
      expect(withSeededCorpus.sortedVisible).toHaveLength(2);
    });
  });

  it("falls back to the SQL read when the corpus generation does not match oldGeneration", async () => {
    await withWorkspace(async (opened) => {
      const templateB = recordTemplate("CorpusUnitMismatch");
      const explodingDatabase = explodingRecordOccurrencesDatabase(opened.database);
      const staleCorpus: RecordSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 99, sortedVisible: [{ record_id: "record:phantom", record_digest: "sha256:phantom" }] };
      // A generation mismatch must fall back to the unconditional SQL read, which
      // the exploding database turns into a thrown error -- proving the phantom
      // corpus entry above was never consulted (had it been used, this would
      // resolve with the phantom record folded into the digest instead).
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, staleCorpus)).rejects.toThrow(/record_occurrences/);
    });
  });

  it("never trusts a corpus entry sealed for a different workspace (no cross-workspace leakage)", async () => {
    await withWorkspace(async (opened) => {
      const templateB = recordTemplate("CorpusUnitCrossWorkspace");
      const explodingDatabase = explodingRecordOccurrencesDatabase(opened.database);
      const otherWorkspaceCorpus: RecordSetDigestCorpusEntry = { workspaceId: "ws-some-other-workspace", generation: 1, sortedVisible: [{ record_id: "record:phantom", record_digest: "sha256:phantom" }] };
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, otherWorkspaceCorpus)).rejects.toThrow(/record_occurrences/);
    });
  });

  it("URDIRA_DIGEST_CORPUS=0 forces the SQL path even when the corpus otherwise matches", async () => {
    await withWorkspace(async (opened) => {
      const templateB = recordTemplate("CorpusUnitKillSwitch");
      const explodingDatabase = explodingRecordOccurrencesDatabase(opened.database);
      const corpus: RecordSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 1, sortedVisible: [] };
      const previous = process.env["URDIRA_DIGEST_CORPUS"];
      process.env["URDIRA_DIGEST_CORPUS"] = "0";
      try {
        await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, corpus)).rejects.toThrow(/record_occurrences/);
      } finally {
        if (previous === undefined) delete process.env["URDIRA_DIGEST_CORPUS"];
        else process.env["URDIRA_DIGEST_CORPUS"] = previous;
      }
      // The kill switch is scoped to that one call: with the env var restored,
      // the exact same corpus is trusted again.
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [templateB], [], undefined, corpus)).resolves.toBeDefined();
    });
  });

  // End-to-end through the real `publishCandidate` path (not a direct
  // `computeSnapshotDigestFields` call): publishes generation 1, then an edit
  // publish (generation 2) that -- inside `WorkspaceDatabase`, opaque to this
  // test -- reuses the handle's warm corpus instead of re-reading
  // `record_occurrences`. Proves the production wiring (not just the function in
  // isolation) produces a `canonical_record_set_digest` that (a) passes
  // `StorageMaintenance.verify()`'s independent recomputation and (b) matches an
  // independently-invoked SQL-path call byte-for-byte.
  it("produces a verify()-clean, SQL-path-identical digest through two real publishes (first cold, second warm)", async () => {
    await withWorkspace(async (opened) => {
      const firstInput = sealedInput("candidate-corpus-e2e-first", "corpus-e2e-first", initialBase);
      await opened.candidates.insert(firstInput.candidate, firstInput.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-corpus-e2e-a", "version-corpus-e2e-a");
      const templatedFirst = withTemplateSets(firstInput, {
        record_opens: [recordTemplate("CorpusE2EA", { artifactId: "artifact-corpus-e2e-a", artifactVersionId: "version-corpus-e2e-a" })],
      });
      const first = await opened.publishCandidate(templatedFirst);
      expect(first).toMatchObject({ status: "published", generation: 1 });

      const secondBase = nextBase(first, "corpus-e2e-first");
      const secondInput = sealedInput("candidate-corpus-e2e-second", "corpus-e2e-second", secondBase);
      await opened.candidates.insert(secondInput.candidate, secondInput.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-corpus-e2e-b", "version-corpus-e2e-b");
      const templatedSecond = withTemplateSets(secondInput, {
        record_opens: [recordTemplate("CorpusE2EB", { artifactId: "artifact-corpus-e2e-b", artifactVersionId: "version-corpus-e2e-b" })],
      });
      const second = await opened.publishCandidate(templatedSecond);
      expect(second).toMatchObject({ status: "published", generation: 2 });

      const report = await opened.maintenance.verify();
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);

      const storedSnapshot = await opened.database.get<{ canonical_record_set_digest: string }>("SELECT canonical_record_set_digest FROM snapshots WHERE workspace_id = ? AND generation = 2", [workspace.workspace_id]);
      const viaSql = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, { current_generation: 1 } as never, 2, templatedSecond.template_sets.record_opens, []);
      expect(storedSnapshot?.canonical_record_set_digest).toBe(viaSql.canonical_record_set_digest);
      const rows = await opened.database.all<{ record_id: string }>("SELECT record_id FROM record_occurrences WHERE workspace_id = ? ORDER BY record_id", [workspace.workspace_id]);
      expect(rows).toHaveLength(2);
    });
  });

  // Correctness requirement: a failed/rolled-back publish must not advance the
  // corpus. Publishes generation 1 (seeds the corpus), then a generation-2
  // attempt that fails via an in-transaction fault (`candidate_publication.before_commit`
  // fires as a SQL command inside the transaction, after `computeSnapshotDigestFields`
  // already ran in JS and would -- if the corpus were written eagerly instead of
  // only after commit -- have poisoned the handle's corpus with this failed
  // attempt's never-committed record). A DIFFERENT candidate then successfully
  // takes generation 2 with DIFFERENT records; a final generation-3 no-op publish
  // must still see the REAL generation-2 visible set, not the phantom one from the
  // failed attempt -- checked both via `verify()` and an independent SQL recompute.
  it("does not let a failed publish poison the corpus for the next successful publish", async () => {
    // `withWorkspace`'s single-boundary fault injector (`createFaultInjector`) is
    // single-shot across the WHOLE workspace, and "candidate_publication.before_commit"
    // fires on every candidate publish's `currentCommands` (`publicationFaultCommand`
    // gates whether the fault command is embedded, via `isPending`) -- so a plain
    // `withWorkspace(..., "candidate_publication.before_commit")` would fault the
    // FIRST publish, not the second one this test needs to fail. This armable
    // injector only reports the boundary pending while explicitly armed, and
    // self-disarms the moment `isPending` reports it (single-shot, like
    // `createFaultInjector`), so only the one publish attempt armed for is faulted.
    let armed = false;
    const faultInjector: FaultInjector = {
      hit: () => undefined,
      isPending: (boundary) => {
        if (armed && boundary === "candidate_publication.before_commit") { armed = false; return true; }
        return false;
      },
    };
    const root = await mkdtemp(join(tmpdir(), "urdira-phase9-publication-corpus-fault-"));
    const storage = await createDurableStorage({ rootDir: root, fault_injector: faultInjector });
    try {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      try {
        const firstInput = sealedInput("candidate-corpus-fault-first", "corpus-fault-first", initialBase);
        await opened.candidates.insert(firstInput.candidate, firstInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-corpus-fault-a", "version-corpus-fault-a");
        const templatedFirst = withTemplateSets(firstInput, {
          record_opens: [recordTemplate("CorpusFaultA", { artifactId: "artifact-corpus-fault-a", artifactVersionId: "version-corpus-fault-a" })],
        });
        const first = await opened.publishCandidate(templatedFirst);
        expect(first).toMatchObject({ status: "published", generation: 1 });

        const secondBase = nextBase(first, "corpus-fault-first");
        const failingInput = sealedInput("candidate-corpus-fault-failing", "corpus-fault-failing", secondBase);
        await opened.candidates.insert(failingInput.candidate, failingInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-corpus-fault-phantom", "version-corpus-fault-phantom");
        const templatedFailing = withTemplateSets(failingInput, {
          record_opens: [recordTemplate("CorpusFaultPhantom", { artifactId: "artifact-corpus-fault-phantom", artifactVersionId: "version-corpus-fault-phantom" })],
        });
        armed = true;
        await expect(opened.publishCandidate(templatedFailing)).rejects.toMatchObject({ code: "storage:fault_injected" });
        expect(armed).toBe(false);

        const retryInput = sealedInput("candidate-corpus-fault-retry", "corpus-fault-retry", secondBase);
        await opened.candidates.insert(retryInput.candidate, retryInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-corpus-fault-real", "version-corpus-fault-real");
        const templatedRetry = withTemplateSets(retryInput, {
          record_opens: [recordTemplate("CorpusFaultReal", { artifactId: "artifact-corpus-fault-real", artifactVersionId: "version-corpus-fault-real" })],
        });
        const retry = await opened.publishCandidate(templatedRetry);
        expect(retry).toMatchObject({ status: "published", generation: 2 });

        const thirdBase = nextBase(retry, "corpus-fault-retry");
        const thirdInput = sealedInput("candidate-corpus-fault-third", "corpus-fault-third", thirdBase);
        await opened.candidates.insert(thirdInput.candidate, thirdInput.frozen_base);
        const third = await opened.publishCandidate(withTemplateSets(thirdInput, {}));
        expect(third).toMatchObject({ status: "published", generation: 3 });

        const report = await opened.maintenance.verify();
        expect(report.failures).toEqual([]);
        expect(report.ok).toBe(true);

        const storedSnapshot = await opened.database.get<{ canonical_record_set_digest: string }>("SELECT canonical_record_set_digest FROM snapshots WHERE workspace_id = ? AND generation = 3", [workspace.workspace_id]);
        const viaSql = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, { current_generation: 2 } as never, 3, [], []);
        expect(storedSnapshot?.canonical_record_set_digest).toBe(viaSql.canonical_record_set_digest);
        // The phantom record from the rolled-back attempt never actually committed.
        const rows = await opened.database.all<{ record_id: string }>("SELECT record_id FROM record_occurrences WHERE workspace_id = ? ORDER BY record_id", [workspace.workspace_id]);
        expect(rows).toHaveLength(2);
      } finally { await opened.close(); }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  // --- Warm projection-set digest corpus (ProjectionSetDigestCorpusEntry) ---
  // Mirrors the record-set corpus tests above, one section down, reusing
  // `sealedInput`/`nextBase` (generic across both corpora) and following the
  // same "direct unit calls first, then real end-to-end publishes" shape.

  // `generation` must match the generation this entry is actually published
  // under: `artifactDependencyCommands` (`publication-authority.ts`) stores
  // `encodeCanonical(value)` -- the raw entry, untouched -- as
  // `dependency_payload`, and `StorageMaintenance.verify()` byte-compares
  // that against a typed-column reconstruction that INCLUDES
  // `valid_from_generation` (mirroring the real `RecordArtifactDependency`
  // contract shape, decisions/01-universal-data-model.md, which a real
  // analyzer's template entries also carry) -- an entry missing it, or
  // carrying the wrong value, fails `verify()` with `storage:dependency_corrupt`
  // for a reason unrelated to anything this test suite is actually about.
  function dependencyTemplate(id: string, owner: { artifactId: string; artifactVersionId: string }, generation: number): Record<string, unknown> {
    return { dependency_entry_id: id, record_id: `record-${id}`, owner_artifact_id: owner.artifactId, owner_artifact_version_id: owner.artifactVersionId, dependency_artifact_id: owner.artifactId, dependency_artifact_version_id: owner.artifactVersionId, dependency_role: "import", producer_id: "producer", producer_version: "1", valid_from_generation: generation };
  }

  // Same idea as `explodingRecordOccurrencesDatabase` above, for the three
  // transactional projection tables the projection-set digest corpus caches
  // (`graph_edges`/`artifact_dependencies`/`metric_projections`).
  function explodingProjectionTablesDatabase(db: SqliteDatabase): SqliteDatabase {
    return {
      filename: db.filename,
      async exec(sql: string) { return db.exec(sql); },
      async run(sql: string, params?: readonly SqliteValue[]) { return db.run(sql, params); },
      async get<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]) { return db.get<T>(sql, params); },
      async all<T extends Record<string, unknown>>(sql: string, params?: readonly SqliteValue[]): Promise<readonly T[]> {
        if (sql.includes("graph_edges") || sql.includes("artifact_dependencies") || sql.includes("metric_projections")) throw new Error("computeSnapshotDigestFields must not re-read the transactional projection tables when its warm projection corpus is valid.");
        return db.all<T>(sql, params);
      },
      async transaction(commands) { return db.transaction(commands); },
      async transactionChunked(commands, chunkSize, options) { return db.transactionChunked(commands, chunkSize, options); },
      async close() { return db.close(); },
    };
  }

  const emptyProjectionCorpus = (generation: number): ProjectionSetDigestCorpusEntry => ({ workspaceId: workspace.workspace_id, generation, sortedByKind: { graph: [], dependency: [], metric: [] } });

  // Direct-call equivalence test (keeps the corpus-vs-SQL comparison at the
  // `computeSnapshotDigestFields` level, independent of a real publish):
  // whether the old rows come from a matching corpus or a live SQL read, THIS
  // publish's own `artifact_dependencies` opens must be folded into the
  // result the SAME way in both paths -- `artifactDependencyDigestOpens` +
  // `mergeProjectionKindRows`, mirroring `recordOpens`/`recordClosures` being
  // folded into `sortedVisible` for the record set (see
  // `computeSnapshotDigestFields`'s doc comment; this is the fixed
  // semantics -- an earlier version of this function computed
  // `projection_set_digests` from the pre-transaction rows alone, which a
  // separate e2e test below catches against `verify()`).
  it("computeSnapshotDigestFields folds THIS publish's own artifact_dependencies opens into the digest the same way whether corpus-fed or SQL-fed", async () => {
    await withWorkspace(async (opened) => {
      const explodingDatabase = explodingProjectionTablesDatabase(opened.database);
      const dep = dependencyTemplate("dep-corpus-unit-b", { artifactId: "artifact-corpus-unit", artifactVersionId: "version-corpus-unit" }, 2);
      // The workspace's `artifact_dependencies` table is empty (no candidate has
      // ever been published here) -- both the corpus-fed call and the plain
      // SQL-path call below therefore start generation 2 from the same true
      // empty base, so any divergence can only come from the corpus plumbing.
      const withCorpus = await computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [dep], emptyProjectionCorpus(1));
      const viaSql = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [dep]);
      expect(withCorpus.projection_set_digests).toBe(viaSql.projection_set_digests);
      expect(withCorpus.sortedProjectionsByKind).toEqual(viaSql.sortedProjectionsByKind);
      // This publish's own `dep` open shows up in BOTH the candidate for the
      // next publish AND (the fix) this publish's own `projection_set_digests`
      // -- not vacuously equal to an all-empty baseline.
      expect(withCorpus.sortedProjectionsByKind.dependency.map((row) => row.projection_record_id)).toEqual(["dep-corpus-unit-b@2"]);
      expect(withCorpus.sortedProjectionsByKind.graph).toEqual([]);
      expect(withCorpus.sortedProjectionsByKind.metric).toEqual([]);
      const allEmptyDigests = JSON.stringify(await projectionSetDigestEntries(opened.database, workspace.workspace_id, 2, { digest_source: "stored" }));
      expect(withCorpus.projection_set_digests).not.toBe(allEmptyDigests);

      // Seeding the corpus with a real prior-generation dependency (again
      // simulated via a direct `computeSnapshotDigestFields` call, which is a
      // pure read/merge function with no side effects -- exactly what
      // generation 1's own plan build would have produced) must layer on top
      // of it: generation 2's digest and candidate both carry BOTH rows.
      const priorDep = dependencyTemplate("dep-corpus-unit-a", { artifactId: "artifact-corpus-unit", artifactVersionId: "version-corpus-unit" }, 1);
      const seeded = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, undefined, 1, [], [], undefined, undefined, [priorDep]);
      const seededCorpus: ProjectionSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 1, sortedByKind: seeded.sortedProjectionsByKind };
      expect(seededCorpus.sortedByKind.dependency.map((row) => row.projection_record_id)).toEqual(["dep-corpus-unit-a@1"]);
      const withSeededCorpus = await computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [dep], seededCorpus);
      expect(withSeededCorpus.projection_set_digests).not.toBe(withCorpus.projection_set_digests);
      expect(withSeededCorpus.sortedProjectionsByKind.dependency.map((row) => row.projection_record_id).sort()).toEqual(["dep-corpus-unit-a@1", "dep-corpus-unit-b@2"]);
      // The digest itself (not just the candidate) now describes BOTH rows --
      // confirmed against an independent `row_overrides` call over that exact
      // merged set.
      const expectedSeededDigests = JSON.stringify(await projectionSetDigestEntries(opened.database, workspace.workspace_id, 2, { digest_source: "stored", row_overrides: withSeededCorpus.sortedProjectionsByKind }));
      expect(withSeededCorpus.projection_set_digests).toBe(expectedSeededDigests);
    });
  });

  it("falls back to the SQL read when the projection corpus generation does not match oldGeneration", async () => {
    await withWorkspace(async (opened) => {
      const explodingDatabase = explodingProjectionTablesDatabase(opened.database);
      const staleCorpus: ProjectionSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 99, sortedByKind: { graph: [], dependency: [{ projection_record_id: "phantom@99", content_digest: "sha256:phantom" }], metric: [] } };
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [], staleCorpus)).rejects.toThrow(/must not re-read the transactional projection tables/);
    });
  });

  it("never trusts a projection corpus entry sealed for a different workspace (no cross-workspace leakage)", async () => {
    await withWorkspace(async (opened) => {
      const explodingDatabase = explodingProjectionTablesDatabase(opened.database);
      const otherWorkspaceCorpus: ProjectionSetDigestCorpusEntry = { workspaceId: "ws-some-other-workspace", generation: 1, sortedByKind: { graph: [], dependency: [{ projection_record_id: "phantom@1", content_digest: "sha256:phantom" }], metric: [] } };
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [], otherWorkspaceCorpus)).rejects.toThrow(/must not re-read the transactional projection tables/);
    });
  });

  it("URDIRA_DIGEST_CORPUS=0 forces the SQL path even when the projection corpus otherwise matches", async () => {
    await withWorkspace(async (opened) => {
      const explodingDatabase = explodingProjectionTablesDatabase(opened.database);
      const corpus = emptyProjectionCorpus(1);
      const previous = process.env["URDIRA_DIGEST_CORPUS"];
      process.env["URDIRA_DIGEST_CORPUS"] = "0";
      try {
        await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [], corpus)).rejects.toThrow(/must not re-read the transactional projection tables/);
      } finally {
        if (previous === undefined) delete process.env["URDIRA_DIGEST_CORPUS"];
        else process.env["URDIRA_DIGEST_CORPUS"] = previous;
      }
      // The kill switch is scoped to that one call: with the env var restored,
      // the exact same corpus is trusted again.
      await expect(computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [], corpus)).resolves.toBeDefined();
    });
  });

  // Direct-call companion to the e2e "no projection changes" case below:
  // proves the corpus path itself (bypassing the real publish plumbing) is
  // safe when this publish's own `artifactDependencies` is empty -- the
  // merge is a no-op (`mergeProjectionKindRows` short-circuits on an empty
  // `opens` array) and the candidate is exactly the corpus's rows, unchanged.
  it("a publish with no projection changes still hits the corpus and stays correct", async () => {
    await withWorkspace(async (opened) => {
      const explodingDatabase = explodingProjectionTablesDatabase(opened.database);
      const corpus: ProjectionSetDigestCorpusEntry = { workspaceId: workspace.workspace_id, generation: 1, sortedByKind: { graph: [], dependency: [{ projection_record_id: "dep-nochange-a@1", content_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], metric: [] } };
      const withCorpus = await computeSnapshotDigestFields(explodingDatabase, workspace.workspace_id, { current_generation: 1 } as never, 2, [], [], undefined, undefined, [], corpus);
      // No SQL read happened (the exploding database would have thrown), and
      // the digest is exactly what a live read of the corpus's own rows,
      // unmerged, would produce; the stashed candidate is untouched too.
      expect(withCorpus.projection_set_digests).toBe(JSON.stringify(await projectionSetDigestEntries(opened.database, workspace.workspace_id, 2, { digest_source: "stored", row_overrides: corpus.sortedByKind })));
      expect(withCorpus.sortedProjectionsByKind).toEqual(corpus.sortedByKind);
    });
  });

  // End-to-end companion: publishes generation 1 with one dependency, then a
  // real generation-2 publish whose `artifact_dependencies` template is
  // EMPTY (a genuine "edit with no projection-affecting change" rescan).
  // Generation 2's own corpus-fed digest must still match an independent
  // live read of generation 1's committed state (the correct point-in-time
  // comparison -- see the two-real-publishes test below for why a live read
  // taken AFTER generation 2 commits is not the right comparison).
  it("a real edit publish with no new artifact_dependencies produces a digest matching the prior generation's committed state", async () => {
    await withWorkspace(async (opened) => {
      const firstInput = sealedInput("candidate-projcorpus-nochange-first", "projcorpus-nochange-first", initialBase);
      await opened.candidates.insert(firstInput.candidate, firstInput.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-nochange-a", "version-projcorpus-nochange-a");
      const templatedFirst = withTemplateSets(firstInput, {
        artifact_dependencies: [dependencyTemplate("dep-projcorpus-nochange-a", { artifactId: "artifact-projcorpus-nochange-a", artifactVersionId: "version-projcorpus-nochange-a" }, 1)],
      });
      const first = await opened.publishCandidate(templatedFirst);
      expect(first).toMatchObject({ status: "published", generation: 1 });
      const liveAtGenerationOne = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "stored" });

      const secondBase = nextBase(first, "projcorpus-nochange-first");
      const secondInput = sealedInput("candidate-projcorpus-nochange-second", "projcorpus-nochange-second", secondBase);
      await opened.candidates.insert(secondInput.candidate, secondInput.frozen_base);
      const second = await opened.publishCandidate(withTemplateSets(secondInput, {}));
      expect(second).toMatchObject({ status: "published", generation: 2 });

      const storedSnapshot = await opened.database.get<{ projection_set_digests: string }>("SELECT projection_set_digests FROM snapshots WHERE workspace_id = ? AND generation = 2", [workspace.workspace_id]);
      expect(storedSnapshot?.projection_set_digests).toBe(JSON.stringify(liveAtGenerationOne));
      // No new dependency row was written -- the table still has exactly the one from generation 1.
      const rows = await opened.database.all<{ dependency_entry_id: string }>("SELECT dependency_entry_id FROM artifact_dependencies WHERE workspace_id = ?", [workspace.workspace_id]);
      expect(rows.map((row) => row.dependency_entry_id)).toEqual(["dep-projcorpus-nochange-a"]);
    });
  });

  // End-to-end through the real `publishCandidate` path: publishes generation 1
  // (cold, SQL path -- with one artifact_dependency), then an edit publish
  // (generation 2, warm -- inside `WorkspaceDatabase`, opaque to this test,
  // reuses the handle's warm projection corpus instead of re-reading
  // `artifact_dependencies`/`graph_edges`/`metric_projections` -- with a
  // second, different artifact_dependency), then a third, no-op-template
  // publish (generation 3, warm, no new dependency). This is the FIXED
  // semantics's central guarantee (`computeSnapshotDigestFields`'s doc
  // comment): each generation's own stored `projection_set_digests` already
  // includes THAT generation's own new dependency rows, so it byte-matches
  // an independent `projectionSetDigestEntries(..., "recompute")` call taken
  // AFTER that same generation's publish commits (not one generation
  // earlier, the way the pre-fix code required), on BOTH the cold (gen 1)
  // and warm (gen 2, gen 3) paths -- and `StorageMaintenance.verify()` is
  // clean on every one of them.
  it("produces a verify()-clean projection digest matching a post-commit recompute at the SAME generation, cold and warm", async () => {
    await withWorkspace(async (opened) => {
      const firstInput = sealedInput("candidate-projcorpus-e2e-first", "projcorpus-e2e-first", initialBase);
      await opened.candidates.insert(firstInput.candidate, firstInput.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-e2e-a", "version-projcorpus-e2e-a");
      const templatedFirst = withTemplateSets(firstInput, {
        artifact_dependencies: [dependencyTemplate("dep-projcorpus-e2e-a", { artifactId: "artifact-projcorpus-e2e-a", artifactVersionId: "version-projcorpus-e2e-a" }, 1)],
      });
      const first = await opened.publishCandidate(templatedFirst);
      expect(first).toMatchObject({ status: "published", generation: 1 });

      const storedFirst = await opened.database.get<{ projection_set_digests: string }>("SELECT projection_set_digests FROM snapshots WHERE workspace_id = ? AND generation = 1", [workspace.workspace_id]);
      const recomputedAtOne = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 1, { digest_source: "recompute" });
      expect(storedFirst?.projection_set_digests).toBe(JSON.stringify(recomputedAtOne));
      expect(recomputedAtOne.find((entry) => entry.projection_kind === "dependency")).toBeDefined();
      const verifyAfterFirst = await opened.maintenance.verify();
      expect(verifyAfterFirst.failures.filter((failure) => failure.error_code === "storage:projection_set_digest_corrupt")).toEqual([]);
      expect(verifyAfterFirst.ok).toBe(true);

      const secondBase = nextBase(first, "projcorpus-e2e-first");
      const secondInput = sealedInput("candidate-projcorpus-e2e-second", "projcorpus-e2e-second", secondBase);
      await opened.candidates.insert(secondInput.candidate, secondInput.frozen_base);
      await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-e2e-b", "version-projcorpus-e2e-b");
      const templatedSecond = withTemplateSets(secondInput, {
        artifact_dependencies: [dependencyTemplate("dep-projcorpus-e2e-b", { artifactId: "artifact-projcorpus-e2e-b", artifactVersionId: "version-projcorpus-e2e-b" }, 2)],
      });
      const second = await opened.publishCandidate(templatedSecond);
      expect(second).toMatchObject({ status: "published", generation: 2 });

      const storedSecond = await opened.database.get<{ projection_set_digests: string }>("SELECT projection_set_digests FROM snapshots WHERE workspace_id = ? AND generation = 2", [workspace.workspace_id]);
      const recomputedAtTwo = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 2, { digest_source: "recompute" });
      expect(storedSecond?.projection_set_digests).toBe(JSON.stringify(recomputedAtTwo));
      const verifyAfterSecond = await opened.maintenance.verify();
      expect(verifyAfterSecond.failures.filter((failure) => failure.error_code === "storage:projection_set_digest_corrupt")).toEqual([]);
      expect(verifyAfterSecond.ok).toBe(true);
      // Both generation 1's and generation 2's rows are visible now -- the
      // warm (corpus-fed) path folded generation 2's own new open in, exactly
      // like the cold path did for generation 1.
      const rowsAfterSecond = await opened.database.all<{ dependency_entry_id: string; valid_from_generation: number }>("SELECT dependency_entry_id, valid_from_generation FROM artifact_dependencies WHERE workspace_id = ? ORDER BY dependency_entry_id", [workspace.workspace_id]);
      expect(rowsAfterSecond.map((row) => `${row.dependency_entry_id}@${row.valid_from_generation}`)).toEqual(["dep-projcorpus-e2e-a@1", "dep-projcorpus-e2e-b@2"]);
      const dependencyEntryAtTwo = recomputedAtTwo.find((entry) => entry.projection_kind === "dependency");
      expect(dependencyEntryAtTwo?.projection_set_digest).not.toBe(recomputedAtOne.find((entry) => entry.projection_kind === "dependency")?.projection_set_digest);

      // A third, no-op-template publish (no new dependency): the merge is a
      // no-op, so the corpus carries generation 2's rows forward unchanged,
      // and this generation's own digest still matches a post-commit
      // recompute (trivially, since nothing changed) and stays verify()-clean.
      const thirdBase = nextBase(second, "projcorpus-e2e-second");
      const thirdInput = sealedInput("candidate-projcorpus-e2e-third", "projcorpus-e2e-third", thirdBase);
      await opened.candidates.insert(thirdInput.candidate, thirdInput.frozen_base);
      const third = await opened.publishCandidate(withTemplateSets(thirdInput, {}));
      expect(third).toMatchObject({ status: "published", generation: 3 });
      const storedThird = await opened.database.get<{ projection_set_digests: string }>("SELECT projection_set_digests FROM snapshots WHERE workspace_id = ? AND generation = 3", [workspace.workspace_id]);
      const recomputedAtThree = await projectionSetDigestEntries(opened.database, workspace.workspace_id, 3, { digest_source: "recompute" });
      expect(storedThird?.projection_set_digests).toBe(JSON.stringify(recomputedAtThree));
      expect(JSON.parse(storedThird?.projection_set_digests ?? "[]")).toEqual(JSON.parse(storedSecond?.projection_set_digests ?? "[]"));
      const verifyAfterThird = await opened.maintenance.verify();
      expect(verifyAfterThird.failures.filter((failure) => failure.error_code === "storage:projection_set_digest_corrupt")).toEqual([]);
      expect(verifyAfterThird.ok).toBe(true);
    });
  });

  // Correctness requirement mirroring the record-corpus fault test: a
  // failed/rolled-back publish must not advance the projection corpus. A
  // DIFFERENT candidate then successfully takes generation 2 with a
  // DIFFERENT artifact_dependency; a final generation-3 no-op publish must
  // still see the REAL generation-2 dependency row, not a phantom from the
  // failed attempt -- checked via an independent SQL recompute.
  it("does not let a failed publish poison the projection corpus for the next successful publish", async () => {
    let armed = false;
    const faultInjector: FaultInjector = {
      hit: () => undefined,
      isPending: (boundary) => {
        if (armed && boundary === "candidate_publication.before_commit") { armed = false; return true; }
        return false;
      },
    };
    const root = await mkdtemp(join(tmpdir(), "urdira-phase9-publication-projcorpus-fault-"));
    const storage = await createDurableStorage({ rootDir: root, fault_injector: faultInjector });
    try {
      await storage.catalog.registerWorkspace(workspace);
      const opened = await storage.openWorkspace(workspace.workspace_id);
      try {
        const firstInput = sealedInput("candidate-projcorpus-fault-first", "projcorpus-fault-first", initialBase);
        await opened.candidates.insert(firstInput.candidate, firstInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-fault-a", "version-projcorpus-fault-a");
        const templatedFirst = withTemplateSets(firstInput, {
          artifact_dependencies: [dependencyTemplate("dep-projcorpus-fault-a", { artifactId: "artifact-projcorpus-fault-a", artifactVersionId: "version-projcorpus-fault-a" }, 1)],
        });
        const first = await opened.publishCandidate(templatedFirst);
        expect(first).toMatchObject({ status: "published", generation: 1 });

        const secondBase = nextBase(first, "projcorpus-fault-first");
        const failingInput = sealedInput("candidate-projcorpus-fault-failing", "projcorpus-fault-failing", secondBase);
        await opened.candidates.insert(failingInput.candidate, failingInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-fault-phantom", "version-projcorpus-fault-phantom");
        const templatedFailing = withTemplateSets(failingInput, {
          artifact_dependencies: [dependencyTemplate("dep-projcorpus-fault-phantom", { artifactId: "artifact-projcorpus-fault-phantom", artifactVersionId: "version-projcorpus-fault-phantom" }, 2)],
        });
        armed = true;
        await expect(opened.publishCandidate(templatedFailing)).rejects.toMatchObject({ code: "storage:fault_injected" });
        expect(armed).toBe(false);

        const retryInput = sealedInput("candidate-projcorpus-fault-retry", "projcorpus-fault-retry", secondBase);
        await opened.candidates.insert(retryInput.candidate, retryInput.frozen_base);
        await seedReconciliationOwner(opened, workspace.workspace_id, "artifact-projcorpus-fault-real", "version-projcorpus-fault-real");
        const templatedRetry = withTemplateSets(retryInput, {
          artifact_dependencies: [dependencyTemplate("dep-projcorpus-fault-real", { artifactId: "artifact-projcorpus-fault-real", artifactVersionId: "version-projcorpus-fault-real" }, 2)],
        });
        const retry = await opened.publishCandidate(templatedRetry);
        expect(retry).toMatchObject({ status: "published", generation: 2 });

        const thirdBase = nextBase(retry, "projcorpus-fault-retry");
        const thirdInput = sealedInput("candidate-projcorpus-fault-third", "projcorpus-fault-third", thirdBase);
        await opened.candidates.insert(thirdInput.candidate, thirdInput.frozen_base);
        const third = await opened.publishCandidate(withTemplateSets(thirdInput, {}));
        expect(third).toMatchObject({ status: "published", generation: 3 });

        const storedThird = await opened.database.get<{ projection_set_digests: string }>("SELECT projection_set_digests FROM snapshots WHERE workspace_id = ? AND generation = 3", [workspace.workspace_id]);
        const viaSql = await computeSnapshotDigestFields(opened.database, workspace.workspace_id, { current_generation: 2 } as never, 3, [], [], undefined, undefined, []);
        expect(storedThird?.projection_set_digests).toBe(viaSql.projection_set_digests);
        // The phantom dependency from the rolled-back attempt never actually committed.
        const rows = await opened.database.all<{ dependency_entry_id: string }>("SELECT dependency_entry_id FROM artifact_dependencies WHERE workspace_id = ? ORDER BY dependency_entry_id", [workspace.workspace_id]);
        expect(rows.map((row) => row.dependency_entry_id)).toEqual(["dep-projcorpus-fault-a", "dep-projcorpus-fault-real"]);
      } finally { await opened.close(); }
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
