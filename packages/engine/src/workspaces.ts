import { randomUUID } from "node:crypto";
import type { SourceProviderDescribeResult, WorkspaceSourceProviderBinding } from "@urdira/contracts";
import { canonicalizePath } from "@urdira/security";
import { EngineError } from "./errors.js";

export type WorkspaceStatus = "registering" | "indexing" | "ready" | "degraded" | "suspended" | "removing" | "removed";

export type SourceProviderDescription = SourceProviderDescribeResult;
export type SourceProviderBindingInput = WorkspaceSourceProviderBinding;

export interface WorkspaceRegistration {
  readonly canonical_root?: string;
  readonly display_root: string;
  readonly provider: SourceProviderBindingInput;
  readonly description: SourceProviderDescription;
  readonly separate_virtual_instance?: boolean;
  readonly selected_technology_ids?: ReadonlyArray<string>;
  readonly selected_plugin_ids?: ReadonlyArray<string>;
}

export interface RegisteredWorkspace {
  readonly workspace_id: string;
  readonly codebase_id?: string;
  readonly canonical_root: string;
  readonly display_root: string;
  readonly provider: SourceProviderBindingInput;
  readonly source_state_fingerprint: string;
  readonly separate_virtual_instance?: boolean;
  readonly selected_technology_ids?: ReadonlyArray<string>;
  readonly selected_plugin_ids?: ReadonlyArray<string>;
  readonly reconciliation_operation_id?: string;
  readonly current_snapshot_id?: string;
  readonly status: WorkspaceStatus;
  readonly registered_at: string;
  readonly relocated_at?: string;
  readonly suspended_at?: string;
  readonly removed_at?: string;
  // Set by `WorkspaceRegistry#recordScanFailure` whenever a scan (of any
  // kind -- workspace fork, full scan, incremental scan) throws, and cleared
  // by `#markReady(..., "ready")` on the next successful scan. A "degraded"
  // workspace re-pinned to its prior snapshot after a failed scan (see
  // `packages/daemon/src/runtime.ts`'s `scheduleWorkspaceScan` catch block)
  // keeps these fields, so `core:index_status` can tell "ready, and the last
  // scan attempt actually succeeded" apart from "ready/degraded, but stale:
  // the latest scan attempt failed and this is serving an older generation"
  // -- see docs on the `publication_conflict` wedge this closes the
  // observability gap for.
  readonly last_scan_error?: string;
  readonly last_scan_error_at?: string;
}

export interface RegisteredCodebase {
  readonly codebase_id: string;
  readonly display_name: string;
  readonly vcs_identity?: string;
  readonly created_at: string;
  readonly removed_at?: string;
}

export interface WorkspaceRegistryOptions {
  readonly create_id?: (kind: "workspace" | "codebase") => string;
  readonly create_reconciliation_id?: () => string;
  readonly now?: () => string;
  readonly canonicalize_root?: (root: string) => string;
  readonly persistence?: WorkspaceRegistryPersistence;
}

export interface WorkspaceRegistryState {
  readonly workspaces: readonly RegisteredWorkspace[];
  readonly codebases: readonly RegisteredCodebase[];
}

export interface WorkspaceRegistryPersistence {
  load(): WorkspaceRegistryState | undefined;
  save(state: WorkspaceRegistryState): void;
}

export interface WorkspaceRelocation {
  readonly workspace_id: string;
  readonly previous_source_state_fingerprint: string;
  readonly canonical_root?: string;
  readonly display_root: string;
  readonly description: SourceProviderDescription;
}

export interface WorkspaceReconciliationOperation {
  readonly operation_id: string;
  readonly reconciliation_kind: "full_authoritative";
  readonly workspace: RegisteredWorkspace;
}

export interface WorkspaceReconciliationResult {
  readonly operation_id: string;
  readonly reconciliation_kind: "full_authoritative";
  readonly status: "ready" | "degraded";
  readonly snapshot_id: string;
  readonly source_state_fingerprint: string;
}

