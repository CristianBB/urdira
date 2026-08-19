import { describe, expect, it } from "vitest";
import type { SourceProviderDescribeResult, WorkspaceSourceProviderBinding } from "@urdira/contracts";
import {
  WorkspaceRegistry,
  type RegisteredCodebase,
  type RegisteredWorkspace,
  type SourceProviderBindingInput,
  type SourceProviderDescription,
  type WorkspaceRegistration,
  type WorkspaceReconciliationResult,
  type WorkspaceRegistryPersistence,
  type WorkspaceRegistryState,
} from "../packages/engine/src/index.js";

const description = (fingerprint: string, identity = "filesystem:42"): SourceProviderDescription => ({
  provider_kind: "core:directory_source_provider",
  immutable_binding_identity: identity,
  features: "source-provider-features:v1",
  source_state_fingerprint: fingerprint,
});

const registration = (root: string, providerDescription = description("fingerprint:one")): WorkspaceRegistration => ({
  display_root: root,
  provider: {
    source_provider_binding_id: `binding:${root}`,
    source_provider: "core:directory_source_provider",
    source_provider_version: "1",
    provider_role: "primary",
    binding_identity: providerDescription.immutable_binding_identity,
    configuration_digest: "sha256:configuration",
  },
  description: providerDescription,
});

function registry(): WorkspaceRegistry {
  let identity = 0;
  let instant = 0;
  let reconciliation = 0;
  return new WorkspaceRegistry({
    create_id: (kind) => `${kind}:${++identity}`,
    create_reconciliation_id: () => `reconciliation:${++reconciliation}`,
    now: () => `2026-08-09T00:00:${String(instant++).padStart(2, "0")}.000Z`,
    canonicalize_root: (root) => root.replace(/\/$/u, "").toLocaleLowerCase("en-US"),
  });
}

