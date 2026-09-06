import { isAbsolute } from "node:path";

/**
 * v4 cold/incremental scan protocol mirror (task P2-2b). Wire source of
 * truth: `crates/urdira-worker-protocol/src/lib.rs`'s `ScanScope`/
 * `ScanPriority`/`ScanTimings`/`ScanRoots`/`IndexingCommand::WorkspaceScan`/
 * `IndexingEvent::{Queryable,ScanCompleted}`. The literal wire-framing
 * mirror (the shape actually sent to/decoded from the worker's stdio
 * transport, tagged with `kind`) lives in
 * `packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts`;
 * these are the same field shapes re-exported at the engine layer for
 * `rust-workspace-scan.ts` and its callers, matching how `IndexGenerationRequest`
 * above mirrors that file's v3 request shape.
 */
export type ChangedPathKind = "created" | "modified" | "deleted";
export interface ChangedPath {
  readonly path: string;
  readonly kind: ChangedPathKind;
}
export type ScanScope = { readonly kind: "full" } | { readonly kind: "changed"; readonly paths: readonly ChangedPath[] } | { readonly kind: "reconcile" };
export type ScanPriority = "interactive" | "background";
/** Frente E (plan `generic-waddling-hartmanis.md` §2.1): which of `reconcile`'s
 * two republish pipelines actually ran (or neither, for `noop`) -- mirrors
 * Rust's `ReconcileMode`. */
export type ReconcileMode = "noop" | "delta" | "cold";
/** Mirrors Rust's `ReconcileSummary` -- reported on `ScanCompleted`/`Queryable`
 * only for a `scope: {kind: "reconcile"}` request. `added`/`changed`/`deleted`/
 * `frontier_size` are the AUTHORITATIVE delta the reconcile measured (never the
 * watcher's own hint); `threshold` is the effective `T` this call used.
 * `fell_back_to_cold` is `true` only for the R2 fallback (the `delta` pipeline
 * was attempted and failed, and this `cold` result is the SAME request's
 * recovery, not a size-driven decision). */
export interface ReconcileSummary {
  readonly mode: ReconcileMode;
  readonly added: number;
  readonly changed: number;
  readonly deleted: number;
  readonly frontier_size: number;
  readonly threshold: number;
  readonly fell_back_to_cold: boolean;
}
export interface ScanTimings {
  readonly catalog_ms?: number;
  readonly parse_ms?: number;
  readonly resolve_ms?: number;
  readonly materialize_ms?: number;
  readonly write_ms?: number;
  readonly fsync_ms?: number;
  readonly snapshot_ms?: number;
  readonly lexical_ms?: number;
  readonly total_ms: number;
}
export interface ScanRoots {
  readonly records: string;
  readonly dependency: string;
  readonly graph: string;
  readonly metric: string;
}
export interface WorkspaceScanRequest {
  readonly workspace_id: string;
  readonly workspace_root: string;
  readonly database_path: string;
  readonly structural_root: string;
  readonly cas_root: string;
  readonly sidecar_root: string;
  readonly scope: ScanScope;
  readonly registry_snapshot_id: string;
  readonly configuration_revision_id: string;
  readonly resolution_lock_id: string;
  readonly deadline_ms?: number;
  readonly priority: ScanPriority;
}
export interface WorkspaceScanQueryable {
  readonly generation: number;
  readonly manifest_path: string;
  readonly timings: ScanTimings;
  /** Frente E: present only for a `scope: {kind: "reconcile"}` request whose
   * transport also decorated this milestone -- absent for `full`/`changed`. */
  readonly reconcile?: ReconcileSummary;
}
export interface WorkspaceScanResult {
  readonly generation: number;
  readonly snapshot_id: string;
  readonly roots: ScanRoots;
  readonly timings: ScanTimings;
  /** Frente E: present only for a `scope: {kind: "reconcile"}` request --
   * absent for `full`/`changed`. */
  readonly reconcile?: ReconcileSummary;
}
/**
 * P1-D-c (decision 28): the background residual TypeScript-checker pass's
 * own completion payload (`IndexingEvent::UpgradeCompleted`'s fields, minus
 * `request_id`/`operation_id`/`kind` -- those are wire/correlation details
 * `rust-workspace-scan.ts`'s subscriber callback carries separately, same
 * split `WorkspaceScanQueryable`/`WorkspaceScanResult` already use above).
 * `generation` is the NEW upgrade generation when `upgraded_sites > 0`, or
 * the pass's own unchanged base generation when it found nothing to
 * upgrade -- see the Rust event's own doc comment for why no new
 * generation is minted in that case.
 */
