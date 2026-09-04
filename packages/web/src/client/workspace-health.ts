export type WorkspaceLike = Record<string, unknown>;

export interface WorkspaceHealthIssue {
  readonly tone: "warning" | "danger";
  readonly title: string;
  readonly message: string;
  readonly technical_code?: string;
  readonly occurred_at?: string;
  readonly action: "reindex" | "none";
}

export interface OperationAvailability {
  readonly available: boolean;
  readonly reason_code?: string;
  readonly message?: string;
}

function record(value: unknown): WorkspaceLike {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as WorkspaceLike : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

const operationReasonMessages: Readonly<Record<string, string>> = {
  "core:source_snapshot_unavailable": "Source indexing has not produced a usable snapshot yet.",
  "core:structural_snapshot_unavailable": "Structural indexing has not produced a usable snapshot yet.",
  "core:structural_stage_in_progress": "Structural indexing has not finished, so this operation is not available yet.",
  "core:structural_required": "This operation needs the structural index before it can run.",
  "core:semantic_snapshot_unavailable": "Semantic indexing has not produced a usable snapshot yet.",
  "core:semantic_required": "This operation needs the semantic index before it can run.",
};

export function workspaceHealthIssue(workspace: WorkspaceLike | undefined): WorkspaceHealthIssue | undefined {
  if (workspace === undefined) return undefined;
  const indexStatus = record(workspace["index_status"]);
  const code = firstString(workspace["last_scan_error"], indexStatus["last_scan_error_code"]);
  const occurredAt = firstString(workspace["last_scan_error_at"], indexStatus["last_scan_error_at"]);
  const status = firstString(workspace["status"], indexStatus["workspace_status"]);
  if ((status === "indexing" || status === "registering") && code !== undefined) {
    return {
      tone: "warning",
      title: "Recovery scan in progress",
      message: "Urdira is retrying the failed scan. Available operations can continue using the last successful snapshot until the new frontiers are published.",
      technical_code: code,
      ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
      action: "none",
    };
  }
  if (code !== undefined) {
    const legacyIdentityConflict = code === "storage:immutable_workspace";
    return {
      tone: "danger",
      title: "The latest scan was rejected",
      message: legacyIdentityConflict
        ? "Stored workspace metadata does not match the current registration. Retry indexing to apply the safe compatibility repair and rebuild the affected frontiers."
        : "Urdira is serving the last successful snapshot where possible. Retry indexing; if it fails again, keep the technical code below for diagnosis.",
      technical_code: code,
      ...(occurredAt === undefined ? {} : { occurred_at: occurredAt }),
      action: "reindex",
    };
  }
  if (status === "indexing" && workspace["indexing_activity"] === "checking_for_updates") {
    return {
      tone: "warning",
      title: "Checking for updates",
      message: "Urdira is verifying that the watcher and published snapshot are still aligned. Queries continue using the current snapshot.",
      action: "none",
    };
  }
  if (status === "indexing" || status === "registering") {
    return { tone: "warning", title: "Indexing is in progress", message: "Available sections remain usable while Urdira publishes newer index frontiers.", action: "none" };
  }
  if (status === "degraded") {
    return { tone: "warning", title: "This workspace needs attention", message: "The last successful snapshot remains available, but a newer scan did not complete. Retry indexing to recover the missing frontiers.", action: "reindex" };
  }
  return undefined;
}

export function workspaceStatusLabel(workspace: WorkspaceLike | undefined): string {
  const status = firstString(workspace?.["status"], record(workspace?.["index_status"])["workspace_status"]) ?? "unknown";
  if (status === "indexing" && workspace?.["indexing_activity"] === "checking_for_updates") return "Checking for updates";
  return ({ ready: "Ready", indexing: "Indexing", registering: "Registering", degraded: "Needs attention", removed: "Removed" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
}

export function operationAvailability(workspace: WorkspaceLike | undefined, operation: string): OperationAvailability {
  if (workspace === undefined) return { available: false, message: "Select a workspace before running this operation." };
  const indexStatus = record(workspace["index_status"]);
  const availability = record(indexStatus["operation_availability"]);
  const blocked = Array.isArray(availability["blocked"]) ? availability["blocked"] : [];
  const match = blocked.map(record).find((entry) => entry["operation"] === operation);
  if (match !== undefined) {
    const reasonCode = firstString(match["reason_code"]);
    return {
      available: false,
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
      message: reasonCode === undefined ? "This operation is not available for the selected workspace." : operationReasonMessages[reasonCode] ?? `This operation is blocked by ${reasonCode}.`,
    };
  }
  const availableNow = Array.isArray(availability["available_now"]) ? availability["available_now"] : [];
  if (availableNow.length > 0 && !availableNow.includes(operation)) {
    return { available: false, message: "This operation is not available for the selected workspace." };
  }
  return { available: true };
}

export interface WorkspaceLaneView {
  readonly generation_label: string;
  readonly current: boolean;
}
export interface WorkspaceLastScanView {
  readonly kind: string;
  readonly changed_paths?: number;
  readonly wall_ms?: number;
  /** Relative-ms timeline milestones (`daemon_epoch_ms_offset`-relative, see
   * `packages/daemon/src/runtime.ts`'s `V4ScanTimeline`/`relativeTimeline`
   * doc comments) -- only the two the card cares about for now. */
  readonly queryable_at_ms?: number;
  readonly completed_at_ms?: number;
}
export interface WorkspaceV4Lanes {
  readonly structural: WorkspaceLaneView;
  readonly lexical: WorkspaceLaneView;
  readonly semantic: WorkspaceLaneView;
  readonly last_scan?: WorkspaceLastScanView;
}

function generationLabel(generation: unknown): string {
  return typeof generation === "number" || typeof generation === "string" ? String(generation) : "-";
}

/**
 * P4-d: pure projection of `core:index_status`'s v4 lane fields
 * (`storage_format`/`structural`/`lexical`/`semantic`/`last_scan`, added by
 * `v4StatusFields` in `packages/daemon/src/runtime.ts`) into the small shape
 * the workspace card/detail view renders. Returns `undefined` for a v3
 * workspace (`storage_format` is anything other than `"v4"`, including
 * absent on an older cached `index_status` payload) so a v3 card's markup
 * stays exactly what it was before this task -- callers should render the
 * v4 lane block only when this returns a value.
 */
export function workspaceV4Lanes(indexStatus: WorkspaceLike | undefined): WorkspaceV4Lanes | undefined {
  if (indexStatus === undefined || indexStatus["storage_format"] !== "v4") return undefined;
  const structural = record(indexStatus["structural"]);
  const lexical = record(indexStatus["lexical"]);
  const semantic = record(indexStatus["semantic"]);
  const lastScanRecord = record(indexStatus["last_scan"]);
  const timeline = record(lastScanRecord["timeline"]);
  const timings = record(lastScanRecord["timings"]);
  const hasLastScan = typeof lastScanRecord["kind"] === "string";
  return {
    structural: { generation_label: `q${generationLabel(structural["queryable_generation"])}/d${generationLabel(structural["durable_generation"])}`, current: structural["queryable"] === true },
    lexical: { generation_label: generationLabel(lexical["completed_generation"]), current: lexical["current"] === true },
    semantic: { generation_label: generationLabel(semantic["completed_generation"]), current: semantic["current"] === true },
    ...(hasLastScan ? {
      last_scan: {
        kind: String(lastScanRecord["kind"]),
        ...(typeof lastScanRecord["changed_paths"] === "number" ? { changed_paths: lastScanRecord["changed_paths"] } : {}),
        ...(typeof timings["total_ms"] === "number" ? { wall_ms: timings["total_ms"] } : {}),
        ...(typeof timeline["queryable_at"] === "number" ? { queryable_at_ms: timeline["queryable_at"] } : {}),
        ...(typeof timeline["completed_at"] === "number" ? { completed_at_ms: timeline["completed_at"] } : {}),
      },
    } : {}),
  };
}

export function shouldUseRetainedSnapshot(workspace: WorkspaceLike | undefined): boolean {
  if (workspace === undefined) return false;
  const indexStatus = record(workspace["index_status"]);
  const hasSnapshot = firstString(workspace["current_snapshot_id"], indexStatus["current_snapshot_id"]) !== undefined;
  const status = firstString(workspace["status"], indexStatus["workspace_status"]);
  return hasSnapshot && (status !== "ready" || workspaceHealthIssue(workspace)?.technical_code !== undefined);
}