export type WorkspaceRootResolution =
  | { readonly workspace_id: string }
  | { readonly error: { readonly code: "core:workspace_not_registered"; readonly details: { readonly registration_command: "urdira workspace add <workspace-root>" } } };
export type WorkspaceIndexStatusResolution =
  | { readonly workspace_id: string; readonly current_snapshot_id?: string; readonly workspace_status: WorkspaceStatus }
  | { readonly error: { readonly code: "core:workspace_not_registered" | "core:workspace_not_found" | "core:index_unavailable"; readonly details: Readonly<Record<string, string>> } };

function validateReconciliationResult(result: unknown, operationId: string): asserts result is WorkspaceReconciliationResult {
  if (result === null || typeof result !== "object"
    || !("operation_id" in result) || typeof result.operation_id !== "string"
    || !("reconciliation_kind" in result) || result.reconciliation_kind !== "full_authoritative"
    || !("status" in result) || (result.status !== "ready" && result.status !== "degraded")
    || !("snapshot_id" in result) || typeof result.snapshot_id !== "string"
    || !("source_state_fingerprint" in result) || typeof result.source_state_fingerprint !== "string"
    || result.source_state_fingerprint.length === 0) {
    throw new EngineError("engine:workspace_reconciliation_invalid", "Resume requires a complete authoritative full-reconciliation result.");
  }
  if (result.operation_id !== operationId) {
    throw new EngineError("engine:workspace_reconciliation_stale", "The reconciliation result does not match the active resume operation.");
  }
}

const WORKSPACE_STATUSES: ReadonlySet<string> = new Set<WorkspaceStatus>([
  "registering", "indexing", "ready", "degraded", "suspended", "removing", "removed",
]);

function corruptState(reason: string): never {
  throw new EngineError("engine:workspace_state_corrupt", reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item)) || new Set(value).size !== value.length) {
    corruptState(`Persisted ${field} must be a unique array of non-empty identifiers.`);
  }
}

function providerRootKey(provider: SourceProviderBindingInput, canonicalRoot: string): string {
  return `${provider.source_provider}\0${canonicalRoot}`;
}

