export type V4MutationKind = "edit" | "create" | "delete" | "rename" | "hub_edit";
export type V4MutationVariant = "edit" | "create" | "delete_leaf" | "delete_with_importers" | "rename_no_rewrite" | "rename_rewrite" | "hub_edit";

export const KIND_VARIANTS: Readonly<Record<V4MutationKind, readonly V4MutationVariant[]>>;

export function expandKindSequence(
  kinds: readonly V4MutationKind[],
  repeat: number,
): readonly { readonly kind: V4MutationKind; readonly variant: V4MutationVariant }[];

export interface V4AppliedMutation {
  readonly paths_touched: readonly string[];
  readonly detail: Record<string, unknown>;
  /** P3-7: epoch-ms (`performance.timeOrigin + performance.now()` clock) timestamp taken immediately before this variant's actual filesystem-mutating call -- see `applyMutation`'s doc comment in `v4-mutation-harness.mjs`. Callers measuring watcher/detection latency MUST use this, not their own pre-call timestamp. */
  readonly mutation_write_epoch_ms: number;
}

export function applyMutation(
  root: string,
  excludedPaths: readonly string[],
  usedPaths: Set<string>,
  variant: V4MutationVariant,
  marker: string,
  hubMinImporters: number,
): Promise<V4AppliedMutation>;

export interface V4RootSetMismatch {
  readonly root_a?: string;
  readonly root_b?: string;
  readonly count_a: number;
  readonly count_b: number;
  readonly only_in_incremental: readonly string[];
  readonly only_in_from_scratch: readonly string[];
  readonly truncated: boolean;
}

export interface V4RootSetComparison {
  readonly roots_equal: Record<string, boolean>;
  readonly mismatches?: Record<string, V4RootSetMismatch>;
  readonly base_a: string;
  readonly deltas_a: readonly string[];
  readonly base_b: string;
  readonly deltas_b: readonly string[];
}

export function compareRootSets(structuralRootA: string, structuralRootB: string): V4RootSetComparison;

export interface V4MutationHarnessOptions {
  readonly corpus: string;
  readonly native_root: string;
  readonly output: string;
  readonly data_root?: string;
  readonly owners?: number;
  readonly verify_roots: "each" | "final";
  readonly mutation_kinds: readonly V4MutationKind[];
  readonly repeat: number;
  readonly readiness_timeout_ms: number;
  readonly poll_interval_ms: number;
  /** P3-5 (plan §6.1's daemon-latency item): "events" tightens the readiness-wait loop's own polling interval to 25ms (no daemon-side push-notification RPC exists to subscribe to instead); defaults to "poll" (the pre-existing `poll_interval_ms`-governed behavior). */
  readonly readiness_mode?: "poll" | "events";
  readonly hub_min_importers: number;
}

/** P3-5: named phase breakdown (ms) derived from a scan's `last_scan_timeline` -- see `deriveTimelineLatencies` in `v4-mutation-harness.mjs`. Any field is `undefined` if the timeline never reached that milestone. */
export interface V4TimelineBreakdown {
  readonly watcher_detection?: number;
  readonly aggregation_debounce?: number;
  readonly admission_and_ipc?: number;
  readonly worker_to_queryable?: number;
  readonly worker_to_durable?: number;
  readonly readiness_update_overhead?: number;
}

export interface V4MutationHarnessColdResult {
  readonly queryable_ms?: number;
  readonly durable_ms?: number;
  readonly queryable_generation?: number;
  readonly durable_generation?: number;
  readonly roots_equal?: Record<string, boolean>;
  readonly fallback_full?: boolean;
  /** P3-5: timeline-derived (daemon's own timestamps), not poll-quantized -- see `deriveTimelineLatencies`. */
  readonly event_queryable_ms?: number;
  readonly event_durable_ms?: number;
  readonly timeline_breakdown_ms?: V4TimelineBreakdown;
}

export interface V4MutationHarnessMutationResult {
  readonly mutation_index: number;
  readonly mutation_id: string;
  readonly kind: V4MutationKind;
  readonly variant: V4MutationVariant;
  readonly detail: Record<string, unknown>;
  /** P3-7: ms this mutation's own `applyMutation` call spent re-listing the corpus and rebuilding the import graph before its actual write -- harness-side overhead only, not folded into any latency field below. */
  readonly harness_selection_overhead_ms: number;
  readonly queryable_ms?: number;
  readonly durable_ms?: number;
  /** P3-5: timeline-derived (daemon's own timestamps), not poll-quantized -- see `deriveTimelineLatencies`. */
  readonly event_queryable_ms?: number;
  readonly event_durable_ms?: number;
  readonly timeline_breakdown_ms?: V4TimelineBreakdown;
  readonly queryable_generation?: number;
  readonly durable_generation?: number;
  readonly fallback_full?: boolean;
  readonly roots_equal?: Record<string, boolean>;
  readonly mismatches?: Record<string, V4RootSetMismatch>;
  readonly resulting_corpus_digest: string;
}

export interface V4MutationHarnessFinalResult {
  readonly roots_equal: Record<string, boolean>;
  readonly fallback_full: boolean;
  readonly mismatches?: Record<string, V4RootSetMismatch>;
}

export interface V4MutationHarnessReport {
  readonly schema_version: 1;
  readonly mode: "v4";
  readonly corpus: string;
  readonly owners?: number;
  readonly verify_roots: "each" | "final";
  readonly changed_scope_unsupported_warning_seen: boolean;
  readonly cold: V4MutationHarnessColdResult;
  readonly mutations: readonly V4MutationHarnessMutationResult[];
  readonly final?: V4MutationHarnessFinalResult;
}

export function run(options: V4MutationHarnessOptions): Promise<V4MutationHarnessReport>;