export interface WorkspaceScanUpgradeCompleted {
  readonly generation: number;
  readonly upgraded_sites: number;
  readonly external_sites: number;
  readonly unresolved_sites: number;
  readonly timings: ScanTimings;
  /** F4 4.2 (revision fix, 2026-09-05): `true` if `URDIRA_V4_RESIDUAL_BUDGET_MS`'s
   * deadline cut this run off before it opened every window in its own plan
   * -- a follow-up `upgrade_completed` for the SAME triggering scan may
   * still arrive later. `undefined` (not `false`) for a Rust build that
   * predates this field, so a consumer can tell "did not report" apart
   * from "ran to completion". */
  readonly truncated?: boolean;
  /** How many windows this run actually opened, out of `windows_total`. */
  readonly windows_done?: number;
  readonly windows_total?: number;
  /** C.3: wall-clock milliseconds of the checker pass itself
   * (`ResidualPass::run_instrumented` alone, not materialize/write/fsync/
   * snapshot) -- distinct from `timings.total_ms`, which includes all of
   * those. `undefined` for a Rust build that predates this field. */
  readonly checker_ms?: number;
}

/**
 * Validates the operation boundary before a `workspace_scan` request reaches
 * the subprocess, mirroring `validateIndexGenerationRequest`'s scope
 * (transport invariants only; scan/catalog authority validation stays in
 * Rust).
 */
export function validateWorkspaceScanRequest(request: WorkspaceScanRequest): void {
  const identifiers: readonly [string, string][] = [
    ["workspace_id", request.workspace_id],
    ["workspace_root", request.workspace_root],
    ["database_path", request.database_path],
    ["structural_root", request.structural_root],
    ["cas_root", request.cas_root],
    ["sidecar_root", request.sidecar_root],
    ["registry_snapshot_id", request.registry_snapshot_id],
    ["configuration_revision_id", request.configuration_revision_id],
    ["resolution_lock_id", request.resolution_lock_id],
  ];
  for (const [label, value] of identifiers) {
    if (value.length === 0 || value.length > 4096 || /[\u0000\r\n\t]/u.test(value)) {
      throw new Error(`Invalid Rust workspace-scan ${label}.`);
    }
  }
  for (const [label, value] of [
    ["structural_root", request.structural_root],
    ["cas_root", request.cas_root],
    ["sidecar_root", request.sidecar_root],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`Invalid Rust workspace-scan ${label}: must be absolute.`);
  }
  if (request.deadline_ms !== undefined && (!Number.isSafeInteger(request.deadline_ms) || request.deadline_ms <= 0)) {
    throw new Error("Invalid Rust workspace-scan deadline.");
  }
  if (request.scope.kind === "changed") {
    for (const changed of request.scope.paths) {
      if (changed.path.length === 0) throw new Error("Invalid Rust workspace-scan changed path.");
    }
  }
}

export type AuthoritativeChangeSet =
  | { readonly kind: "full" }
  | { readonly kind: "exact"; readonly changed_artifact_ids: readonly string[] };

/** Closed operation-level boundary implemented by the Rust composition worker. */
export interface IndexGenerationRequest {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly candidate_generation_id: string;
  readonly database_path: string;
  /** Private checkpoint sidecar generated by the Rust process transport. */
  readonly cancellation_path?: string;
  /** Private cutover switch for direct final-table promotion from Rust TEMP rows. */
  readonly direct_publication?: boolean;
  /** Explicit immutable CAS root captured before handing the generation to Rust. */
  readonly cas_root: string;
  readonly source_snapshot_id: string;
  readonly source_state_digest: string;
  readonly base_generation: number;
  readonly registry_snapshot_id: string;
  readonly configuration_revision_id: string;
  readonly resolution_lock_id: string;
  readonly workspace_schema_digest?: string;
  readonly change_set: AuthoritativeChangeSet;
  /** Generic Rust-owned candidate lifecycle metadata. */
  readonly candidate?: Readonly<Record<string, unknown>>;
  readonly frozen_base?: Readonly<Record<string, unknown>>;
  readonly work_manifest?: Readonly<Record<string, unknown>>;
  readonly engine: {
    readonly engine_id: string;
    readonly engine_version: string;
    readonly implementation_digest: string;
  };
  readonly deadline_ms?: number;
  /** Opaque source capture consumed by the selected engine inside Rust. */
  readonly engine_input?: Readonly<Record<string, unknown>>;
}

