import { StorageError } from "./errors.js";

export type FaultBoundary =
  | "candidate_publication.before_begin"
  | "candidate_publication.after_validate_base"
  | "candidate_publication.after_install_source"
  | "candidate_publication.after_install_canonical"
  | "candidate_publication.after_install_projections"
  | "candidate_publication.after_install_manifest"
  | "candidate_publication.before_swap_current"
  | "candidate_publication.before_commit"
  | "candidate_publication.after_commit_ack"
  | "publication.before_snapshot_insert"
  | "publication.after_snapshot_insert"
  | "publication.before_current_update"
  | "publication.after_current_update"
  | "publication.after_commit"
  | "migration.before_backup"
  | "migration.after_shadow_copy"
  | "migration.before_swap"
  | "migration.before_publish"
  | "migration.after_swap"
  | "manifest.before_append"
  | "manifest.after_append"
  | "retention.before_release"
  | "retention.before_expiry_commit"
  | "backup.before_snapshot"
  | "backup.after_snapshot"
  | "backup.before_publish"
  | "backup.after_publish"
  | "collection.before_mark"
  | "collection.after_mark"
  | "collection.before_sweep"
  | "collection.after_sweep"
  | "source_index.before_commit"
  | "migration.candidate_fk_rebuild";

export interface FaultInjector {
  readonly hit: (boundary: FaultBoundary) => Promise<void> | void;
  readonly isPending?: (boundary: FaultBoundary) => boolean;
}

export const noFaults: FaultInjector = { hit: () => undefined };

export function createFaultInjector(boundaries: Iterable<FaultBoundary>): FaultInjector {
  const pending = new Set(boundaries);
  return {
    isPending(boundary) { return pending.has(boundary); },
    hit(boundary) {
      if (!pending.delete(boundary)) return;
      throw new StorageError("storage:fault_injected", `Fault injected at ${boundary}.`, { boundary });
    },
  };
}