function validatePersistedState(value: unknown): asserts value is WorkspaceRegistryState {
  if (!isRecord(value) || !Array.isArray(value["workspaces"]) || !Array.isArray(value["codebases"])) {
    corruptState("Persisted registry state must contain workspace and codebase arrays.");
  }
  const state = value as unknown as WorkspaceRegistryState;

  const codebaseIds = new Set<string>();
  const activeCodebaseIds = new Set<string>();
  for (const candidate of state.codebases) {
    if (!isRecord(candidate)) corruptState("Persisted codebase identity or lifecycle state is invalid.");
    const codebase = candidate as unknown as RegisteredCodebase;
    if (!nonEmptyString(codebase.codebase_id) || codebaseIds.has(codebase.codebase_id)
      || !nonEmptyString(codebase.display_name) || !nonEmptyString(codebase.created_at)
      || (codebase.removed_at !== undefined && !nonEmptyString(codebase.removed_at))) {
      corruptState("Persisted codebase identity or lifecycle state is invalid.");
    }
    codebaseIds.add(codebase.codebase_id);
    if (codebase.removed_at === undefined) activeCodebaseIds.add(codebase.codebase_id);
  }

  const workspaceIds = new Set<string>();
  const bindingIds = new Set<string>();
  const ordinaryRoots = new Set<string>();
  for (const candidate of state.workspaces) {
    if (!isRecord(candidate)) corruptState("Persisted workspace identity or required control fields are invalid.");
    const workspace = candidate as unknown as RegisteredWorkspace;
    if (!nonEmptyString(workspace.workspace_id) || workspaceIds.has(workspace.workspace_id)
      || !nonEmptyString(workspace.canonical_root) || !nonEmptyString(workspace.display_root)
      || !nonEmptyString(workspace.source_state_fingerprint) || !nonEmptyString(workspace.registered_at)
      || !nonEmptyString(workspace.status) || !WORKSPACE_STATUSES.has(workspace.status)
      || !isRecord(workspace.provider)) {
      corruptState("Persisted workspace identity or required control fields are invalid.");
    }
    optionalStringArray(workspace.selected_technology_ids, "selected technology identifiers");
    optionalStringArray(workspace.selected_plugin_ids, "selected plugin identifiers");
    workspaceIds.add(workspace.workspace_id);

    const provider = workspace.provider as unknown as SourceProviderBindingInput;
    // Binding-id uniqueness is only claimed by non-removed workspaces, like
    // the active provider-root check below: the binding id is derived from
    // the workspace root, so removing a workspace and re-adding the same
    // root legitimately persists a "removed" tombstone and an active entry
    // that share one binding id. Treating that as corruption made the very
    // next daemon restart after a remove + re-add fail permanently.
    if (!nonEmptyString(provider.source_provider_binding_id)
      || (workspace.status !== "removed" && bindingIds.has(provider.source_provider_binding_id))
      || !nonEmptyString(provider.source_provider) || !nonEmptyString(provider.source_provider_version)
      || provider.provider_role !== "primary" || !nonEmptyString(provider.binding_identity)
      || !nonEmptyString(provider.configuration_digest)) {
      corruptState("Persisted source-provider binding identity is invalid or duplicated.");
    }
    if (workspace.status !== "removed") bindingIds.add(provider.source_provider_binding_id);

    const queryable = workspace.status === "ready" || workspace.status === "degraded";
    if (queryable && !nonEmptyString(workspace.current_snapshot_id)) {
      corruptState("A persisted queryable workspace requires a current snapshot.");
    }
    if ((workspace.status === "removed") !== nonEmptyString(workspace.removed_at)) {
      corruptState("Persisted removed state and removal timestamp do not agree.");
    }
    if ((workspace.status === "suspended") !== nonEmptyString(workspace.suspended_at)) {
      corruptState("Persisted suspended state and suspension timestamp do not agree.");
    }
    if (workspace.reconciliation_operation_id !== undefined
      && (workspace.status !== "indexing" || !nonEmptyString(workspace.reconciliation_operation_id))) {
      corruptState("Persisted reconciliation operation is not attached to indexing state.");
    }
    if (workspace.codebase_id !== undefined && !activeCodebaseIds.has(workspace.codebase_id)) {
      corruptState("Persisted workspace references a missing or removed codebase.");
    }

    if (workspace.status !== "removed" && workspace.separate_virtual_instance !== true) {
      const rootKey = providerRootKey(provider, workspace.canonical_root);
      if (ordinaryRoots.has(rootKey)) corruptState("Persisted active provider roots are duplicated.");
      ordinaryRoots.add(rootKey);
    }
  }
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, RegisteredWorkspace>();
  private readonly codebases = new Map<string, RegisteredCodebase>();
  private readonly createId: (kind: "workspace" | "codebase") => string;
  private readonly createReconciliationId: () => string;
  private readonly clock: () => string;
  private readonly canonicalizeRoot: (root: string) => string;
  private readonly persistence: WorkspaceRegistryPersistence | undefined;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.createId = options.create_id ?? ((kind) => `${kind}:${randomUUID()}`);
    this.createReconciliationId = options.create_reconciliation_id ?? (() => `reconciliation:${randomUUID()}`);
    this.clock = options.now ?? (() => new Date().toISOString());
    this.canonicalizeRoot = options.canonicalize_root ?? canonicalizePath;
    this.persistence = options.persistence;
    const persisted = this.persistence?.load();
    if (persisted !== undefined) validatePersistedState(persisted);
    for (const workspace of persisted?.workspaces ?? []) this.workspaces.set(workspace.workspace_id, workspace);
    for (const codebase of persisted?.codebases ?? []) this.codebases.set(codebase.codebase_id, codebase);
  }

  register(input: WorkspaceRegistration): RegisteredWorkspace {
    if (input.provider.binding_identity !== input.description.immutable_binding_identity
      || input.provider.source_provider !== input.description.provider_kind) {
      throw new EngineError("engine:workspace_provider_mismatch", "The describe result does not match the registered provider binding.");
    }
    const canonicalRoot = input.canonical_root ?? this.canonicalizeRoot(input.display_root);
    const rootKey = providerRootKey(input.provider, canonicalRoot);
    if (!input.separate_virtual_instance) {
      const existing = this.list().find((workspace) => providerRootKey(workspace.provider, workspace.canonical_root) === rootKey);
      if (existing) return existing;
    }
    if (this.list().some((workspace) => workspace.provider.source_provider_binding_id === input.provider.source_provider_binding_id)) {
      throw new EngineError("engine:workspace_provider_binding_conflict", "A source-provider binding occurrence identity cannot be reused.");
    }
    const workspace: RegisteredWorkspace = {
      workspace_id: this.createId("workspace"),
      canonical_root: canonicalRoot,
      display_root: input.display_root,
      provider: input.provider,
      source_state_fingerprint: input.description.source_state_fingerprint,
      ...(input.separate_virtual_instance === true ? { separate_virtual_instance: true } : {}),
      ...(input.selected_technology_ids === undefined ? {} : { selected_technology_ids: [...new Set(input.selected_technology_ids)].sort() }),
      ...(input.selected_plugin_ids === undefined ? {} : { selected_plugin_ids: [...new Set(input.selected_plugin_ids)].sort() }),
      status: "registering",
      registered_at: this.clock(),
    };
    this.workspaces.set(workspace.workspace_id, workspace);
    this.persist();
    return workspace;
  }

  get(workspaceId: string): RegisteredWorkspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  updateSelection(workspaceId: string, selectedTechnologyIds: ReadonlyArray<string>, selectedPluginIds: ReadonlyArray<string>): RegisteredWorkspace {
    const workspace = this.requireMutable(workspaceId);
    const next = this.replace(workspaceId, {
      ...workspace,
      selected_technology_ids: [...new Set(selectedTechnologyIds)].sort(),
      selected_plugin_ids: [...new Set(selectedPluginIds)].sort(),
    });
    return next;
  }

  list(): readonly RegisteredWorkspace[] {
    return [...this.workspaces.values()].filter((workspace) => workspace.status !== "removed").sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  }

  /** Resolve an explicit root using the same canonicalization used at registration time. */
  findByCanonicalRoot(root: string, sourceProvider?: string): RegisteredWorkspace | undefined {
    const canonicalRoot = this.canonicalizeRoot(root);
    return this.list().find((workspace) => workspace.canonical_root === canonicalRoot
      && (sourceProvider === undefined || workspace.provider.source_provider === sourceProvider));
  }

  relocate(input: WorkspaceRelocation): RegisteredWorkspace {
    const workspace = this.requireMutable(input.workspace_id);
    if (workspace.source_state_fingerprint !== input.previous_source_state_fingerprint
      || workspace.provider.binding_identity !== input.description.immutable_binding_identity) {
      throw new EngineError("engine:workspace_relocation_proof_failed", "Relocation must prove the prior fingerprint and immutable provider identity.");
    }
    const canonicalRoot = input.canonical_root ?? this.canonicalizeRoot(input.display_root);
    const targetRootKey = providerRootKey(workspace.provider, canonicalRoot);
    const conflict = this.list().find((candidate) => candidate.workspace_id !== workspace.workspace_id
      && providerRootKey(candidate.provider, candidate.canonical_root) === targetRootKey);
    if (conflict) throw new EngineError("engine:workspace_root_conflict", "The relocation target is already registered to an active workspace.");
    const { reconciliation_operation_id: _, ...relocatable } = workspace;
    return this.replace(workspace.workspace_id, {
      ...relocatable,
      canonical_root: canonicalRoot,
      display_root: input.display_root,
      source_state_fingerprint: input.description.source_state_fingerprint,
      relocated_at: this.clock(),
    });
  }

  markReady(workspaceId: string, snapshotId: string, status: "ready" | "degraded" = "ready"): RegisteredWorkspace {
    if (snapshotId.length === 0) throw new EngineError("engine:workspace_snapshot_required", "A queryable state requires a current snapshot.");
    const workspace = this.requireMutable(workspaceId);
    if (workspace.status === "suspended") throw new EngineError("engine:workspace_state_transition", "A suspended workspace must resume through reconciliation.");
    const { reconciliation_operation_id: _, ...publishable } = workspace;
    // A "ready" transition means the scan that just ran succeeded, so any
    // previously recorded scan failure is stale and must not keep marking
    // this workspace as failed forever. A "degraded" transition means the
    // opposite -- this call is itself part of a failed scan's recovery path
    // (`packages/daemon/src/runtime.ts`'s catch block calls
    // `recordScanFailure` before this) -- so those fields must survive.
    const { last_scan_error: _error, last_scan_error_at: _errorAt, ...cleared } = publishable;
    return this.replace(workspaceId, { ...(status === "ready" ? cleared : publishable), current_snapshot_id: snapshotId, status });
  }

  /**
   * Pins an atomically published intermediate structural stage while retaining
   * the indexing/reconciliation state. Stage 3 must still call markReady.
   */
  markStructuralStagePublished(workspaceId: string, snapshotId: string): RegisteredWorkspace {
    if (snapshotId.length === 0) throw new EngineError("engine:workspace_snapshot_required", "A queryable structural stage requires a current snapshot.");
    const workspace = this.requireMutable(workspaceId);
    if (workspace.status !== "indexing") throw new EngineError("engine:workspace_state_transition", "An intermediate structural stage can only be exposed during indexing.");
    return this.replace(workspaceId, { ...workspace, current_snapshot_id: snapshotId });
  }

  /**
   * Records that the latest scan attempt for `workspaceId` failed, without
   * changing its queryable status or current snapshot -- a workspace can be
   * `"ready"`/`"degraded"` and serving a perfectly good (if now stale)
   * generation while this is set. Callers pair this with a `markReady(...,
   * "degraded")` (or leave the workspace `"indexing"` on a first-ever-scan
   * failure) immediately after; `markReady(..., "ready")` on the next
   * successful scan clears these fields again. Exists so
   * `core:index_status` can report `freshness_status: "stale"` instead of
   * silently claiming `"current"` for a workspace whose latest scan attempt
   * actually failed (see `resolveIndexStatusRequest` /
   * `packages/daemon/src/runtime.ts`).
   */
  recordScanFailure(workspaceId: string, errorCode: string): RegisteredWorkspace {
    const workspace = this.requireMutable(workspaceId);
    return this.replace(workspaceId, { ...workspace, last_scan_error: errorCode, last_scan_error_at: this.clock() });
  }

  /** Mark a registered workspace as requiring a serialized full reconciliation. */
  beginReconciliation(workspaceId: string): WorkspaceReconciliationOperation {
    const workspace = this.requireMutable(workspaceId);
    if (workspace.status === "indexing" && workspace.reconciliation_operation_id !== undefined) {
      return { operation_id: workspace.reconciliation_operation_id, reconciliation_kind: "full_authoritative", workspace };
    }
    const operationId = this.createReconciliationId();
    const indexing = this.replace(workspaceId, { ...workspace, status: "indexing", reconciliation_operation_id: operationId });
    return { operation_id: operationId, reconciliation_kind: "full_authoritative", workspace: indexing };
  }

  suspend(workspaceId: string): RegisteredWorkspace {
    const workspace = this.requireMutable(workspaceId);
    if (workspace.status === "suspended") return workspace;
    if (workspace.status !== "registering" && workspace.status !== "indexing" && workspace.status !== "ready" && workspace.status !== "degraded") {
      throw new EngineError("engine:workspace_state_transition", `Workspace cannot be suspended from ${workspace.status}.`);
    }
    const { reconciliation_operation_id: _, ...suspendable } = workspace;
    return this.replace(workspaceId, { ...suspendable, status: "suspended", suspended_at: this.clock() });
  }

  resume(workspaceId: string, reconcile: (operation: WorkspaceReconciliationOperation) => Promise<WorkspaceReconciliationResult>): Promise<RegisteredWorkspace> {
    const workspace = this.requireMutable(workspaceId);
    if (workspace.status !== "suspended") throw new EngineError("engine:workspace_state_transition", "Only a suspended workspace can resume.");
    const { suspended_at: _, ...resumable } = workspace;
    const operationId = this.createReconciliationId();
    const indexing = this.replace(workspaceId, { ...resumable, status: "indexing", reconciliation_operation_id: operationId });
    return reconcile({ operation_id: operationId, reconciliation_kind: "full_authoritative", workspace: indexing }).then((result) => {
      validateReconciliationResult(result, operationId);
      const reconciled = this.workspaces.get(workspaceId);
      if (!reconciled || reconciled.status !== "indexing" || reconciled.reconciliation_operation_id !== operationId) {
        throw new EngineError("engine:workspace_reconciliation_stale", "The resume operation is no longer current.");
      }
      if (result.snapshot_id.length === 0) {
        throw new EngineError("engine:workspace_snapshot_required", "A queryable state requires a current snapshot.");
      }
      const { reconciliation_operation_id: _, ...completed } = reconciled;
      return this.replace(workspaceId, {
        ...completed,
        source_state_fingerprint: result.source_state_fingerprint,
        current_snapshot_id: result.snapshot_id,
        status: result.status,
      });
    });
  }

  remove(workspaceId: string): RegisteredWorkspace {
    const workspace = this.requireMutable(workspaceId);
    const { reconciliation_operation_id: _, ...removable } = workspace;
    const removing = this.replace(workspaceId, { ...removable, status: "removing" });
    return this.replace(workspaceId, { ...removing, status: "removed", removed_at: this.clock() });
  }

  /**
   * Drops a removed workspace tombstone after durable storage has completed
   * its guarded purge.  Callers must perform the storage purge first so a
   * failed filesystem/catalog operation leaves a recoverable registry record.
   */
  purge(workspaceId: string): RegisteredWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new EngineError("engine:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    if (workspace.status !== "removed") throw new EngineError("engine:workspace_state_transition", `Workspace ${workspaceId} must be removed before it can be purged.`);
    this.workspaces.delete(workspaceId);
    this.persist();
    return workspace;
  }

  createCodebase(displayName: string, vcsIdentity?: string): RegisteredCodebase {
    if (displayName.trim().length === 0) throw new EngineError("engine:codebase_name_required", "Codebase display name cannot be empty.");
    const codebase: RegisteredCodebase = {
      codebase_id: this.createId("codebase"),
      display_name: displayName,
      ...(vcsIdentity === undefined ? {} : { vcs_identity: vcsIdentity }),
      created_at: this.clock(),
    };
    this.codebases.set(codebase.codebase_id, codebase);
    this.persist();
    return codebase;
  }

  getCodebase(codebaseId: string): RegisteredCodebase | undefined {
    return this.codebases.get(codebaseId);
  }

  assignCodebase(workspaceId: string, codebaseId?: string): RegisteredWorkspace {
    const workspace = this.requireMutable(workspaceId);
    if (codebaseId !== undefined) {
      const codebase = this.codebases.get(codebaseId);
      if (!codebase || codebase.removed_at !== undefined) throw new EngineError("engine:codebase_not_found", `Codebase ${codebaseId} is not active.`);
      return this.replace(workspaceId, { ...workspace, codebase_id: codebaseId });
    }
    const { codebase_id: _, ...ungrouped } = workspace;
    return this.replace(workspaceId, ungrouped);
  }

  members(codebaseId: string): readonly RegisteredWorkspace[] {
    const codebase = this.codebases.get(codebaseId);
    if (!codebase || codebase.removed_at !== undefined) throw new EngineError("engine:codebase_not_found", `Codebase ${codebaseId} is not active.`);
    return this.list().filter((workspace) => workspace.codebase_id === codebaseId);
  }

  removeCodebase(codebaseId: string): RegisteredCodebase {
    const codebase = this.codebases.get(codebaseId);
    if (!codebase || codebase.removed_at !== undefined) throw new EngineError("engine:codebase_not_found", `Codebase ${codebaseId} is not active.`);
    for (const workspace of this.workspaces.values()) {
      if (workspace.codebase_id !== codebaseId) continue;
      const { codebase_id: _, ...ungrouped } = workspace;
      this.replace(workspace.workspace_id, ungrouped);
    }
    const removed = { ...codebase, removed_at: this.clock() };
    this.codebases.set(codebaseId, removed);
    this.persist();
    return removed;
  }

  private requireMutable(workspaceId: string): RegisteredWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new EngineError("engine:workspace_not_found", `Workspace ${workspaceId} is not registered.`);
    if (workspace.status === "removed" || workspace.status === "removing") throw new EngineError("engine:workspace_removed", `Workspace ${workspaceId} is closed.`);
    return workspace;
  }

  private replace(workspaceId: string, workspace: RegisteredWorkspace): RegisteredWorkspace {
    this.workspaces.set(workspaceId, workspace);
    this.persist();
    return workspace;
  }

  private persist(): void {
    this.persistence?.save({
      workspaces: [...this.workspaces.values()],
      codebases: [...this.codebases.values()],
    });
  }
}