export interface IndexingProgress {
  readonly operation_id: string;
  readonly phase: "prepared" | "group_accepted" | "published";
  readonly completed_groups: number;
  readonly completed_owners: number;
  readonly completed_rows: number;
  readonly affected_paths?: readonly string[];
  readonly changed_paths?: readonly string[];
  readonly dependency_graph?: Readonly<Record<string, { readonly direct_files: readonly string[]; readonly complete: boolean }>>;
  readonly analysis_token?: string;
}

export interface IndexingResult {
  readonly operation_id: string;
  readonly generation: number;
  readonly group_count: number;
  readonly owner_count: number;
  readonly row_count: number;
  readonly ordered_digest: string;
  readonly lexical_closed?: number;
  readonly lexical_inserted?: number;
  readonly lexical_oversized?: number;
}

export interface RustIndexingCoreClient {
  indexGeneration(
    request: IndexGenerationRequest,
    onProgress?: (progress: IndexingProgress) => void | Promise<void>,
  ): Promise<IndexingResult>;
  cancel(operation_id: string): Promise<void>;
  status(operation_id: string): Promise<{ readonly active: boolean; readonly phase: string }>;
  shutdown(): Promise<void>;
}

/** Narrow injection point used by the structural scan. The provider owns the
 * operation-specific transport methods; the generic engine forwards only
 * source-frontier commits and cancellation/recovery controls. Structural
 * rows, candidate lifecycle and publication never return through this port. */
export interface RustIndexingCoreGenerationPort {
  /** True for the production composition worker, which owns candidate rows. */
  readonly owns_candidate_lifecycle?: boolean;
  cancel(): Promise<void>;
  /** Persist generic source-catalog rows when no structural candidate exists. */
  commit_source_index?: (input: {
    readonly operation_id: string;
    readonly workspace_id: string;
    readonly database_path: string;
    readonly commits: readonly unknown[];
    /** False for all but the final chunk of a large source capture. */
    readonly finalize_state?: boolean;
  }) => Promise<void>;
  /** Remove a failed source-only/fork frontier during Rust-owned recovery. */
  rollback_source_index?: (input: {
    readonly operation_id: string;
    readonly workspace_id: string;
    readonly database_path: string;
  }) => Promise<void>;
}

/**
 * Validates the operation boundary before a request reaches the subprocess.
 * This intentionally checks only transport invariants; generation and source
 * authority validation remains in Rust.
 */
export function validateIndexGenerationRequest(request: IndexGenerationRequest): void {
  const identifiers: readonly [string, string][] = [
    ["operation_id", request.operation_id],
    ["workspace_id", request.workspace_id],
    ["candidate_generation_id", request.candidate_generation_id],
    ["database_path", request.database_path],
    ["cas_root", request.cas_root],
    ["source_snapshot_id", request.source_snapshot_id],
    ["registry_snapshot_id", request.registry_snapshot_id],
    ["configuration_revision_id", request.configuration_revision_id],
    ["resolution_lock_id", request.resolution_lock_id],
    ["engine.engine_id", request.engine.engine_id],
    ["engine.engine_version", request.engine.engine_version],
    ["engine.implementation_digest", request.engine.implementation_digest],
  ];
  for (const [label, value] of identifiers) {
    if (value.length === 0 || value.length > 240 || /[\u0000\r\n\t]/u.test(value)) {
      throw new Error(`Invalid Rust indexing-core ${label}.`);
    }
  }
  if (!isAbsolute(request.cas_root) || request.cas_root.length > 4096) {
    throw new Error("Invalid Rust indexing-core cas_root.");
  }
  if (!Number.isSafeInteger(request.base_generation) || request.base_generation < 0) {
    throw new Error("Invalid Rust indexing-core base generation.");
  }
  if (request.deadline_ms !== undefined && (!Number.isSafeInteger(request.deadline_ms) || request.deadline_ms <= 0)) {
    throw new Error("Invalid Rust indexing-core deadline.");
  }
}
