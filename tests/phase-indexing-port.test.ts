import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, digestBytes, digestCanonicalArray } from "@urdira/canonical";
import { createDurableStorage, type CandidatePublicationInput, type CandidateTemplateSets, type WorkspaceDatabase } from "../packages/storage/src/index.js";
import { createWorkspaceCandidatePort } from "../packages/engine/src/index.js";

// `createWorkspaceCandidatePort` is typed against `@urdira/storage`'s published
// (dist) declarations, since that is the real dependency `packages/engine`
// declares. This test file, like the rest of `tests/`, imports storage
// directly from `src` for whitebox access. Within `tsconfig.tests.json`'s
// single flat program (which compiles every package's `src` alongside the
// bare-specifier resolution used by inter-package imports), those are two
// distinct declarations of the same runtime class, so a private field makes
// them nominally incompatible even though the object is identical at
// runtime. Per-package builds (what `apps/urdira`/`packages/daemon` actually
// use) don't hit this — it is specific to this combined test program.
function asPortWorkspace(database: WorkspaceDatabase): Parameters<typeof createWorkspaceCandidatePort>[0] {
  return database as unknown as Parameters<typeof createWorkspaceCandidatePort>[0];
}

const workspace = {
  workspace_id: "ws-indexing-port",
  canonical_root: "/indexing-port",
  display_root: "/indexing-port",
  source_provider_bindings: [],
  status: "registered",
  registered_at: "2026-08-11T00:00:00.000Z",
};

const now = "2026-08-11T00:00:00.000Z";
const digest = (value: unknown): string => digestBytes(canonicalBytes(value));

// Mirrors `packages/engine/src/candidate-materialization.ts`'s `orderedSetDescriptor`:
// the materialization's template-set fields carry a small, bounded
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