/** Resolve the v2 status root without ever returning the absolute path in protocol data. */
export function resolveWorkspaceRoot(registry: WorkspaceRegistry, workspaceRoot: string): WorkspaceRootResolution {
  const workspace = registry.findByCanonicalRoot(workspaceRoot);
  return workspace === undefined
    ? { error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>" } } }
    : { workspace_id: workspace.workspace_id };
}

export function resolveIndexStatusRequest(registry: WorkspaceRegistry, request: { readonly api_version: number; readonly workspace_ids: ReadonlyArray<string>; readonly workspace_root?: string }): WorkspaceIndexStatusResolution {
  let workspace: RegisteredWorkspace | undefined;
  if (request.api_version === 2 || request.api_version === 3) {
    if (request.workspace_ids.length !== 0 || request.workspace_root === undefined || request.workspace_root.length === 0) return { error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>" } } };
    workspace = registry.findByCanonicalRoot(request.workspace_root);
    if (workspace === undefined) return { error: { code: "core:workspace_not_registered", details: { registration_command: "urdira workspace add <workspace-root>" } } };
  } else {
    workspace = request.workspace_ids.length === 1 ? registry.get(request.workspace_ids[0]!) : undefined;
    if (workspace === undefined) return { error: { code: "core:workspace_not_found", details: { workspace_id: request.workspace_ids[0] ?? "" } } };
  }
  // v1/v2 preserve their historical structural-snapshot requirement. v3 is
  // the layered status surface and must remain queryable while source-only
  // indexing is available but structural publication is still in progress.
  if (request.api_version !== 3 && workspace.status !== "ready" && workspace.status !== "degraded") return { error: { code: "core:index_unavailable", details: { workspace_id: workspace.workspace_id, index_state: workspace.status } } };
  return { workspace_id: workspace.workspace_id, ...(workspace.current_snapshot_id === undefined ? {} : { current_snapshot_id: workspace.current_snapshot_id }), workspace_status: workspace.status };
}
