export type DaemonErrorCode =
  | "core:daemon_already_running"
  | "core:daemon_restart_required"
  | "core:daemon_not_running"
  | "core:daemon_recovery_failed"
  | "core:ipc_frame_invalid"
  | "core:ipc_frame_too_large"
  | "core:ipc_request_invalid"
  | "core:ipc_timeout"
  | "core:execution_failed"
  | "core:operation_cancelled"
  | "core:unknown_call"
  | "core:quota_exceeded"
  | "core:admission_exhausted"
  | "core:workspace_busy"
  | "core:confirmation_required"
  | "core:dry_run_required"
  | "core:workspace_not_registered"
  | "core:workspace_not_found"
  | "core:workspace_lifecycle"
  | "core:storage_unavailable"
  | "core:index_unavailable"
  | "core:coverage_incomplete"
  | "core:required_capability_unsupported"
  | "core:plugin_unavailable"
  | "core:freshness_wait_timeout";

export class DaemonError extends Error {
  constructor(readonly code: DaemonErrorCode, message: string, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(`${code}: ${message}`);
    this.name = "DaemonError";
  }
}