async function withWorkspace(test: (opened: WorkspaceDatabase) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "urdira-indexing-port-"));
  const storage = await createDurableStorage({ rootDir: root });
  try {
    await storage.catalog.registerWorkspace(workspace);
    const opened = await storage.openWorkspace(workspace.workspace_id);
    try { await test(opened); } finally { await opened.close(); }
  } finally {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

function minimalCandidate(candidateId: string): { candidate: Record<string, unknown>; frozenBase: Record<string, unknown> } {
  const frozenBaseCore = { source_state_digest: `source-${candidateId}`, source_observation_batch_ids: [] as readonly string[] };
  return {
    candidate: {
      candidate_generation_id: candidateId,
      workspace_id: workspace.workspace_id,
      target_registry_snapshot_id: `registry-${candidateId}`,
      target_configuration_revision_id: `configuration-${candidateId}`,
      trigger_kind: "test",
      state: "queued",
      source_observation_batch_ids: [],
      created_at: now,
      issue_ids: [],
    },
    frozenBase: { ...frozenBaseCore, tuple_digest: digest(frozenBaseCore) },
  };
}

function fullPublication(candidateId: string): CandidatePublicationInput {
  const { frozenBase } = minimalCandidate(candidateId);
  const registryId = `registry-${candidateId}`;
  const lockId = `lock-${candidateId}`;
  const configurationId = `configuration-${candidateId}`;
  const snapshotId = `snapshot-${candidateId}`;
  return {
    candidate: {
      candidate_generation_id: candidateId,
      workspace_id: workspace.workspace_id,
      target_registry_snapshot_id: registryId,
      target_configuration_revision_id: configurationId,
      trigger_kind: "test",
      state: "ready",
      source_observation_batch_ids: [],
      created_at: now,
      issue_ids: [],
    },
    frozen_base: frozenBase as never,
    materialization: {
      candidate_materialization_id: `materialization-${candidateId}`,
      workspace_id: workspace.workspace_id,
      accepted_fact_delta_digests: [],
      source_transition_template_set: orderedSetDescriptorJson("core:CandidateSourceTransitionTemplate", []),
      record_open_template_set: orderedSetDescriptorJson("core:CandidateRecordOpenTemplate", []),
      record_closure_template_set: orderedSetDescriptorJson("core:CandidateRecordClosureTemplate", []),
      identity_assignment_template_set: orderedSetDescriptorJson("core:CandidateIdentityAssignmentTemplate", []),
      artifact_dependency_template_set: orderedSetDescriptorJson("core:RecordArtifactDependency", []),
      lookup_dependency_template_set: orderedSetDescriptorJson("core:PluginLookupInvalidationDependency", []),
      lookup_revalidation_template_set: orderedSetDescriptorJson("core:LookupRevalidationTemplate", []),
      projection_open_template_sets: [],
      projection_closure_template_sets: [],
      capability_state_entries: [],
      source_observation_watermarks: [],
      materialization_digest: digest(`materialization-${candidateId}`),
    } as never,
    template_sets: emptyTemplateSets,
    target_registry: {
      registry_snapshot_id: registryId,
      registry_contract_version: "1",
      core_registry_digest: `core-${candidateId}`,
      resolution_lock_id: lockId,
      namespace_bindings: [],
      registry_digest: digest(registryId),
    } as never,
    target_resolution_lock: {
      resolution_lock_id: lockId,
      workspace_id: workspace.workspace_id,
      resolver_version: "1",
      resolved_plugins: [],
      lock_digest: digest(lockId),
      created_at: now,
    } as never,
    target_configuration: {
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
    } as never,
    freshness_checkpoint: {
      freshness_checkpoint_id: `freshness-${candidateId}`,
      workspace_id: workspace.workspace_id,
      snapshot_id: snapshotId,
      source_state_digest: frozenBase["source_state_digest"],
      provider_watermarks: "[]",
      verification_status: "complete",
      unavailable_artifact_ids: "[]",
      verified_at: now,
      checkpoint_digest: digest(`freshness-${candidateId}`),
    } as never,
    publication_kind: "activation",
  };
}

describe("workspace candidate repository lease lifecycle", () => {
  it("renews an active lease and rejects renewal without one", async () => {
    await withWorkspace(async (opened) => {
      const { candidate, frozenBase } = minimalCandidate("candidate-lease");
      await opened.candidates.insert(candidate as never, frozenBase as never);
      await expect(opened.candidates.renewLease("candidate-lease")).rejects.toMatchObject({ code: "storage:candidate_lease_not_found" });

      await opened.candidates.acquireLease("candidate-lease", undefined, "2026-08-11T00:00:00.000Z");
      await expect(opened.candidates.renewLease("candidate-lease", "2026-08-11T00:05:00.000Z")).resolves.toBeUndefined();
      const lease = await opened.candidates.getLease("candidate-lease");
      expect(lease).toMatchObject({ acquired_at: "2026-08-11T00:05:00.000Z" });
    });
  });

  it("releases a lease idempotently, including when no lease was ever acquired", async () => {
    await withWorkspace(async (opened) => {
      const { candidate, frozenBase } = minimalCandidate("candidate-release");
      await opened.candidates.insert(candidate as never, frozenBase as never);

      await expect(opened.candidates.releaseLease("candidate-release")).resolves.toBe("already_released");

      await opened.candidates.acquireLease("candidate-release", undefined);
      await expect(opened.candidates.releaseLease("candidate-release")).resolves.toBe("released");
      await expect(opened.candidates.releaseLease("candidate-release")).resolves.toBe("already_released");
    });
  });
});

describe("createWorkspaceCandidatePort", () => {
  it("composes a CandidateWorkspacePort over real durable storage", async () => {
    await withWorkspace(async (opened) => {
      const port = createWorkspaceCandidatePort(asPortWorkspace(opened));
      const { candidate, frozenBase } = minimalCandidate("candidate-port");
      await port.candidates.insert(candidate as never, frozenBase as never);

      await expect(port.committedPublication("candidate-port")).resolves.toBeUndefined();
      await port.acquireBaseLease(candidate as never);
      await expect(port.releaseBaseLease("candidate-port")).resolves.toBe("released");
      await expect(port.releaseBaseLease("candidate-port")).resolves.toBe("already_released");

      await expect(port.cleanupResource("candidate-port", { resource_type: "temporary_blob", resource_id: "blob-1" })).resolves.toBe("cleaned");
      await expect(port.cleanupResource("candidate-port", { resource_type: "temporary_blob", resource_id: "blob-1" })).resolves.toBe("already_clean");

      await port.candidates.transition("candidate-port", "queued", "planning", {});
      await port.candidates.transition("candidate-port", "planning", "analyzing", {});
      await port.candidates.transition("candidate-port", "analyzing", "validating", {});
      await port.candidates.transition("candidate-port", "validating", "projecting", {});
      await port.candidates.transition("candidate-port", "projecting", "ready", {});
      await port.candidates.transition("candidate-port", "ready", "publishing", {});

      const publication = fullPublication("candidate-port");
      const result = await port.publishCandidate(publication);
      expect(result.status).toBe("published");

      const committed = await port.committedPublication("candidate-port");
      expect(committed).toMatchObject({ candidate_generation_id: "candidate-port", status: "published" });

      expect(await port.currentBase?.("candidate-port")).toMatchObject({ source_state_digest: frozenBase["source_state_digest"] });
    });
  });

  it("delegates issue appending to the candidate repository", async () => {
    await withWorkspace(async (opened) => {
      const port = createWorkspaceCandidatePort(asPortWorkspace(opened));
      const { candidate, frozenBase } = minimalCandidate("candidate-issue");
      await port.candidates.insert(candidate as never, frozenBase as never);

      await port.issues.append({
        candidate_issue_id: "issue-port",
        candidate_generation_id: "candidate-issue",
        issue_code: "test_issue",
        phase: "validation",
        severity: "warning",
        scope: { scope_type: "workspace", workspace_id: workspace.workspace_id },
        retryability: "retryable",
        summary: "summary",
        detail: "detail",
        cause_references: "[]",
        payload: {},
        created_at: now,
      } as never);

      expect(await opened.candidates.listIssues("candidate-issue")).toEqual([expect.objectContaining({ candidate_issue_id: "issue-port" })]);
    });
  });
});