const storedWorkspace = (overrides: Partial<RegisteredWorkspace> = {}): RegisteredWorkspace => ({
  workspace_id: "workspace:stored-one",
  canonical_root: "/stored/one",
  display_root: "/stored/one",
  provider: {
    source_provider_binding_id: "binding:stored-one",
    source_provider: "core:directory_source_provider",
    source_provider_version: "1",
    provider_role: "primary",
    binding_identity: "filesystem:stored-one",
    configuration_digest: "sha256:configuration",
  },
  source_state_fingerprint: "fingerprint:stored-one",
  status: "registering",
  registered_at: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

const storedCodebase = (overrides: Partial<RegisteredCodebase> = {}): RegisteredCodebase => ({
  codebase_id: "codebase:stored-one",
  display_name: "Stored project",
  created_at: "2026-08-09T00:00:00.000Z",
  ...overrides,
});

const restoring = (state: WorkspaceRegistryState): (() => WorkspaceRegistry) => () => new WorkspaceRegistry({
  persistence: { load: () => state, save: () => undefined },
});

describe("Phase 7 workspace lifecycle", () => {
  it("accepts the authoritative contract provider description and binding without an adapter shape", () => {
    const contractDescription: SourceProviderDescribeResult = description("fingerprint:contract");
    const engineDescription: SourceProviderDescription = contractDescription;
    const contractBinding: WorkspaceSourceProviderBinding = registration("/contract").provider;
    const engineBinding: SourceProviderBindingInput = contractBinding;

    const workspace = registry().register({
      ...registration("/contract", engineDescription),
      provider: engineBinding,
    });

    expect(workspace.provider).toEqual(contractBinding);
    expect(workspace.source_state_fingerprint).toBe("fingerprint:contract");
    expect(workspace).not.toHaveProperty("immutable_binding_identity");
  });

  it("rejects a describe result for a different immutable provider binding", () => {
    const input = registration("/contract", description("fingerprint:contract", "filesystem:describe"));

    expect(() => registry().register({
      ...input,
      provider: { ...input.provider, binding_identity: "filesystem:binding" },
    })).toThrow("engine:workspace_provider_mismatch");
  });

  it("restores stable workspace identity through the persistence port", () => {
    let saved: WorkspaceRegistryState | undefined;
    const persistence: WorkspaceRegistryPersistence = {
      load: () => saved,
      save: (state) => {
        saved = structuredClone(state);
      },
    };
    let identity = 0;
    const options = {
      create_id: (kind: "workspace" | "codebase") => `${kind}:${++identity}`,
      now: () => "2026-08-09T00:00:00.000Z",
      canonicalize_root: (root: string) => root,
      persistence,
    };

    const first = new WorkspaceRegistry(options).register(registration("/repo"));
    const restored = new WorkspaceRegistry(options);

    expect(restored.get(first.workspace_id)).toEqual(first);
    expect(restored.register(registration("/repo")).workspace_id).toBe(first.workspace_id);
  });

  it("keeps active canonical-root registration idempotent without deriving identity from the path", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/Repo/"));
    const duplicate = workspaces.register(registration("/repo", description("fingerprint:two")));

    expect(duplicate.workspace_id).toBe(first.workspace_id);
    expect(first).toMatchObject({ canonical_root: "/repo", display_root: "/Repo/", status: "registering" });
    expect(first.workspace_id).toBe("workspace:1");
  });

  it("keeps canonical provider-root registration idempotent across provider version upgrades", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/Repo/"));
    const upgraded = registration("/repo", description("fingerprint:two"));
    const duplicate = workspaces.register({
      ...upgraded,
      provider: {
        ...upgraded.provider,
        source_provider_binding_id: "binding:/repo:version-two",
        source_provider_version: "2",
      },
    });

    expect(duplicate.workspace_id).toBe(first.workspace_id);
    expect(workspaces.list()).toHaveLength(1);
  });

  it("uses the provider-normalized canonical root independently of the display root", () => {
    const workspaces = registry();
    const first = workspaces.register({
      ...registration("Git branch main"),
      canonical_root: "git-ref://repo/commit:one",
    });
    const duplicate = workspaces.register({
      ...registration("main@commit:one"),
      canonical_root: "git-ref://repo/commit:one",
    });

    expect(duplicate.workspace_id).toBe(first.workspace_id);
    expect(first).toMatchObject({
      canonical_root: "git-ref://repo/commit:one",
      display_root: "Git branch main",
    });
  });

  it("allows an explicitly separate virtual provider instance", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("git-ref://repo/main", description("commit:one", "git:repo#main")));
    const separate = registration("git-ref://repo/main", description("commit:one", "git:repo#main"));
    const second = workspaces.register({
      ...separate,
      provider: { ...separate.provider, source_provider_binding_id: "binding:virtual:two" },
      separate_virtual_instance: true,
    });

    expect(second.workspace_id).not.toBe(first.workspace_id);
    expect(workspaces.list()).toHaveLength(2);
  });

  it("rejects reuse of a provider binding occurrence identity", () => {
    const workspaces = registry();
    const first = registration("/one");
    workspaces.register(first);
    const second = registration("/two", description("fingerprint:two", "filesystem:two"));

    expect(() => workspaces.register({
      ...second,
      provider: { ...second.provider, source_provider_binding_id: first.provider.source_provider_binding_id },
    })).toThrow("engine:workspace_provider_binding_conflict");
  });

  it("allows re-registering the same root after removal, reusing its provider binding identity", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/one"));
    workspaces.remove(first.workspace_id);

    const second = workspaces.register(registration("/one"));

    expect(second.workspace_id).not.toBe(first.workspace_id);
    expect(second.status).toBe("registering");
    expect(workspaces.list()).toEqual([second]);
  });

  it("relocates only with the previous fingerprint and immutable provider identity", () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/old"));

    expect(() => workspaces.relocate({
      workspace_id: workspace.workspace_id,
      previous_source_state_fingerprint: "wrong",
      display_root: "/new",
      description: description("fingerprint:new"),
    })).toThrow("engine:workspace_relocation_proof_failed");
    expect(() => workspaces.relocate({
      workspace_id: workspace.workspace_id,
      previous_source_state_fingerprint: "fingerprint:one",
      display_root: "/new",
      description: description("fingerprint:new", "filesystem:different"),
    })).toThrow("engine:workspace_relocation_proof_failed");

    const relocated = workspaces.relocate({
      workspace_id: workspace.workspace_id,
      previous_source_state_fingerprint: "fingerprint:one",
      canonical_root: "provider://stable/new",
      display_root: "New display root",
      description: description("fingerprint:new"),
    });
    expect(relocated).toMatchObject({ workspace_id: workspace.workspace_id, canonical_root: "provider://stable/new", display_root: "New display root", source_state_fingerprint: "fingerprint:new" });
    expect(relocated.relocated_at).toBeDefined();
  });

  it("rejects relocation to an ordinary provider root active under another provider version", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/one", description("fingerprint:one")));
    const upgraded = registration("/two", description("fingerprint:two", "filesystem:two"));
    workspaces.register({
      ...upgraded,
      provider: { ...upgraded.provider, source_provider_version: "2" },
    });

    expect(() => workspaces.relocate({
      workspace_id: first.workspace_id,
      previous_source_state_fingerprint: "fingerprint:one",
      display_root: "/two",
      description: description("fingerprint:relocated"),
    })).toThrow("engine:workspace_root_conflict");
  });

  it("suspends watching and resumes through a full authoritative reconciliation", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    expect(workspaces.suspend(workspace.workspace_id)).toMatchObject({ status: "suspended", current_snapshot_id: "snapshot:one" });

    const calls: string[] = [];
    const resumed = await workspaces.resume(workspace.workspace_id, async (operation) => {
      calls.push(`${operation.operation_id}:${operation.workspace.status}`);
      return {
        operation_id: operation.operation_id,
        reconciliation_kind: "full_authoritative",
        status: "degraded",
        snapshot_id: "snapshot:two",
        source_state_fingerprint: "fingerprint:two",
      };
    });

    expect(calls).toEqual(["reconciliation:1:indexing"]);
    expect(resumed).toMatchObject({
      status: "degraded",
      current_snapshot_id: "snapshot:two",
      source_state_fingerprint: "fingerprint:two",
    });
    expect(resumed).not.toHaveProperty("reconciliation_operation_id");
  });

  it("does not expose a resumed workspace as queryable without a snapshot", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.suspend(workspace.workspace_id);

    await expect(workspaces.resume(workspace.workspace_id, async (operation) => ({
      operation_id: operation.operation_id,
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "",
      source_state_fingerprint: "fingerprint:two",
    })))
      .rejects.toThrow("engine:workspace_snapshot_required");
    expect(workspaces.get(workspace.workspace_id)?.status).toBe("indexing");
  });

  it("rejects a no-op resume callback that does not return authoritative reconciliation evidence", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);

    await expect(workspaces.resume(workspace.workspace_id, async () => "ready" as never))
      .rejects.toThrow("engine:workspace_reconciliation_invalid");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      status: "indexing",
      current_snapshot_id: "snapshot:one",
    });
  });

  it("rejects reconciliation evidence bound to a different operation token", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);

    await expect(workspaces.resume(workspace.workspace_id, async () => ({
      operation_id: "reconciliation:other",
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "snapshot:two",
      source_state_fingerprint: "fingerprint:two",
    }))).rejects.toThrow("engine:workspace_reconciliation_stale");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      status: "indexing",
      current_snapshot_id: "snapshot:one",
    });
  });

  it("does not let a stale reconciliation completion overwrite a concurrent suspension", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);
    let complete: ((result: WorkspaceReconciliationResult) => void) | undefined;

    const resuming = workspaces.resume(workspace.workspace_id, (operation) => new Promise((resolve) => {
      complete = resolve;
    }));
    expect(workspaces.suspend(workspace.workspace_id)).toMatchObject({ status: "suspended" });
    complete?.({
      operation_id: "reconciliation:1",
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "snapshot:two",
      source_state_fingerprint: "fingerprint:two",
    });

    await expect(resuming).rejects.toThrow("engine:workspace_reconciliation_stale");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      status: "suspended",
      current_snapshot_id: "snapshot:one",
    });
  });

  it("does not let a stale reconciliation completion reopen a removed workspace", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);
    let complete: ((result: WorkspaceReconciliationResult) => void) | undefined;

    const resuming = workspaces.resume(workspace.workspace_id, () => new Promise((resolve) => {
      complete = resolve;
    }));
    workspaces.remove(workspace.workspace_id);
    complete?.({
      operation_id: "reconciliation:1",
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "snapshot:two",
      source_state_fingerprint: "fingerprint:two",
    });

    await expect(resuming).rejects.toThrow("engine:workspace_reconciliation_stale");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      status: "removed",
      current_snapshot_id: "snapshot:one",
    });
    expect(workspaces.get(workspace.workspace_id)).not.toHaveProperty("reconciliation_operation_id");
  });

  it("does not leave a resume token attached after a concurrent snapshot publication", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);
    let complete: ((result: WorkspaceReconciliationResult) => void) | undefined;

    const resuming = workspaces.resume(workspace.workspace_id, () => new Promise((resolve) => {
      complete = resolve;
    }));
    workspaces.markReady(workspace.workspace_id, "snapshot:concurrent");
    complete?.({
      operation_id: "reconciliation:1",
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "snapshot:stale",
      source_state_fingerprint: "fingerprint:stale",
    });

    await expect(resuming).rejects.toThrow("engine:workspace_reconciliation_stale");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      status: "ready",
      current_snapshot_id: "snapshot:concurrent",
    });
    expect(workspaces.get(workspace.workspace_id)).not.toHaveProperty("reconciliation_operation_id");
  });

  it("invalidates an in-flight resume when relocation changes its source control state", async () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/old"));
    workspaces.markReady(workspace.workspace_id, "snapshot:one");
    workspaces.suspend(workspace.workspace_id);
    let complete: ((result: WorkspaceReconciliationResult) => void) | undefined;

    const resuming = workspaces.resume(workspace.workspace_id, () => new Promise((resolve) => {
      complete = resolve;
    }));
    workspaces.relocate({
      workspace_id: workspace.workspace_id,
      previous_source_state_fingerprint: "fingerprint:one",
      display_root: "/new",
      description: description("fingerprint:relocated"),
    });
    complete?.({
      operation_id: "reconciliation:1",
      reconciliation_kind: "full_authoritative",
      status: "ready",
      snapshot_id: "snapshot:stale",
      source_state_fingerprint: "fingerprint:stale",
    });

    await expect(resuming).rejects.toThrow("engine:workspace_reconciliation_stale");
    expect(workspaces.get(workspace.workspace_id)).toMatchObject({
      canonical_root: "/new",
      source_state_fingerprint: "fingerprint:relocated",
    });
    expect(workspaces.get(workspace.workspace_id)).not.toHaveProperty("reconciliation_operation_id");
  });

  it("closes removed registrations and creates a new identity for the same root", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/repo"));
    const removed = workspaces.remove(first.workspace_id);

    expect(removed.status).toBe("removed");
    expect(removed.removed_at).toBeDefined();
    expect(() => workspaces.suspend(first.workspace_id)).toThrow("engine:workspace_removed");

    const replacementInput = registration("/repo");
    const replacement = workspaces.register({
      ...replacementInput,
      provider: { ...replacementInput.provider, source_provider_binding_id: "binding:/repo:replacement" },
    });
    expect(replacement.workspace_id).not.toBe(first.workspace_id);
  });

  it("drops a removed tombstone only after the durable purge step", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/purge-repo"));
    workspaces.remove(first.workspace_id);
    expect(workspaces.purge(first.workspace_id)).toMatchObject({ workspace_id: first.workspace_id, status: "removed" });
    expect(workspaces.get(first.workspace_id)).toBeUndefined();
    expect(() => workspaces.purge(first.workspace_id)).toThrow("engine:workspace_not_found");
  });

  // P0 regression (publication_conflict wedge staleness-visibility gap):
  // `recordScanFailure` must survive the `markReady(..., "degraded")` re-pin
  // that immediately follows it in the daemon's scan catch block
  // (`packages/daemon/src/runtime.ts`), so a workspace stuck re-serving a
  // stale generation because every scan keeps failing is diagnosable through
  // the registry state alone -- and a later SUCCESSFUL scan's
  // `markReady(..., "ready")` must clear it again, so the failure marker
  // never outlives the failure it describes.
  it("records a scan failure that survives a degraded re-pin, and clears on the next successful markReady", () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    const ready = workspaces.markReady(workspace.workspace_id, "snapshot:one");
    expect(ready.last_scan_error).toBeUndefined();
    expect(ready.last_scan_error_at).toBeUndefined();

    const failed = workspaces.recordScanFailure(workspace.workspace_id, "storage:publication_conflict");
    expect(failed.last_scan_error).toBe("storage:publication_conflict");
    expect(failed.last_scan_error_at).toBeDefined();
    // The workspace is still queryable and unmoved -- recording a failure is
    // purely additive diagnostic state, not a status transition.
    expect(failed.status).toBe("ready");
    expect(failed.current_snapshot_id).toBe("snapshot:one");

    // The daemon's catch block re-pins to the prior snapshot as "degraded"
    // right after recording the failure -- those two fields must survive
    // that call, not get silently wiped by it.
    const degraded = workspaces.markReady(workspace.workspace_id, "snapshot:one", "degraded");
    expect(degraded.status).toBe("degraded");
    expect(degraded.last_scan_error).toBe("storage:publication_conflict");
    expect(degraded.last_scan_error_at).toBe(failed.last_scan_error_at);

    // A later successful scan clears the failure markers again.
    const recovered = workspaces.markReady(workspace.workspace_id, "snapshot:two", "ready");
    expect(recovered.status).toBe("ready");
    expect(recovered.last_scan_error).toBeUndefined();
    expect(recovered.last_scan_error_at).toBeUndefined();
  });

  it("groups workspaces without changing their independent scope", () => {
    const workspaces = registry();
    const left = workspaces.register(registration("/left", description("left", "git:common")));
    const right = workspaces.register(registration("/right", description("right", "git:common")));
    const codebase = workspaces.createCodebase("Project", "git:common");

    workspaces.assignCodebase(left.workspace_id, codebase.codebase_id);
    workspaces.assignCodebase(right.workspace_id, codebase.codebase_id);
    expect(workspaces.members(codebase.codebase_id).map((entry) => entry.workspace_id)).toEqual([left.workspace_id, right.workspace_id]);
    expect(workspaces.get(left.workspace_id)?.current_snapshot_id).toBeUndefined();

    workspaces.removeCodebase(codebase.codebase_id);
    expect(workspaces.get(left.workspace_id)?.codebase_id).toBeUndefined();
    expect(workspaces.getCodebase(codebase.codebase_id)?.removed_at).toBeDefined();
  });

  it("removes codebase references from closed workspaces before persisting group removal", () => {
    const workspaces = registry();
    const workspace = workspaces.register(registration("/repo"));
    const codebase = workspaces.createCodebase("Project");
    workspaces.assignCodebase(workspace.workspace_id, codebase.codebase_id);
    workspaces.remove(workspace.workspace_id);

    workspaces.removeCodebase(codebase.codebase_id);

    expect(workspaces.get(workspace.workspace_id)).not.toHaveProperty("codebase_id");
  });

  it("rejects illegal state transitions and duplicate active relocation targets", () => {
    const workspaces = registry();
    const first = workspaces.register(registration("/one", description("one")));
    workspaces.register(registration("/two", description("two", "filesystem:two")));

    expect(() => workspaces.markReady(first.workspace_id, "")).toThrow("engine:workspace_snapshot_required");
    expect(() => workspaces.resume(first.workspace_id, async () => ({}) as never)).toThrow("engine:workspace_state_transition");
    expect(() => workspaces.relocate({
      workspace_id: first.workspace_id,
      previous_source_state_fingerprint: "one",
      display_root: "/two",
      description: description("new"),
    })).toThrow("engine:workspace_root_conflict");
  });

  it("rejects corrupt persisted workspace control state before restoring it", () => {
    const readyWithoutSnapshot = storedWorkspace({ status: "ready" });
    const degradedWithoutSnapshot = storedWorkspace({ status: "degraded" });
    const removedWithoutTimestamp = storedWorkspace({ status: "removed" });
    const activeWithRemovalTimestamp = storedWorkspace({ removed_at: "2026-08-09T00:01:00.000Z" });
    const suspendedWithoutTimestamp = storedWorkspace({ status: "suspended" });
    const activeWithSuspensionTimestamp = storedWorkspace({ suspended_at: "2026-08-09T00:01:00.000Z" });
    const duplicateWorkspaceId = storedWorkspace({ canonical_root: "/stored/two", display_root: "/stored/two" });
    const duplicateActiveRoot = storedWorkspace({
      workspace_id: "workspace:stored-two",
      provider: {
        ...storedWorkspace().provider,
        source_provider_binding_id: "binding:stored-two",
        binding_identity: "filesystem:stored-two",
      },
    });
    const duplicateBinding = storedWorkspace({
      workspace_id: "workspace:stored-two",
      canonical_root: "/stored/two",
      display_root: "/stored/two",
    });
    const brokenCodebaseReference = storedWorkspace({ codebase_id: "codebase:missing" });

    const corruptStates: readonly WorkspaceRegistryState[] = [
      { workspaces: [readyWithoutSnapshot], codebases: [] },
      { workspaces: [degradedWithoutSnapshot], codebases: [] },
      { workspaces: [removedWithoutTimestamp], codebases: [] },
      { workspaces: [activeWithRemovalTimestamp], codebases: [] },
      { workspaces: [suspendedWithoutTimestamp], codebases: [] },
      { workspaces: [activeWithSuspensionTimestamp], codebases: [] },
      { workspaces: [storedWorkspace(), duplicateWorkspaceId], codebases: [] },
      { workspaces: [storedWorkspace(), duplicateActiveRoot], codebases: [] },
      { workspaces: [storedWorkspace(), duplicateBinding], codebases: [] },
      { workspaces: [brokenCodebaseReference], codebases: [] },
      { workspaces: [], codebases: [storedCodebase(), storedCodebase({ display_name: "Duplicate" })] },
      {
        workspaces: [storedWorkspace({ codebase_id: "codebase:stored-one" })],
        codebases: [storedCodebase({ removed_at: "2026-08-09T00:01:00.000Z" })],
      },
    ];

    for (const state of corruptStates) {
      expect(restoring(state)).toThrow("engine:workspace_state_corrupt");
    }
  });

  it("restores a removed tombstone alongside a re-added workspace sharing its path-derived binding id", () => {
    // The binding id is derived from the workspace root, so remove + re-add
    // of the same root legitimately persists both a "removed" tombstone and
    // an active workspace with one binding id (and one root). Only two
    // NON-removed workspaces sharing a binding id are corruption.
    const removedTombstone = storedWorkspace({
      status: "removed",
      removed_at: "2026-08-09T00:01:00.000Z",
    });
    const readdedSameRoot = storedWorkspace({
      workspace_id: "workspace:stored-two",
      status: "ready",
      current_snapshot_id: "snapshot:stored-two",
    });

    expect(restoring({ workspaces: [removedTombstone, readdedSameRoot], codebases: [] })).not.toThrow();
    expect(restoring({ workspaces: [readdedSameRoot, removedTombstone], codebases: [] })).not.toThrow();
  });

  it("rejects persisted ordinary provider-root duplicates split only by provider version", () => {
    const upgraded = storedWorkspace({
      workspace_id: "workspace:stored-two",
      provider: {
        ...storedWorkspace().provider,
        source_provider_binding_id: "binding:stored-two",
        source_provider_version: "2",
        binding_identity: "filesystem:stored-two",
      },
      source_state_fingerprint: "fingerprint:stored-two",
    });

    expect(restoring({ workspaces: [storedWorkspace(), upgraded], codebases: [] }))
      .toThrow("engine:workspace_state_corrupt");
  });
});
