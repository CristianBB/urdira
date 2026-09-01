import { canonicalBytes, digestBytes, digestCanonicalArray, digestMappedCanonicalArray } from "@urdira/canonical";
import type {
  CandidateWorkManifest,
  CompletenessReport,
  IndexCandidate,
  InvalidationPlan,
  JsonValue,
  OrderedSetDescriptor,
  PluginResolutionLock,
  PluginStructuralStageDeclaration,
  RegistrySnapshot,
  ReplacementScope,
  SnapshotCapabilityStateEntry,
  SourceProviderRequestEnvelope,
  WorkspaceConfigurationRevision,
  WorkspaceFreshnessCheckpoint,
} from "@urdira/contracts";
import type { AssembledPluginRegistry, SdkPluginResolutionLock } from "@urdira/plugin-sdk";
import type { CandidatePublicationInput, SourceIndexCommitInput, WorkspaceDatabase } from "@urdira/storage";
import { frozenCandidateBaseTupleDigest, normalizeObservationBatchIds, WORKSPACE_WRITER_BUSY_CODE } from "@urdira/storage";
import type { GitIgnoreRules, InclusionRules } from "@urdira/security";
import {
  CandidateIndexer,
  type CandidatePublicationResult,
  type CandidateRunResult,
  type CandidateRunTrigger,
} from "./candidate-indexer.js";
import type { CandidateExecutionDag, CandidatePlan, FrozenCandidateBaseTuple } from "./candidate-planning.js";
import { CandidateMaterializer, CandidateRecordTemplateAccumulator, type SealedCandidateMaterialization } from "./candidate-materialization.js";
import { MaterializationDigestOffload } from "./materialization-digest-offload.js";
import { record as recordEngineTiming, resetTimings as resetEngineTimings, snapshotCounters as snapshotEngineCounters, snapshotTimings as snapshotEngineTimings, timedSync as timedSyncEngine, timingEnabled as engineTimingEnabled } from "./debug-timing.js";
import {
  DirectorySourceProvider,
  type EncodedObservationBatch,
  type ProviderObservation,
} from "./directory-provider.js";
import { EngineError } from "./errors.js";
import type { MaterializationAcceptedFactDelta } from "./fact-delta.js";
import type { FactDeltaBatch } from "@urdira/contracts";
import { GenericSourceIndexer, type SourceIndexApplyResult } from "./source-indexer.js";
import { sourceProviderRequestDigest } from "./source-provider.js";
import type { SourceCandidateAbsenceObservation, SourceCandidateBase, SourceCandidateBaseAbsence, SourceCandidateBaseOccurrence, SourceCandidateObservationSet, SourceCandidatePlan, SourceCandidatePresentObservation } from "./source-candidate-planning.js";
import { createWorkspaceCandidatePort } from "./workspace-indexing-port.js";
import type { RustIndexingCoreGenerationPort } from "./rust-indexing-core-port.js";
import type { WatcherHint } from "./watchers.js";

/**
 * A single cataloged source file, ready to hand to a language plugin for analysis.
 * `text` is the exact UTF-8 content that stage 1 (source cataloging) durably
 * committed for this artifact version, so plugin analysis always operates on
 * the same bytes that are now visible in the workspace's source index.
 */
export interface WorkspaceScanSourceArtifact {
  readonly path: string;
  /** Present for legacy/in-process plugin providers; native providers read from CAS in the worker. */
  readonly text?: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_blob_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
}

export interface WorkspaceScanAnalysisOutcome {
  readonly accepted_deltas: readonly MaterializationAcceptedFactDelta[];
  readonly capability_state_entries: readonly SnapshotCapabilityStateEntry[];
  /** True when the Rust indexing core has already accepted and staged every
   * structural owner row represented by this analysis result. */
  readonly rust_promoted_structural_rows?: boolean;
  /** Native batches accepted by the core before materialisation. */
  readonly native_batches?: readonly { readonly fact_delta_id: string; readonly batch: FactDeltaBatch }[];
  /** Private Rust-core commit hook. It runs only after the candidate
   * publication has become visible; implementations must acknowledge their
   * engine state here, never when analysis merely finishes. */
  readonly on_published?: () => void | Promise<void>;
  /** Private cutover hook: complete Rust-side staging/publication before the
   * TypeScript candidate transaction makes the snapshot visible. */
  readonly on_pre_published?: () => void | Promise<void>;
  /** Completes a Rust-owned publication without creating TS materialization or template arrays. */
  readonly external_publication?: (context: {
    readonly candidate: IndexCandidate;
    readonly frozen_base: FrozenCandidateBaseTuple;
    readonly source_transitions: readonly unknown[];
    readonly capability_state_entries: readonly SnapshotCapabilityStateEntry[];
    readonly freshness_checkpoint: WorkspaceFreshnessCheckpoint;
    readonly source_snapshot_id: string;
    readonly publication_kind: string;
    readonly publication_stage_id: string | undefined;
    readonly publication_stage_ordinal: number | undefined;
    readonly publication_stage_count: number | undefined;
    /** Generic source-catalog rows captured by TypeScript/CAS and published by Rust. */
    readonly source_index_commits?: readonly SourceIndexCommitInput[];
  }) => Promise<CandidatePublicationResult>;
  /** Runs after the candidate materialization is persisted and before the
   * atomic workspace publication transaction begins. */
  readonly before_publication?: (context: { readonly publication: CandidatePublicationInput }) => void | Promise<void>;
}

/**
 * The language-plugin-specific half of a workspace scan. `@urdira/engine` does
 * not depend on any production language plugin package (see
 * `architecture/manifest.json`), so this port lets a caller (a language plugin
 * integration, or a test) supply an already-assembled plugin registry and the
 * per-artifact analysis behavior, while the engine stays responsible only for
 * generic source cataloging and candidate orchestration.
 */
export interface WorkspaceScanPluginProvider {
  /** Private Rust composition boundary owned by the provider resolver. */
  readonly indexing_core?: RustIndexingCoreGenerationPort;
  /** The provider accepts CAS references and performs its own bounded native reads. */
  readonly supports_native_content_refs?: boolean;
  /** Persistent analyzers require every current artifact to preserve complete project state. */
  readonly requires_complete_artifact_manifest?: boolean;
  /** Private physical optimization for genuine initial publications. Each
   * group must be contiguous and is published at its final declared stage. */
  readonly initial_publication_stage_groups?: readonly {
    readonly stage_ids: readonly string[];
  }[];
  /** Providers opt into staged calls after validating stage coordinates end-to-end. */
  readonly supports_progressive_publication?: boolean;
  readonly registry_snapshot_id: string;
  readonly configuration_revision_id: string;
  readonly registry: AssembledPluginRegistry;
  readonly resolution_lock: SdkPluginResolutionLock;
  readonly configuration: WorkspaceConfigurationRevision;
  readonly dependency_roles: readonly string[];
  /**
   * P3-3b: optional streaming consumer a provider supplies to receive a file's
   * complete decoded text as soon as source cataloging (`runFullWorkspaceScan`,
   * below) has it in memory anyway -- see `DirectorySourceProviderOptions.on_prefetched_text`
   * (`directory-provider.ts`) for the exact guarantee (only unchanged,
   * NUL-free, valid-UTF-8 files that the P3-3a byte hand-off actually
   * admitted). `@urdira/engine` never reads this field itself -- it is
   * passed straight through to the provider constructor -- which is why it
   * lives on `WorkspaceScanPluginProvider` rather than a new top-level scan
   * option: only the SAME composing application that builds `analyze`
   * (`apps/urdira`) can also make sense of the text (e.g. a language-specific
   * import-graph pre-seed), and engine stays plugin-agnostic either way.
   */
  readonly on_source_text?: (uri: string, text: string) => void;
  analyze(input: {
    readonly workspace_id: string;
    readonly candidate: IndexCandidate;
    /** Exact immutable base tuple frozen before source capture. */
    readonly frozen_base?: FrozenCandidateBaseTuple;
    /** Source frontier digest captured before structural analysis. */
    readonly source_state_digest?: string;
    /** Source snapshot coordinate paired with the captured frontier. */
    readonly source_snapshot_id?: string;
    /** Rust-owned lifecycle metadata for the current pure work plan. */
    readonly candidate_work_manifest?: CandidateWorkManifest;
    readonly artifacts: readonly WorkspaceScanSourceArtifact[];
    /** Cancels analysis when the owning workspace scan is superseded. */
    readonly signal?: AbortSignal;
    /**
     * Phase 5.3: the `artifact_id`s of every artifact this scan's planner
     * actually found a transition for (created/updated/recreated/reincluded/
     * deleted/excluded -- see `SourceCandidatePlanner`,
     * `packages/engine/src/source-candidate-planning.ts`), i.e. everything
     * that genuinely changed this scan. `undefined` on a genuine first scan
     * (no prior published generation to diff against), in which case a
     * plugin provider MUST treat every artifact as affected -- there is
     * nothing yet to reuse. A provider MAY use this to analyze only the
     * changed artifacts and whatever else transitively depends on them
     * (e.g. via per-file import closures it computes itself), leaving every
     * other artifact's records to survive via base-record reuse at seal
     * (`CandidateMaterializer.seal`'s `base_records` handling,
     * `packages/engine/src/candidate-materialization.ts`) -- `artifacts`
     * (above) still lists EVERY currently-cataloged artifact regardless,
     * since whatever a provider uses to build its own project/program
     * context generally still needs the full corpus even when only a
     * subset gets fresh `analyze_artifact` work.
     */
    readonly changed_artifact_ids?: readonly string[];
    /** Ordered publication stage requested by the core; omitted means legacy full analysis. */
    readonly publication_stage_id?: string;
    /** Exact contiguous stage group accumulated into this final-stage call. */
    readonly included_publication_stage_ids?: readonly string[];
    readonly preceding_stage_snapshot_id?: string;
    /**
     * Consumer for compacted accepted deltas. When supplied, a production
     * provider may stream the delta instead of retaining it in the returned
     * `accepted_deltas` array; the consumer is part of the scan's correctness
     * path, not merely an observation hook.
     */
    readonly on_accepted_delta?: (delta: MaterializationAcceptedFactDelta) => void | Promise<void>;
    /** Optional private Rust owner-group sink. When present, the provider
     * feeds it while analysis runs and the engine commits it after visibility. */
    readonly indexing_core?: RustIndexingCoreGenerationPort;
  }): Promise<WorkspaceScanAnalysisOutcome>;
}

export interface WorkspaceScanBudget {
  readonly max_duration_ms?: number;
  readonly max_response_bytes?: number;
}

export interface RunFullWorkspaceScanInput {
  readonly root: string;
  readonly database: WorkspaceDatabase;
  readonly workspace_id: string;
  readonly plugin: WorkspaceScanPluginProvider;
  readonly source_provider_binding_id?: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly scan_budget?: WorkspaceScanBudget;
  readonly now?: () => string;
  /**
   * Maximum number of concurrent provider I/O operations (directory-entry
   * stat/capture during enumeration, and per-observation reads afterward).
   * Threaded from `apps/urdira`'s `URDIRA_SCAN_IO_CONCURRENCY` env var
   * through `DaemonRuntimeOptions.scan_io_concurrency`; defaults live in
   * `DirectorySourceProvider` and `GenericSourceIndexer` (both 16) when
   * omitted.
   */
  readonly io_concurrency?: number;
  /** Internal stage coordinate used by progressive structural publication. */
  readonly publication_stage_id?: string;
  readonly publication_stage_ordinal?: number;
  readonly publication_stage_count?: number;
  readonly included_publication_stage_ids?: readonly string[];
  /** Source capture prepared by stage 1 and reused by later progressive stages. */
  readonly prepared_scan?: PreparedWorkspaceScan;
  /** Internal progressive-scan hook; never crosses the public engine port. */
  readonly on_prepared_scan?: (scan: PreparedWorkspaceScan) => void | Promise<void>;
  /** Called after each atomic structural publication in a progressive scan. */
  readonly on_stage_published?: (stage: PluginStructuralStageDeclaration, result: CandidateRunResult) => void | Promise<void>;
  /** Safe watcher hints for narrowing analysis; omitted means a full reconcile. */
  readonly changed_uris?: readonly string[];
  /** Concrete watcher deletions already proven authoritative by the backend. */
  readonly authoritative_delete_events?: readonly WatcherHint[];
  /** Cancels a superseded generation before analysis or publication. */
  readonly signal?: AbortSignal;
  /** Private structural Rust-core generation boundary. */
  readonly indexing_core?: RustIndexingCoreGenerationPort;
}

export interface PreparedWorkspaceScan {
  /** Metadata only; stage transitions reload the verified bytes from CAS. */
  readonly source_artifacts: readonly Omit<WorkspaceScanSourceArtifact, "text">[];
  readonly observations: SourceCandidateObservationSet;
  readonly source_index_generation: number;
  readonly captured_byte_lease: CapturedByteLease;
  /**
   * Exact source transition set frozen by stage 1 and reused by every later
   * progressive stage. `undefined` deliberately means full analysis (first
   * publication or resolution-lock change); an empty array means no plugin
   * source changed. Later stages must not recompute this against the snapshot
   * just published by their predecessor, because that would erase the work
   * set that the progressive generation is meant to complete.
   */
  readonly changed_artifact_ids: readonly string[] | undefined;
  /** True only when stage 1 began without any published workspace snapshot.
   * Later stages preserve this coordinate so they may keep consuming deltas
   * incrementally without confusing a stage-1 predecessor with older user
   * history that would require base-record reconciliation. */
  readonly initial_publication: boolean;
}

interface ProgressiveChangedArtifactCheckpoint {
  readonly workspace_id: string;
  readonly source_snapshot_id: string;
  readonly registry_snapshot_id: string;
  readonly resolution_lock_id: string;
  readonly configuration_revision_id: string;
  readonly stage_sequence_digest: string;
  readonly first_stage_id: string;
  readonly first_stage_ordinal: number;
  readonly stage_count: number;
  readonly analysis_scope: "full" | "changed_artifacts";
  readonly changed_artifact_ids: readonly string[];
  readonly initial_publication: boolean;
}

export interface CapturedByteLease {
  readonly lease_id: string;
  readonly expires_at: number;
  readonly renew: () => void;
  /** Verifies and returns the captured bytes keyed by artifact id. */
  readonly verify: (database: WorkspaceDatabase) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly release: () => void;
}

function capturedByteLease(
  workspaceId: string,
  generation: number,
  artifacts: readonly Omit<WorkspaceScanSourceArtifact, "text">[],
): CapturedByteLease {
  let active = true;
  let expiresAt = Date.now() + 10 * 60 * 1000;
  const leaseId = `captured-bytes:${workspaceId}:${generation}`;
  return {
    lease_id: leaseId,
    get expires_at() { return expiresAt; },
    renew: () => {
      if (!active || Date.now() >= expiresAt) throw new EngineError("engine:workspace_scan_stale", `Captured-byte lease ${leaseId} expired.`);
      expiresAt = Date.now() + 10 * 60 * 1000;
    },
    verify: async (database) => {
      if (!active || Date.now() >= expiresAt) throw new EngineError("engine:workspace_scan_stale", `Captured-byte lease ${leaseId} expired.`);
      return database.sourceIndex.readVerifiedContentBlobs(artifacts);
    },
    release: () => { active = false; },
  };
}

export interface RunSourceOnlyWorkspaceScanInput {
  readonly root: string;
  readonly database: WorkspaceDatabase;
  readonly workspace_id: string;
  readonly source_provider_binding_id?: string;
  readonly inclusion_rules?: InclusionRules;
  readonly gitignore_rules?: GitIgnoreRules;
  readonly scan_budget?: WorkspaceScanBudget;
  readonly now?: () => string;
  readonly io_concurrency?: number;
  /** Safe watcher hints; missing/unsafe paths fall back to full reconciliation. */
  readonly changed_uris?: readonly string[];
  readonly authoritative_delete_events?: readonly WatcherHint[];
  readonly signal?: AbortSignal;
  /** Rust-owned source writer for production workspaces without a language plugin. */
  readonly indexing_core?: RustIndexingCoreGenerationPort;
}

export interface SourceOnlyWorkspaceScanResult {
  readonly status: "source_ready";
  readonly source_snapshot_id: string;
  readonly generation: number;
}

/** Publishes only the generic source catalog when no language plugin is available. */
export async function runSourceOnlyWorkspaceScan(input: RunSourceOnlyWorkspaceScanInput): Promise<SourceOnlyWorkspaceScanResult> {
  if (input.signal?.aborted) throw new EngineError("core:operation_cancelled", "Workspace source scan generation was superseded.");
  const now = input.now ?? (() => new Date().toISOString());
  const workspaceId = input.workspace_id;
  const bindingId = input.source_provider_binding_id ?? "provider:filesystem";
  const provider = new DirectorySourceProvider({
    root: input.root,
    workspace_id: workspaceId,
    source_provider_binding_id: bindingId,
    ...(input.inclusion_rules === undefined ? {} : { inclusion_rules: input.inclusion_rules }),
    ...(input.gitignore_rules === undefined ? {} : { gitignore_rules: input.gitignore_rules }),
    ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }),
    now,
  });
  const scope = { scope_type: "source_root" as const, source_provider_binding_id: bindingId, source_provider: provider.component_id, normalized_scope_key: "" };
  const current = await input.database.repositories.snapshots.getCurrent();
  const deferredSourceCommits: SourceIndexCommitInput[] = [];
  const rawSourceCommit = input.indexing_core?.commit_source_index;
  const sourceCommit = rawSourceCommit === undefined ? undefined : withWorkspaceWriterBusyCode(rawSourceCommit);
  const sourceCaptureControl = sourceCommit === undefined ? {} : {
    prepare_content_blobs: async ({ contents, content_streams }: { readonly contents: readonly import("@urdira/storage").SourceIndexContentInput[]; readonly content_streams: readonly import("@urdira/storage").SourceIndexContentStreamInput[] }) => await input.database.prepareSourceIndexContent({ contents, content_streams }),
    defer_commit: async (commit: SourceIndexCommitInput): Promise<void> => { deferredSourceCommits.push(commit); },
  };
  const authoritativeDeletes = input.authoritative_delete_events ?? [];
  const deferredWatchCommits: SourceIndexCommitInput[] = [];
  const watchCaptureControl = sourceCommit === undefined ? {} : {
    prepare_content_blobs: async ({ contents, content_streams }: { readonly contents: readonly import("@urdira/storage").SourceIndexContentInput[]; readonly content_streams: readonly import("@urdira/storage").SourceIndexContentStreamInput[] }) => await input.database.prepareSourceIndexContent({ contents, content_streams }),
    defer_commit: async (commit: SourceIndexCommitInput): Promise<void> => { deferredWatchCommits.push(commit); },
  };
  const watchResult = authoritativeDeletes.length === 0 ? undefined : await new GenericSourceIndexer(input.database).apply({
    response: authoritativeWatchResponse({ workspaceId, bindingId, componentId: provider.component_id, componentVersion: provider.component_version, events: authoritativeDeletes, now }),
    supports_authoritative_delete_events: true,
    publication_current_generation: current?.current_generation ?? 0,
    ...watchCaptureControl,
  });
  if (sourceCommit !== undefined && deferredWatchCommits.length > 0) {
    /* c8 ignore next -- transport-specific request framing is covered by the Rust-process transport suite. */
    await sourceCommit({
      operation_id: `source-watch:${workspaceId}:${watchResult?.observation_batch_id ?? "watch"}`,
      workspace_id: workspaceId,
      database_path: input.database.database.filename,
      commits: deferredWatchCommits,
    });
  }
  /* c8 ignore next -- DirectorySourceProvider enumeration is exercised by the integration harness; this composition wrapper only forwards its result. */
  const enumeration = await provider.enumerateNativeBatches(providerRequest({
    call: "enumerate", workspaceId, bindingId, componentId: provider.component_id, componentVersion: provider.component_version,
    payload: { coverage_scopes: [scope] }, ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }), now,
  }), {
    ...(input.changed_uris === undefined ? {} : { changed_uris: input.changed_uris }),
    ...(watchResult !== undefined && watchResult.status !== "degraded" && (input.changed_uris?.length ?? 0) === 0 ? { allow_empty_incremental: true } : {}),
  });
  /* c8 ignore next -- cancellation between provider completion and commit is covered by the generic scan coordinator. */
  if (input.signal?.aborted) throw new EngineError("core:operation_cancelled", "Workspace source scan generation was superseded.");
  const response = enumeration.response;
  /* c8 ignore next -- DirectorySourceProvider fails closed before returning a non-success envelope. */
  if (response.outcome !== "success") throw new EngineError("engine:workspace_scan_enumeration_failed", `Directory enumeration for ${input.root} did not succeed (outcome ${response.outcome}).`);
  // Source-only production always consumes the provider's bounded stream
  // hand-off. Keep the byte-returning callback for the generic indexer's
  // legacy adapter contract; its behavior is covered by source-indexer tests,
  // while this composition cannot reach it without disabling readStream.
  /* c8 ignore next */
  const read = async (observation: ProviderObservation) => await provider.read(providerRequest({
    call: "read", workspaceId, bindingId, componentId: provider.component_id, componentVersion: provider.component_version,
    payload: {
      artifact_id: observation.artifact_id,
      normalized_uri: observation.normalized_uri,
      observed_content_hash: observation.observed_content_hash,
      observed_metadata_digest: observation.observed_metadata_digest,
      provider_version_token: observation.provider_version_token,
    }, ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }), now,
  }));
  // `read_stream` was missing here for a long time: `enumerateNativeBatches`
  // starts the bounded byte hand-off unconditionally on a complete capture,
  // so without a `readStream` consumer every prefetched entry sat unclaimed
  // (up to the whole 64MiB budget held live, prefetch workers parked on the
  // gate) while the catalog re-read every file through the legacy `read`
  // path anyway.
  const readStream = async (observation: ProviderObservation, streamOptions?: { readonly reuse_existing?: boolean }) => provider.readStream({
    artifact_id: observation.artifact_id,
    normalized_uri: observation.normalized_uri,
    observed_content_hash: observation.observed_content_hash,
    observed_metadata_digest: observation.observed_metadata_digest,
    provider_version_token: observation.provider_version_token,
  }, streamOptions);
  let result: SourceIndexApplyResult;
  try {
    result = await new GenericSourceIndexer(input.database).apply({
      response,
      native_batches: enumeration.batches,
      allow_partial: enumeration.incremental,
      read,
      read_stream: readStream,
      publication_current_generation: current?.current_generation ?? 0,
      ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }),
      ...sourceCaptureControl,
    });
  } finally {
    await provider.abortPrefetch();
  }
  /* c8 ignore next -- degraded source status is already rejected inside the generic indexer contract tests. */
  if (result.status !== "published" && result.status !== "equivalent") throw new EngineError("engine:workspace_scan_source_index_degraded", `Source cataloging of ${input.root} did not complete (status ${result.status}, error ${result.error_code ?? "none"}).`);
  const rustSourceCommitted = sourceCommit !== undefined && deferredSourceCommits.length > 0;
  if (rustSourceCommitted) {
    /* c8 ignore next -- transport-specific request framing is covered by the Rust-process transport suite. */
    await sourceCommit({
      operation_id: `source-index:${workspaceId}:${result.generation}:${result.observation_batch_id ?? "scan"}`,
      workspace_id: workspaceId,
      database_path: input.database.database.filename,
      commits: deferredSourceCommits,
    });
  }
  // A source-only scan can contain both a watch commit and an enumeration
  // commit. Once Rust has folded those commits, read the durable frontier so
  // the returned snapshot cannot reflect only the last in-memory fragment.
  /* c8 ignore next -- the fallback expression is retained for the test/oracle writer only. */
  const state = rustSourceCommitted ? await input.database.sourceIndex.getState() : result.next_state ?? await input.database.sourceIndex.getState();
  /* c8 ignore next -- the fallback is the compatibility oracle path; Rust production always reads after its commit. */
  const occurrences = rustSourceCommitted ? await input.database.sourceIndex.currentOccurrencesSlim(bindingId) : result.current_occurrences ?? await input.database.sourceIndex.currentOccurrencesSlim(bindingId);
  /* c8 ignore next -- empty-workspace admission is covered by source-provider tests. */
  if (state === undefined || (occurrences.length === 0 && (watchResult?.watch_absences?.length ?? 0) === 0)) throw new EngineError("engine:workspace_scan_empty", `No eligible source files were found under ${input.root}.`);
  return { status: "source_ready", source_snapshot_id: `source-snapshot:${state.current_generation}`, generation: state.current_generation };
}

function digest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digest(value).slice("sha256:".length)}`;
}

function progressiveStageSequenceDigest(stages: readonly PluginStructuralStageDeclaration[]): string {
  return digest(stages.map((stage) => ({
    stage_id: stage.stage_id,
    ordinal: stage.ordinal,
    stage_count: stage.stage_count,
    depends_on_stage_ids: [...stage.depends_on_stage_ids],
    capabilities: [...stage.capabilities],
  })));
}

function progressiveChangedArtifactCheckpointKey(checkpoint: Pick<ProgressiveChangedArtifactCheckpoint,
  "workspace_id" | "source_snapshot_id" | "registry_snapshot_id" | "resolution_lock_id" | "configuration_revision_id" | "stage_sequence_digest"
>): string {
  return stableId("progressive-changed-artifacts", {
    workspace_id: checkpoint.workspace_id,
    source_snapshot_id: checkpoint.source_snapshot_id,
    registry_snapshot_id: checkpoint.registry_snapshot_id,
    resolution_lock_id: checkpoint.resolution_lock_id,
    configuration_revision_id: checkpoint.configuration_revision_id,
    stage_sequence_digest: checkpoint.stage_sequence_digest,
  });
}

function makeProgressiveChangedArtifactCheckpoint(options: {
  readonly workspace_id: string;
  readonly source_snapshot_id: string;
  readonly registry_snapshot_id: string;
  readonly resolution_lock_id: string;
  readonly configuration_revision_id: string;
  readonly stages: readonly PluginStructuralStageDeclaration[];
  readonly changed_artifact_ids: readonly string[] | undefined;
  readonly initial_publication: boolean;
}): ProgressiveChangedArtifactCheckpoint {
  const firstStage = options.stages[0];
  if (firstStage === undefined) throw new EngineError("engine:workspace_scan_no_stages", "Progressive publication declared no executable stages.");
  return {
    workspace_id: options.workspace_id,
    source_snapshot_id: options.source_snapshot_id,
    registry_snapshot_id: options.registry_snapshot_id,
    resolution_lock_id: options.resolution_lock_id,
    configuration_revision_id: options.configuration_revision_id,
    stage_sequence_digest: progressiveStageSequenceDigest(options.stages),
    first_stage_id: firstStage.stage_id,
    first_stage_ordinal: firstStage.ordinal,
    stage_count: options.stages.length,
    analysis_scope: options.changed_artifact_ids === undefined ? "full" : "changed_artifacts",
    changed_artifact_ids: options.changed_artifact_ids === undefined
      ? []
      : [...new Set(options.changed_artifact_ids)].sort(),
    initial_publication: options.initial_publication,
  };
}

function isProgressiveChangedArtifactCheckpoint(value: unknown, expected: Omit<ProgressiveChangedArtifactCheckpoint, "analysis_scope" | "changed_artifact_ids" | "initial_publication">): value is ProgressiveChangedArtifactCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<ProgressiveChangedArtifactCheckpoint>;
  if (checkpoint.workspace_id !== expected.workspace_id
    || checkpoint.source_snapshot_id !== expected.source_snapshot_id
    || checkpoint.registry_snapshot_id !== expected.registry_snapshot_id
    || checkpoint.resolution_lock_id !== expected.resolution_lock_id
    || checkpoint.configuration_revision_id !== expected.configuration_revision_id
    || checkpoint.stage_sequence_digest !== expected.stage_sequence_digest
    || checkpoint.first_stage_id !== expected.first_stage_id
    || checkpoint.first_stage_ordinal !== expected.first_stage_ordinal
    || checkpoint.stage_count !== expected.stage_count
    || typeof checkpoint.initial_publication !== "boolean"
    || (checkpoint.analysis_scope !== "full" && checkpoint.analysis_scope !== "changed_artifacts")
    || !Array.isArray(checkpoint.changed_artifact_ids)
    || checkpoint.changed_artifact_ids.some((artifactId) => typeof artifactId !== "string" || artifactId.length === 0)) return false;
  const normalized = [...new Set(checkpoint.changed_artifact_ids)].sort();
  if (normalized.length !== checkpoint.changed_artifact_ids.length
    || normalized.some((artifactId, index) => artifactId !== checkpoint.changed_artifact_ids?.[index])) return false;
  return checkpoint.analysis_scope === "full"
    ? checkpoint.changed_artifact_ids.length === 0
    : checkpoint.changed_artifact_ids.length > 0;
}

/**
 * `snapshots.get(...).source_observation_watermarks` is the same
 * JSON-encoded `{ watermarks, source_observation_batch_ids }` shape that
 * `WorkspaceDatabase.publishCandidateSerialized`'s private
 * `snapshotObservationBatchIds` (`packages/storage/src/storage.ts`) parses to
 * decide whether a new candidate's frozen base still agrees with the
 * workspace's current published tuple. That helper is not exported, so this
 * is a small, deliberately equivalent parse over the same public field
 * (`SnapshotRepository.get`, `@urdira/storage`) rather than a new dependency
 * on storage internals.
 */
function priorObservationBatchIds(sourceObservationWatermarks: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(sourceObservationWatermarks);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const batchIds = (parsed as Record<string, unknown>)["source_observation_batch_ids"];
    if (!Array.isArray(batchIds)) return [];
    return batchIds.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * The stage-1 source index's own `provider_watermarks` column (distinct from
 * a snapshot's `source_observation_watermarks`) is a plain
 * `Record<provider_binding_id, watermark>` JSON object, already parsed the
 * same way by `packages/engine/src/source-indexer.ts`'s private
 * `parseWatermarks` (not exported). Carrying this forward lets the planner's
 * `next_freshness_checkpoint` correctly report the freshness this workspace
 * already had, merged with this scan's own watermark.
 */
function priorProviderWatermarks(providerWatermarks: string | undefined): Record<string, string> {
  if (providerWatermarks === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(providerWatermarks);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "string") result[key] = value;
    return result;
  } catch {
    return {};
  }
}

/**
 * The exact owner-artifact-id set `CandidateMaterializer.seal`'s own
 * `matchingBaseRecords` filter (`packages/engine/src/candidate-materialization.ts`)
 * would keep out of a full `base_records`/`base_projections` scan: every
 * replacement scope across every accepted delta names the one owner artifact
 * it replaces records for (`ReplacementScope.owner_artifact_id`), and
 * `matchingBaseRecords`/`projectionTemplates`/`validateBindings` never touch
 * a base row whose owner isn't one of these (see this change's audit in the
 * spec for why -- in short, the production scan path never populates
 * `accepted_projection_sets`/`record_dependencies`/`lookup_bindings`, the
 * only inputs that could otherwise pull in an out-of-scope base id). Reusing
 * this set to pre-narrow the `base_records`/`base_projections` load (below)
 * therefore changes nothing about what `seal` produces -- it only changes
 * how many rows get read to produce it.
 */
function replacementScopeOwnerArtifactIds(acceptedDeltas: readonly MaterializationAcceptedFactDelta[]): readonly string[] {
  const owners = new Set<string>();
  for (const delta of acceptedDeltas) for (const set of delta.replacement_sets) owners.add(set.scope.owner_artifact_id);
  return [...owners];
}

function orderedSet(descriptorId: string, elementType: string, entryCount: number, contentSeed: unknown): OrderedSetDescriptor {
  return {
    descriptor_id: descriptorId,
    element_type: elementType,
    element_schema_version: "1",
    comparator_id: "core:lexicographic_uri",
    comparator_version: "1",
    entry_count: entryCount,
    content_digest: digest(contentSeed),
  };
}

/**
 * Builds the small source-plan control envelope used by the Rust route.
 * SourceCandidatePlanner remains the compatibility oracle, but Rust-owned
 * generations already have the complete source frontier in SourceIndexApplyResult
 * and must not allocate/serialize a second transition array in TypeScript.
 */
function rustSourcePlan(input: {
  readonly workspace_id: string;
  readonly observations: SourceCandidateObservationSet;
  readonly base: SourceCandidateBase;
  readonly source_result: SourceIndexApplyResult;
  readonly deferred_commits?: readonly SourceIndexCommitInput[];
  readonly force_candidate: boolean;
  readonly now: string;
}): SourceCandidatePlan {
  const state = input.deferred_commits?.at(-1)?.state ?? input.source_result.next_state;
  const sourceStateDigest = state?.source_state_digest ?? input.base.source_state_digest;
  let providerWatermarkMap: Record<string, string> = { ...input.base.provider_watermarks };
  if (state?.provider_watermarks !== undefined) {
    try {
      const parsed = JSON.parse(state.provider_watermarks) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        providerWatermarkMap = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      }
    } catch { /* retain the validated base map below */ }
  } else if (input.source_result.status !== "degraded") {
    providerWatermarkMap[input.observations.source_provider_binding_id] = input.observations.watermark;
  }
  const providerWatermarks = JSON.stringify(Object.fromEntries(Object.entries(providerWatermarkMap).sort(([left], [right]) => left.localeCompare(right))));
  const deferredChanges = input.deferred_commits?.some((commit) => commit.versions.length > 0 || commit.tombstones.length > 0 || commit.version_closures.length > 0 || commit.tombstone_closures.length > 0) === true;
  const verificationStatus = input.source_result.changed === true || deferredChanges ? "changes_pending" : "equivalent";
  const checkpointPayload = {
    workspace_id: input.workspace_id,
    source_state_digest: sourceStateDigest,
    provider_watermarks: providerWatermarks,
    verification_status: verificationStatus,
    unavailable_artifact_ids: "[]",
    verified_at: input.observations.completed_at || input.now,
  };
  const checkpoint = {
    freshness_checkpoint_id: stableId("freshness-checkpoint", { ...checkpointPayload, batch_id: input.observations.observation_batch_id }),
    ...checkpointPayload,
    checkpoint_digest: digestBytes(canonicalBytes(checkpointPayload)),
  } as unknown as WorkspaceFreshnessCheckpoint;
  const pending = (input.source_result.status === "published" || input.source_result.status === "equivalent")
    && (input.force_candidate || input.source_result.changed === true);
  return {
    transitions: [],
    seeds: [],
    equivalent: !pending,
    next_freshness_checkpoint: checkpoint,
  };
}

function rustChangedArtifactIds(commits: readonly SourceIndexCommitInput[]): readonly string[] {
  const ids = new Set<string>();
  for (const commit of commits) {
    for (const version of commit.versions) ids.add(version.artifact_id);
    for (const version of commit.version_closures) ids.add(version.artifact_id);
    for (const tombstone of commit.tombstones) ids.add(tombstone.artifact_id);
    for (const tombstone of commit.tombstone_closures) ids.add(tombstone.artifact_id);
  }
  return [...ids].sort();
}

type RustSourceCommit = NonNullable<RustIndexingCoreGenerationPort["commit_source_index"]>;

// Rust's own writer lease (`workspace_lease` in
// crates/urdira-indexing-core/src/lib.rs) now retries within a bounded
// window before giving up (`IndexingCore::open_with_lease_wait`), covering
// the normal case where a foreground source commit races a chunk of the
// chunked lexical maintenance pass. If that bounded wait still runs out, the
// Rust worker reports it as `core:source_index_commit_failed` with this
// exact message; the process transport (`indexing-core-process-transport.ts`
// in `@urdira/plugin-javascript-typescript`) turns every Rust
// `IndexingEvent::Error` into a plain `new Error(\`${code}: ${message}\`)`
// with no usable `.code`, which used to make this reach
// `scanFailureErrorCode` (`packages/daemon/src/runtime.ts`) as the generic,
// terminal `core:workspace_scan_failed` instead of the retryable
// `storage:workspace_writer_busy` path already wired there
// (docs/evidence/2026-09-01-f1-resultado.md). Re-tag it here, at the single
// point every source commit in this module funnels through, so every caller
// gets the retryable code without duplicating this detection.
const RUST_WORKSPACE_WRITER_CONTENDED_MESSAGE = "workspace structural writer is already active";

function withWorkspaceWriterBusyCode(commit: RustSourceCommit): RustSourceCommit {
  return async (input) => {
    try {
      await commit(input);
    } catch (error) {
      if (error instanceof Error && error.message.includes(RUST_WORKSPACE_WRITER_CONTENDED_MESSAGE)) {
        const busyError = new Error(error.message) as Error & { code: string };
        busyError.code = WORKSPACE_WRITER_BUSY_CODE;
        throw busyError;
      }
      throw error;
    }
  };
}

/**
 * Sends a captured source frontier to Rust once, preserving the provider's
 * chained state-revision boundaries. Structural production code calls this
 * before the engine generation; the TypeScript candidate planner is therefore
 * never needed to decide whether source rows are committed or published.
 */
async function commitRustSourceCapture(input: {
  readonly commit: RustSourceCommit;
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly database_path: string;
  readonly commits: readonly SourceIndexCommitInput[];
}): Promise<void> {
  let chunkStart = 0;
  while (chunkStart < input.commits.length) {
    let chunkEnd = chunkStart + 1;
    const first = input.commits[chunkStart] as { readonly expected_state_revision?: number; readonly state?: { readonly state_revision?: number } };
    const expected = first.expected_state_revision;
    const stateRevision = first.state?.state_revision;
    if (expected !== undefined && stateRevision !== undefined) {
      while (chunkEnd < input.commits.length) {
        const next = input.commits[chunkEnd] as { readonly expected_state_revision?: number };
        if (next.expected_state_revision !== expected) break;
        chunkEnd += 1;
      }
    }
    await input.commit({
      operation_id: input.operation_id,
      workspace_id: input.workspace_id,
      database_path: input.database_path,
      commits: input.commits.slice(chunkStart, chunkEnd),
      finalize_state: true,
    });
    chunkStart = chunkEnd;
  }
}

/**
 * Preserve the historical Rust engine input digest without allocating a
 * second `artifactVersions` array in the application. The mapped canonical
 * digest streams each compact version tuple directly from the captured
 * artifact manifest, so the bytes remain identical to
 * `canonicalSha256(artifacts.map(...))` while the owner-sized temporary array
 * disappears from the production path.
 */
function capturedArtifactVersionsDigest(artifacts: readonly WorkspaceScanSourceArtifact[]): string {
  return digestMappedCanonicalArray(artifacts, "rust-source-artifact-versions", (artifact) => ({
    artifact_id: artifact.artifact_id,
    artifact_version_id: artifact.artifact_version_id,
    content_hash: artifact.content_hash,
  }));
}

interface HotCapturedArtifactVersionsDigest {
  readonly generation: number;
  readonly digest: string;
}

// A single `runFullWorkspaceScan` call (`capturedArtifactVersionsDigest`'s
// only caller) reads this digest up to twice for the SAME `scannedArtifacts`
// -- once to build `sourceOperationId`, once as `plugin.analyze`'s
// `source_state_digest` -- and progressive publication re-invokes the whole
// function once per structural stage with the SAME captured generation
// (`preparedScan.source_artifacts`/`sourceIndexResult.generation` are fixed
// for the whole multi-stage scan; only `scannedArtifacts`' array/object
// IDENTITY changes between stages, via `preparedScan.source_artifacts.map
// ((artifact) => ({ ...artifact }))`, not its content). The generation
// number is this workspace's stable content identity for that captured
// frontier -- it only advances when the frontier actually changes -- so
// caching by (workspace id, generation) is safe across both the intra-call
// and the cross-stage repeats, without re-hashing all ~14k+ artifacts each
// time. Bounded the same way as `source-indexer.ts`'s hot Merkle cache, for
// the same long-lived-process reason.
const MAX_HOT_CAPTURED_DIGEST_WORKSPACES = 8;
const hotCapturedArtifactVersionsDigests = new Map<string, HotCapturedArtifactVersionsDigest>();

function capturedArtifactVersionsDigestFor(workspaceId: string, generation: number, artifacts: readonly WorkspaceScanSourceArtifact[]): string {
  const cached = hotCapturedArtifactVersionsDigests.get(workspaceId);
  if (cached !== undefined && cached.generation === generation) return cached.digest;
  const digest = timedSyncEngine("stage_plan_captured_digest", () => capturedArtifactVersionsDigest(artifacts));
  hotCapturedArtifactVersionsDigests.delete(workspaceId);
  hotCapturedArtifactVersionsDigests.set(workspaceId, { generation, digest });
  while (hotCapturedArtifactVersionsDigests.size > MAX_HOT_CAPTURED_DIGEST_WORKSPACES) {
    const oldest = hotCapturedArtifactVersionsDigests.keys().next().value;
    if (oldest === undefined) break;
    hotCapturedArtifactVersionsDigests.delete(oldest);
  }
  return digest;
}

// Default duration budget is sized for full enumeration of large real-world
// repositories (hundreds of files, two stability inventories); 60s proved too
// tight and spuriously tripped `resource_exhausted` mid-enumeration.
const DEFAULT_SCAN_MAX_DURATION_MS = 600_000;
const DEFAULT_SCAN_MAX_RESPONSE_BYTES = 64_000_000;

function providerRequest(options: {
  readonly call: "enumerate" | "read" | "watch";
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly componentId: string;
  readonly componentVersion: string;
  readonly payload: JsonValue;
  readonly budget?: WorkspaceScanBudget;
  readonly now: () => string;
}): SourceProviderRequestEnvelope {
  const maxDurationMs = options.budget?.max_duration_ms ?? DEFAULT_SCAN_MAX_DURATION_MS;
  const maxResponseBytes = options.budget?.max_response_bytes ?? DEFAULT_SCAN_MAX_RESPONSE_BYTES;
  const resourceBudget = JSON.stringify({ max_duration_ms: maxDurationMs, max_response_bytes: maxResponseBytes, max_observations: 1_000_000, max_watch_events: 0 });
  const base = {
    protocol_version: "1" as const,
    request_id: stableId("workspace-scan-request", { call: options.call, payload: options.payload }),
    call: options.call,
    workspace_id: options.workspaceId,
    source_provider_binding_id: options.bindingId,
    component_id: options.componentId,
    component_version: options.componentVersion,
    // The deadline must not undercut the duration budget, or it trips first.
    deadline_at: new Date(Date.parse(options.now()) + maxDurationMs + 60_000).toISOString(),
    cancellation_id: stableId("workspace-scan-cancellation", { call: options.call, payload: options.payload }),
    resource_budget: resourceBudget,
    payload: options.payload,
  };
  return { ...base, request_digest: sourceProviderRequestDigest(base) };
}

function authoritativeWatchResponse(options: {
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly componentId: string;
  readonly componentVersion: string;
  readonly events: readonly WatcherHint[];
  readonly now: () => string;
}): SourceProviderRequestEnvelope & { readonly outcome: "success"; readonly payload: JsonValue } {
  const payload = {
    events: options.events.map((event) => ({
      ordering_domain: options.bindingId,
      event_class: "deleted",
      normalized_uri: event.normalized_uri,
      authority: "authoritative_delete",
      ...(event.provider_sequence === undefined ? {} : { provider_sequence: event.provider_sequence }),
    })),
    watermark: options.events.at(-1)?.provider_sequence ?? `watch:${options.now()}`,
  } as unknown as JsonValue;
  const request = providerRequest({
    call: "watch",
    workspaceId: options.workspaceId,
    bindingId: options.bindingId,
    componentId: options.componentId,
    componentVersion: options.componentVersion,
    payload,
    now: options.now,
  });
  return { ...request, outcome: "success", payload };
}

/**
 * Runs a full, real-filesystem indexing session for one workspace: it
 * catalogs every eligible file under `root` into the durable source frontier
 * and hands the captured generation to the configured structural owner. The
 * production owner is the persistent Rust composition worker, which performs
 * grouping, acceptance, staging, sealing and publication on its SQLite
 * connection. The TypeScript {@link CandidateIndexer} branch below is kept
 * only as an explicit compatibility/oracle path for differential tests.
 */
export async function runFullWorkspaceScan(input: RunFullWorkspaceScanInput): Promise<CandidateRunResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const workspaceId = input.workspace_id;
  const bindingId = input.source_provider_binding_id ?? "provider:filesystem";
  const database = input.database;
  // The daemon resolves the composition transport together with the plugin.
  // Keep the private boundary attached to that provider so the runtime cannot
  // accidentally execute Rust analysis and then fall back to the TypeScript
  // publication writer simply by omitting a second plumbing argument.
  const indexingCore = input.indexing_core ?? input.plugin.indexing_core;
  const rustCore = indexingCore;
  const preparedScan = input.prepared_scan;
  // Wall-clock stage timings, logged to stderr on completion so operators can
  // see where scan time actually goes (analysis vs. sealing vs. storage
  // writes). Stages nest: `publish` spans `plugin_analyze` and `seal`, so its
  // storage-write share is `publish - plugin_analyze - seal`.
  const scanStartedAt = performance.now();
  const throwIfCancelled = (): void => { if (input.signal?.aborted) throw new EngineError("core:operation_cancelled", "Workspace scan generation was superseded."); };
  throwIfCancelled();
  const stageTimings: Record<string, number> = {};
  const debugTiming = process.env["URDIRA_DEBUG_TIMING"] === "1";
  const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try { return await action(); } finally { stageTimings[stage] = Math.round((stageTimings[stage] ?? 0) + (performance.now() - startedAt)); }
  };
  const logStageTimings = (status: string): void => {
    if (!debugTiming) return;
    stageTimings["total"] = Math.round(performance.now() - scanStartedAt);
    console.error(`[urdira] scan timings ${workspaceId} status=${status} ms=${JSON.stringify(stageTimings)}`);
  };

  // Read the workspace's current published tuple *before* this scan's own
  // source cataloging (`GenericSourceIndexer.apply`, below) mutates the
  // stage-1 catalog, then use that published generation to read the stage-1
  // source index's prior known content AS OF that same generation. Per
  // docs/decisions/04-workspace-snapshot-incremental-indexing.md, a
  // reconciliation candidate's frozen base must agree with the workspace's
  // actual current published tuple (`WorkspaceDatabase.publishCandidateSerialized`'s
  // `baseAgrees`/`candidateAgreesWithFrozenBase` checks in
  // `packages/storage/src/storage.ts`), and the planner's diff must be able to
  // see what is already known (`present`/`absent`) to recognize an unchanged
  // or partially changed reconciliation instead of treating every observed
  // file as newly created.
  //
  // This MUST be an "as of `currentState.current_generation`" read
  // (`currentOccurrencesSlimAsOf`/`currentAbsencesSlimAsOf`, below), not the
  // unconditional "currently open-ended" `currentOccurrencesSlim`/
  // `currentAbsencesSlim` (still used, correctly, at the post-catalog read
  // further down): stage-1's `commit` (`GenericSourceIndexer.apply` ->
  // `WorkspaceSourceIndexRepository.commitInternal`) durably lands new
  // `artifact_versions`/`artifact_tombstones` rows on EVERY scan, strictly
  // BEFORE that scan's own stage-2 candidate materialization/seal/publish
  // (below) runs. If a scan dies in between -- crash, OOM, SIGKILL, a native
  // worker-thread fault -- the catalog's latest row for a changed artifact
  // can already reflect content the workspace's last PUBLISHED generation
  // never saw, while `workspace_current_state.current_generation` (read as
  // `currentState`, below) stays behind at the last generation that actually
  // published. Reading the unconditional "latest" view as this scan's PRIOR
  // base would silently treat that never-published mutation as already
  // published: if disk has not changed further, this scan's own fresh
  // observation would then match the already-mutated "prior" state
  // byte-for-byte, the diff would find zero transitions, and the scan would
  // short-circuit as `equivalent` -- leaving the actual published generation
  // (and everything that reads it: `get_source`, `search_text`, ...)
  // permanently stuck on stale content. This was a real, reproduced
  // incident: a bulk `git checkout -- .` reversion landed in the catalog via
  // a scan that crashed between `source_catalog` and `publish`, and the next
  // daemon's startup catch-up scan reported `equivalent` and kept serving
  // the pre-revert content indefinitely. Reading AS OF the actual published
  // generation instead reconstructs exactly what the last successful PUBLISH
  // left published, so a diff against it correctly finds the catalog's
  // unpublished mutation as a real transition and proceeds to publish it.
  //
  // `currentState === undefined` (nothing has EVER published for this
  // workspace, including "a first scan whose own stage-1 landed but whose
  // stage-2 then crashed, and this is the retry") is deliberately NOT treated
  // as "as of generation 0" (which would wrongly empty the base): there is no
  // published generation yet to bound against, and the catalog's already-durable
  // rows -- even ones a crashed earlier attempt left behind -- are not a
  // divergent, never-to-be-published mutation the way they are once
  // something HAS published; they are simply this still-pending first
  // publish's own content so far, carried over unchanged. Diffing against
  // them (via the unconditional `currentOccurrencesSlim`/`currentAbsencesSlim`,
  // exactly as before this fix) correctly finds no transition for a file the
  // crashed attempt already cataloged and this retry's own fresh read still
  // agrees with -- so its ALREADY-DURABLE `artifact_version_id` (stamped
  // under the generation that crashed attempt's stage-1 commit used) rides
  // into this retry's publish unchanged, rather than being re-proposed as a
  // brand-new "created" transition whose freshly-recomputed generation
  // stamp would then conflict with the row's own already-durable one
  // (`storage:publication_conflict`/`storage:candidate_digest_conflict` --
  // confirmed live by `tests/phase-workspace-indexing-session.test.ts`'s
  // "does not wedge a later scan after a crash leaves a publishing-but-uncommitted
  // candidate behind", which regressed under an earlier, unconditional-AS-OF
  // version of this fix that also bounded the `currentState === undefined`
  // case).
  //
  // The planner (`SourceCandidatePlanner.plan`, `source-candidate-planning.ts`)
  // only ever reads a handful of typed columns off these rows, never a
  // decoded artifact/version/tombstone payload, so there is nothing for a
  // fat, canonically-decoded read to buy here -- hence the "Slim" typed-column
  // read (`packages/storage/src/source-index.ts`) rather than `currentOccurrences`/
  // `currentAbsences`.
  const provider = new DirectorySourceProvider({
    root: input.root,
    workspace_id: workspaceId,
    source_provider_binding_id: bindingId,
    ...(input.inclusion_rules === undefined ? {} : { inclusion_rules: input.inclusion_rules }),
    ...(input.gitignore_rules === undefined ? {} : { gitignore_rules: input.gitignore_rules }),
    ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }),
    ...(input.plugin.on_source_text === undefined ? {} : { on_prefetched_text: input.plugin.on_source_text }),
    now,
  });
  const currentState = await timed("prior_state_current", () => database.repositories.snapshots.getCurrent());
  // In the Rust cutover the source provider remains a capture/CAS adapter,
  // while every source row is deferred into this single publication
  // transaction. Legacy callers leave this empty and retain the compatibility
  // writer path used only by tests/oracles.
  const deferredSourceCommits: SourceIndexCommitInput[] = [];
  const rawSourceCommit = indexingCore?.commit_source_index;
  const sourceCommit = rawSourceCommit === undefined ? undefined : withWorkspaceWriterBusyCode(rawSourceCommit);
  const sourceCaptureControl = sourceCommit === undefined ? {} : {
    prepare_content_blobs: async ({ contents, content_streams }: { readonly contents: readonly import("@urdira/storage").SourceIndexContentInput[]; readonly content_streams: readonly import("@urdira/storage").SourceIndexContentStreamInput[] }) => await database.prepareSourceIndexContent({ contents, content_streams }),
    defer_commit: async (commit: SourceIndexCommitInput): Promise<void> => { deferredSourceCommits.push(commit); },
  };
  const authoritativeDeletes = input.authoritative_delete_events ?? [];
  // Apply an authoritative watcher frontier before the scan capture itself.
  // Rust still owns the write, but committing this independent source event
  // first lets the subsequent enumeration plan against the updated frontier;
  // otherwise two deferred commits would both carry the same expected state
  // revision and the structural publication could neither merge nor order
  // them safely.
  const deferredWatchCommits: SourceIndexCommitInput[] = [];
  const watchCaptureControl = sourceCommit === undefined ? {} : {
    prepare_content_blobs: async ({ contents, content_streams }: { readonly contents: readonly import("@urdira/storage").SourceIndexContentInput[]; readonly content_streams: readonly import("@urdira/storage").SourceIndexContentStreamInput[] }) => await database.prepareSourceIndexContent({ contents, content_streams }),
    defer_commit: async (commit: SourceIndexCommitInput): Promise<void> => { deferredWatchCommits.push(commit); },
  };
  const watchResult = authoritativeDeletes.length === 0 ? undefined : await timed("source_watch", () => new GenericSourceIndexer(database).apply({
    response: authoritativeWatchResponse({ workspaceId, bindingId, componentId: provider.component_id, componentVersion: provider.component_version, events: authoritativeDeletes, now }),
    supports_authoritative_delete_events: true,
    publication_current_generation: currentState?.current_generation ?? 0,
    ...watchCaptureControl,
  }));
  if (sourceCommit !== undefined && deferredWatchCommits.length > 0) {
    await sourceCommit({
      operation_id: `source-watch:${workspaceId}:${watchResult?.observation_batch_id ?? "watch"}`,
      workspace_id: workspaceId,
      database_path: database.database.filename,
      commits: deferredWatchCommits,
    });
  }
  // Incremental source capture is safe only when the analyzer lock is the
  // same as the published one. A lock change requires a full source context
  // and full plugin re-analysis even if the tree bytes are unchanged.
  const lockChanged = currentState !== undefined && currentState.current_resolution_lock_id !== input.plugin.resolution_lock.resolution_lock_id;
  if (preparedScan !== undefined) console.error(`[urdira] progressive stage prior-state complete workspace=${workspaceId} stage=${input.publication_stage_id ?? "unknown"}`);
  const currentSnapshot = currentState === undefined ? undefined : await timed("prior_state_snapshot", () => database.repositories.snapshots.get(currentState.current_snapshot_id));
  const priorOccurrences = await timed("prior_state_occurrences", () => currentState === undefined
    ? database.sourceIndex.currentOccurrencesSlim(bindingId)
    : database.sourceIndex.currentOccurrencesSlimAsOf(bindingId, currentState.current_generation));
  const priorAbsences = await timed("prior_state_absences", () => currentState === undefined
    ? database.sourceIndex.currentAbsencesSlim(bindingId)
    : database.sourceIndex.currentAbsencesSlimAsOf(bindingId, currentState.current_generation));
  const priorSourceIndexState = await timed("prior_state_source_state", () => database.sourceIndex.getState());
  // Unlike the prior-state reads above, `base_records`/`base_projections`
  // (`CandidateMaterializer.seal`'s reuse inputs -- see the doc comment where
  // they're now loaded, near `seal` below) are NOT read here: they have
  // exactly one consumer (`seal`), `seal` never runs on an `equivalent`
  // no-op rescan (below), and even when it does run, `seal` only ever needs
  // the subset of currently-visible records/projections owned by this scan's
  // own accepted replacement scopes -- which aren't known until
  // `plugin.analyze` (inside `execute`, below) actually produces them.
  // Loading a workspace's full base-record/base-projection set here,
  // unconditionally, on every scan (as this code used to) meant shipping
  // every one of a workspace's (possibly hundreds of thousands of) visible
  // records across the SQLite-worker `postMessage` boundary even on a scan
  // that turns out to touch nothing.

  let sourceIndexResult: SourceIndexApplyResult;
  let scannedArtifacts: WorkspaceScanSourceArtifact[];
  let observations: SourceCandidateObservationSet;
  let incrementalSourceCapture = preparedScan?.observations.coverage_completeness === "partial";
  if (preparedScan === undefined) {
  const scope = { scope_type: "source_root" as const, source_provider_binding_id: bindingId, source_provider: provider.component_id, normalized_scope_key: "" };
  const watchOnly = watchResult !== undefined && watchResult.status !== "degraded" && (input.changed_uris?.length ?? 0) === 0;
  const incrementalRequested = watchOnly || (input.changed_uris !== undefined && input.changed_uris.length > 0 && currentState !== undefined && !lockChanged);
  const enumeration = await timed("enumerate", async () => { throwIfCancelled(); return provider.enumerateNativeBatches(providerRequest({
    call: "enumerate",
    workspaceId,
    bindingId,
    componentId: provider.component_id,
    componentVersion: provider.component_version,
    payload: { coverage_scopes: [scope] },
    ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }),
    now,
  }), incrementalRequested ? {
    ...(input.changed_uris === undefined ? {} : { changed_uris: input.changed_uris }),
    ...(watchOnly ? { allow_empty_incremental: true } : {}),
  } : undefined); });
  incrementalSourceCapture = enumeration.incremental;
  const enumerateResponse = enumeration.response;
  if (enumerateResponse.outcome !== "success") {
    throw new EngineError("engine:workspace_scan_enumeration_failed", `Directory enumeration for ${input.root} did not succeed (outcome ${enumerateResponse.outcome}).`);
  }
  let enumeratedArtifactCount = 0;
  let completedEnumerationBatch: EncodedObservationBatch | undefined;
  const nativeBatches = (async function* (): AsyncGenerator<EncodedObservationBatch> {
    for await (const batch of enumeration.batches) {
      enumeratedArtifactCount += batch.observations.length;
      if (batch.batch.coverage_completeness === "complete" || enumeration.incremental) completedEnumerationBatch = batch;
      yield batch;
    }
  })();

  const readObservation = async (observation: ProviderObservation) => {
    const response = await provider.read(providerRequest({
      call: "read",
      workspaceId,
      bindingId,
      componentId: provider.component_id,
      componentVersion: provider.component_version,
      payload: {
        artifact_id: observation.artifact_id,
        normalized_uri: observation.normalized_uri,
        observed_content_hash: observation.observed_content_hash,
        observed_metadata_digest: observation.observed_metadata_digest,
        provider_version_token: observation.provider_version_token,
      },
      ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }),
      now,
    }));
    return response;
  };
  const readStream = async (observation: ProviderObservation, options?: { readonly reuse_existing?: boolean }) => provider.readStream({
    artifact_id: observation.artifact_id,
    normalized_uri: observation.normalized_uri,
    observed_content_hash: observation.observed_content_hash,
    observed_metadata_digest: observation.observed_metadata_digest,
    provider_version_token: observation.provider_version_token,
  }, options);

  // `currentState` (`workspace_current_state`, read above -- before this
  // scan's own source cataloging -- as `currentState`/`database.repositories.snapshots.getCurrent()`)
  // is the workspace's PUBLICATION-side generation counter, which is what
  // `GenericSourceIndexer.apply` needs (as `publication_current_generation`)
  // to stamp this scan's `artifact_versions`/`artifact_tombstones` rows with
  // the generation its own publish will actually seal them under -- see the
  // doc comment on `SourceIndexApplyInput.publication_current_generation`
  // and on `applyBatch`'s `generation` computation
  // (`packages/engine/src/source-indexer.ts`) for why the stage-1 source
  // counter alone drifts behind this after a plugin-upgrade generation.
  // `resetEngineTimings`/`snapshotEngineTimings` (`./debug-timing.js`, gated
  // on the same `URDIRA_STORAGE_DEBUG_TIMING=1` flag as `@urdira/storage`'s
  // own timing lines -- see that module's doc comment for why it's a local
  // counterpart rather than an import) attribute wall time INSIDE this
  // `source_catalog` span that isn't inside any of storage's own
  // `commitInternal` buckets: `source_provider_batch_wait` (native-batch
  // iterator wait), `source_batch_digest_verify` (per-batch digest
  // recomputation), `source_prior_frontier` (the two current-occurrence/
  // current-absence queries against the prior source frontier -- skipped on
  // every fragment after the first once `deferredPlannedState` is warm),
  // `source_read_all` (this fragment's whole `readAll`, including its nested
  // per-observation `source_provider_read`), `source_fragment_assemble`
  // (per-fragment row/stream construction), and `source_cas_write` (the
  // Rust-owned capture's `prepare_content_blobs` call, which writes straight
  // to CAS without ever running through `commitInternal`, so it never shows
  // up in storage's own `source_catalog` timing line). The aggregate log
  // line below sums these (excluding the nested `source_provider_read`) and
  // reports what's left of `source_catalog`'s own wall time as
  // `unattributed_ms`, alongside `count()`-tracked observation/CAS volumes.
  if (engineTimingEnabled()) resetEngineTimings();
  try {
    sourceIndexResult = await timed("source_catalog", () => { throwIfCancelled(); return new GenericSourceIndexer(database).apply({ response: enumerateResponse, read: readObservation, read_stream: readStream, native_batches: nativeBatches, allow_partial: enumeration.incremental, publication_current_generation: currentState?.current_generation ?? 0, ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }), ...sourceCaptureControl }); });
  } finally {
    // A completed catalog can still leave unclaimed prefetch entries (every
    // read that took the `reuse_existing` branch); a degraded/thrown one
    // leaves many. Either way the hand-off budget must be returned -- see
    // `DirectorySourceProvider.abortPrefetch`.
    await provider.abortPrefetch();
  }
  if (engineTimingEnabled()) {
    const engineTimings = snapshotEngineTimings();
    // `source_provider_read` is deliberately excluded here: it's the
    // per-observation round-trip already nested inside `source_read_all`'s
    // aggregate, so summing both would double-count it. What's left after
    // subtracting every mutually-exclusive attributed bucket from this
    // stage's own wall time (`stageTimings["source_catalog"]`, set by the
    // `timed("source_catalog", ...)` call above) is genuinely unattributed
    // time inside `GenericSourceIndexer.apply`.
    const attributedMs = (["source_provider_batch_wait", "source_batch_parse", "source_batch_digest_verify", "source_prior_frontier", "source_read_all", "source_fragment_assemble", "source_cas_write"] as const)
      .reduce((total, bucket) => total + (engineTimings[bucket]?.ms ?? 0), 0);
    const unattributedMs = Math.max(0, Math.round((stageTimings["source_catalog"] ?? 0) - attributedMs));
    console.error(`[urdira] engine timings source_catalog workspace:${workspaceId} ms=${JSON.stringify(engineTimings)} unattributed_ms=${unattributedMs} counts=${JSON.stringify(snapshotEngineCounters())}`);
  }
  if (sourceIndexResult.status !== "published" && sourceIndexResult.status !== "equivalent") {
    throw new EngineError("engine:workspace_scan_source_index_degraded", `Source cataloging of ${input.root} did not complete (status ${sourceIndexResult.status}, error ${sourceIndexResult.error_code ?? "none"}).`);
  }
  // This is the first agent-useful readiness boundary. Keep it separate from
  // the later structural publication timing so cold-start regressions cannot
  // be hidden inside the plugin/checker phase.
  stageTimings["source_ready_ms"] = Math.round(performance.now() - scanStartedAt);
  // Keep the source frontier decision visible when a Rust-owned incremental
  // scan is diagnosed.  The Rust publisher derives structural transitions
  // from the committed source rows, so a mismatch between this flag and the
  // deferred commit payload would otherwise look like a silent equivalent
  // rescan at the coordinator boundary.
  stageTimings["source_changed"] = sourceIndexResult.changed === true ? 1 : 0;
  stageTimings["source_deferred_commit_count"] = deferredSourceCommits.length;
  stageTimings["source_deferred_version_count"] = deferredSourceCommits.reduce((total, commit) => total + commit.versions.length, 0);

  const occurrences = indexingCore === undefined || sourceIndexResult.current_occurrences === undefined
    ? await database.sourceIndex.currentOccurrencesSlim(bindingId)
    : sourceIndexResult.current_occurrences;
  const watchAbsences = watchResult?.watch_absences ?? [];
  stageTimings["enumerated_artifact_count"] = enumeratedArtifactCount;
  stageTimings["cataloged_artifact_count"] = occurrences.length;
  if (occurrences.length === 0 && watchAbsences.length === 0) throw new EngineError("engine:workspace_scan_empty", `No eligible source files were found under ${input.root}.`);

  scannedArtifacts = [];
  const nativeContentRefs = input.plugin.supports_native_content_refs === true;
  // Native plugin providers receive only immutable CAS coordinates. This
  // keeps the daemon from building a second workspace-wide byte/text map;
  // the worker re-reads and verifies each blob inside its own process. Legacy
  // in-process providers retain the hydrated text contract for compatibility.
  const capturedContent = indexingCore === undefined ? undefined : new Map(deferredSourceCommits.flatMap((commit) => (commit.content_blobs ?? []).map((value) => [value.content_blob_id, value] as const)));
  const verifiedContent = nativeContentRefs ? undefined : indexingCore !== undefined && deferredSourceCommits.length > 0
    ? new Map(await Promise.all(occurrences.map(async (occurrence) => {
      const content = capturedContent?.get(occurrence.version.content_blob_id);
      if (content === undefined) return [occurrence.artifact.artifact_id, await database.sourceIndex.readVerifiedContentBlobs([{
        artifact_id: occurrence.artifact.artifact_id,
        content_blob_id: occurrence.version.content_blob_id,
        content_hash: occurrence.version.content_hash,
        byte_length: occurrence.version.byte_length,
      }]).then((values) => values.get(occurrence.artifact.artifact_id) as Uint8Array)] as const;
      const bytes = await database.blobs.cas.read(content.content_hash);
      if (bytes.byteLength !== content.byte_length || digestBytes(bytes) !== content.content_hash) throw new EngineError("engine:workspace_scan_stale", `Captured CAS content ${content.content_blob_id} failed verification.`);
      return [occurrence.artifact.artifact_id, bytes] as const;
    })))
    : await database.sourceIndex.readVerifiedContentBlobs(occurrences.map((occurrence) => ({
      artifact_id: occurrence.artifact.artifact_id,
      content_blob_id: occurrence.version.content_blob_id,
      content_hash: occurrence.version.content_hash,
      byte_length: occurrence.version.byte_length,
    })));
  const decoder = nativeContentRefs ? undefined : new TextDecoder("utf-8", { fatal: true });
  const presentObservations: (SourceCandidatePresentObservation | SourceCandidateAbsenceObservation)[] = [];
  for (const occurrence of occurrences) {
    presentObservations.push({
      observed_state: "present",
      source_observation_id: occurrence.version.created_from_observation_id,
      artifact: occurrence.artifact,
      content_blob_id: occurrence.version.content_blob_id,
      content_hash: occurrence.version.content_hash,
      byte_length: occurrence.version.byte_length,
      encoding: occurrence.version.encoding,
      ...(occurrence.version.language_hint === undefined ? {} : { language_hint: occurrence.version.language_hint }),
      analysis_metadata_digest: occurrence.version.analysis_metadata_digest,
    });
    const bytes = verifiedContent?.get(occurrence.artifact.artifact_id);
    if (!nativeContentRefs && bytes === undefined) throw new EngineError("engine:workspace_scan_stale", `CAS omitted ${occurrence.artifact.artifact_id} after source cataloging.`);
    let text: string | undefined;
    if (!nativeContentRefs) {
      try { text = decoder!.decode(bytes!); }
      catch { continue; }
    }
    scannedArtifacts.push({
      path: occurrence.artifact.normalized_path ?? occurrence.artifact.normalized_uri,
      ...(text === undefined ? {} : { text }),
      artifact_id: occurrence.artifact.artifact_id,
      artifact_version_id: occurrence.version.artifact_version_id,
      content_blob_id: occurrence.version.content_blob_id,
      content_hash: occurrence.version.content_hash,
      byte_length: occurrence.version.byte_length,
    });
  }
  for (const absence of watchAbsences) {
    presentObservations.push({
      observed_state: "deleted",
      source_observation_id: absence.source_observation_id,
      artifact_id: absence.artifact_id,
      normalized_uri: absence.normalized_uri,
      authority: "authoritative_delete",
    });
  }
  // `seal` (below) only ever needs these three fields, computed here from
  // data that is already fully known before `plugin.analyze` runs, so that
  // `scannedArtifacts` itself (and the source text each entry carries) can be
  // released once `execute` below no longer needs it, instead of staying
  // reachable through `seal`'s closure for the rest of the candidate run.
  observations = {
    outcome: "success",
    stable: true,
    workspace_id: workspaceId,
    observation_batch_id: watchResult?.observation_batch_id ?? sourceIndexResult.observation_batch_id ?? completedEnumerationBatch?.batch.observation_batch_id ?? "",
    source_provider_binding_id: bindingId,
    source_provider: provider.component_id,
    source_provider_version: provider.component_version,
    watermark: (enumerateResponse.payload as { readonly watermark?: string }).watermark ?? "",
    completed_at: completedEnumerationBatch?.batch.completed_at ?? now(),
    observation_mode: watchAbsences.length > 0 ? "watch" : "scan",
    coverage_completeness: enumeration.incremental ? "partial" : "complete",
    deletion_authority: watchAbsences.length > 0 || !enumeration.incremental ? "authoritative" : "none",
    coverage_scopes: [{ scope_type: "source_root", normalized_scope_key: "" }],
    supports_authoritative_delete_events: watchAbsences.length > 0 || (sourceIndexResult.watch_absences?.length ?? 0) > 0,
    observations: presentObservations,
  };
  } else {
    sourceIndexResult = { status: "equivalent", generation: preparedScan.source_index_generation };
    preparedScan.captured_byte_lease.renew();
    if (input.plugin.supports_native_content_refs === true) {
      // Native providers receive the immutable content hash/CAS reference and
      // verify it in their isolated worker immediately before parsing. Reading,
      // hashing, and UTF-8 decoding the same complete corpus in the host first
      // doubled progressive-stage I/O and retained a second text copy. The
      // source catalog already validated these bytes on capture; the consumer
      // remains the final integrity boundary.
      scannedArtifacts = preparedScan.source_artifacts.map((artifact) => ({ ...artifact }));
      stageTimings["captured_native_refs_ms"] = 0;
    } else {
      if (debugTiming) console.error(`[urdira] captured bytes verify start workspace=${workspaceId} artifacts=${preparedScan.source_artifacts.length}`);
      const capturedVerifyStartedAt = performance.now();
      const verifiedBytes = await preparedScan.captured_byte_lease.verify(database);
      stageTimings["captured_verify_ms"] = Math.round(performance.now() - capturedVerifyStartedAt);
      if (debugTiming) console.error(`[urdira] captured bytes verify complete workspace=${workspaceId} ms=${stageTimings["captured_verify_ms"]}`);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const capturedHydrationStartedAt = performance.now();
      scannedArtifacts = preparedScan.source_artifacts.map((artifact) => {
        const bytes = verifiedBytes.get(artifact.artifact_id);
        if (bytes === undefined) throw new EngineError("engine:workspace_scan_stale", `Captured-byte lease ${preparedScan.captured_byte_lease.lease_id} omitted ${artifact.artifact_id}.`);
        return { ...artifact, text: decoder.decode(bytes) };
      });
      stageTimings["captured_hydration_ms"] = Math.round(performance.now() - capturedHydrationStartedAt);
      if (debugTiming) console.error(`[urdira] captured bytes hydration complete workspace=${workspaceId} ms=${stageTimings["captured_hydration_ms"]}`);
    }
    observations = preparedScan.observations;
    stageTimings["source_ready_ms"] = Math.round(performance.now() - scanStartedAt);
    stageTimings["enumerated_artifact_count"] = scannedArtifacts.length;
    stageTimings["cataloged_artifact_count"] = scannedArtifacts.length;
  }
  const knownArtifactVersions = scannedArtifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_digest: artifact.content_hash }));
  // `present`/`absent` reflect what the workspace already had published
  // before this scan (empty on a genuine first scan). Leaving these empty on
  // every run — the original bug — made `SourceCandidatePlanner` treat every
  // observed file as newly created on every reconciliation, which can never
  // be `equivalent` and also can never detect a real deletion by absence
  // (docs/decisions/04's "Duplicate events and equivalent rescans advance
  // freshness checkpoints without publishing empty generations", and its
  // authoritative-absence contract for full reconciliation).
  const present: SourceCandidateBaseOccurrence[] = priorOccurrences.map((occurrence) => ({ artifact: occurrence.artifact, version: occurrence.version }));
  const absent: SourceCandidateBaseAbsence[] = priorAbsences.map((absence) => ({ artifact: absence.artifact, tombstone: absence.tombstone }));
  const base: SourceCandidateBase = {
    workspace_id: workspaceId,
    state_revision: priorSourceIndexState?.state_revision ?? 0,
    provider_watermarks: priorProviderWatermarks(priorSourceIndexState?.provider_watermarks),
    source_state_digest: currentSnapshot?.source_state_digest ?? stableId("workspace-scan-empty-base", { workspace_id: workspaceId }),
    present,
    absent,
  };

  // `true` exactly when this scan targets a DIFFERENT resolution lock than
  // the workspace's currently published one (a plugin upgrade/downgrade/revert
  // landed since the last publish) -- `undefined` on a genuine first scan,
  // which is neither a lock change nor an unchanged lock, but has no prior
  // lock to compare against at all. A changed lock means a changed
  // analyzer/configuration (docs/decisions/14-plugin-upgrade-relock.md), so
  // both the candidate id (below) and the analysis scope (`changedArtifactIds`,
  // below) must treat it like a first scan: a fresh candidate identity, and
  // full re-analysis, even over an otherwise byte-identical tree.
  // The target lock id is folded into the candidate id's salt alongside the
  // observation batch id: `observation_batch_id` is content-derived and
  // repeats for an identical tree (see the comment on `baseObservationBatchIds`
  // below), so without this, a plugin upgrade published over an unchanged
  // tree would mint the SAME candidate id a prior generation already used --
  // `WorkspaceCandidateRepository.insert`'s identity check would then treat
  // it as the already-published candidate instead of a new generation.
  const candidateId = stableId("workspace-scan-candidate", { workspace_id: workspaceId, observation_batch_id: observations.observation_batch_id, resolution_lock_id: input.plugin.resolution_lock.resolution_lock_id, ...(currentState === undefined ? {} : { base_snapshot_id: currentState.current_snapshot_id }), ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }) });
  // `WorkspaceDatabase.publishCandidateSerialized`'s `baseAgrees` check
  // (`packages/storage/src/storage.ts`) requires a frozen base with a current
  // published tuple to restate that tuple's `source_observation_batch_ids`
  // *exactly* (it is compared for equality against what the current snapshot
  // already has recorded, not diffed or unioned with this scan's own fresh
  // batch — that batch's provenance is carried instead by each transition's
  // `cause_references`). So once a workspace has a current snapshot, this
  // candidate's (and its frozen base's) `source_observation_batch_ids` must
  // restate the current snapshot's own recorded batch ids, not this scan's
  // newly generated one; only a genuine first scan (no current snapshot, so
  // `baseAgrees` does not check this field at all) uses this scan's own batch.
  const baseObservationBatchIds = currentSnapshot === undefined ? [observations.observation_batch_id] : priorObservationBatchIds(currentSnapshot.source_observation_watermarks);
  const candidate: IndexCandidate = {
    candidate_generation_id: candidateId,
    workspace_id: workspaceId,
    ...(currentState === undefined ? {} : {
      base_snapshot_id: currentState.current_snapshot_id,
      base_generation: currentState.current_generation,
      base_registry_snapshot_id: currentState.current_registry_snapshot_id,
      base_configuration_revision_id: currentState.current_configuration_revision_id,
    }),
    target_registry_snapshot_id: input.plugin.registry_snapshot_id,
    target_configuration_revision_id: input.plugin.configuration_revision_id,
    trigger_kind: "full_reconciliation",
    state: "queued",
    source_observation_batch_ids: normalizeObservationBatchIds(baseObservationBatchIds),
    created_at: now(),
    issue_ids: [],
  };
  // `candidateAgreesWithFrozenBase` (packages/storage/src/storage.ts) requires the
  // candidate's own `source_observation_batch_ids` to equal the frozen base's, so
  // both must carry the batch that produced this candidate. It also requires
  // `candidate.base_*` to equal `frozen_base.{snapshot_id,generation,registry_snapshot_id,configuration_revision_id}`
  // exactly (both left absent on a first scan, both set from the same current
  // tuple otherwise), and `baseAgrees` further requires the frozen base to
  // restate the workspace's current `resolution_lock_id` once one exists.
  const frozenBaseCore = {
    ...(currentState === undefined ? {} : {
      snapshot_id: currentState.current_snapshot_id,
      generation: currentState.current_generation,
      registry_snapshot_id: currentState.current_registry_snapshot_id,
      resolution_lock_id: currentState.current_resolution_lock_id,
      configuration_revision_id: currentState.current_configuration_revision_id,
    }),
    source_state_digest: base.source_state_digest,
    source_observation_batch_ids: candidate.source_observation_batch_ids,
  };
  const frozenBase: FrozenCandidateBaseTuple = { ...frozenBaseCore, tuple_digest: frozenCandidateBaseTupleDigest({ ...frozenBaseCore, tuple_digest: "" }) };

  const manifestId = stableId("workspace-scan-manifest", { candidateId });
  const invalidationPlanId = stableId("workspace-scan-invalidation-plan", { candidateId });
  // Rust-owned generations do not consume the TypeScript work manifest: the
  // composition worker derives its own physical groups and publication plan
  // from the captured generation.  Keep a compact, contract-shaped plan for
  // CandidateIndexer (which still requires a CandidatePlan value), but do not
  // retain an O(owners) artifact-work array or digest input in the application
  // process.  The compatibility/oracle route preserves the historical
  // manifest byte-for-byte.
  const rustOwnedPlan = indexingCore !== undefined;
  const manifest: CandidateWorkManifest = {
    work_manifest_id: manifestId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    artifact_work_set: orderedSet(stableId("workspace-scan-artifact-work-set", { candidateId }), "core:artifact_work_item", rustOwnedPlan ? 0 : scannedArtifacts.length, rustOwnedPlan ? [] : scannedArtifacts.map((artifact) => artifact.artifact_version_id)),
    projection_work_set: orderedSet(stableId("workspace-scan-projection-work-set", { candidateId }), "core:projection_work_item", 0, []),
    invalidation_plan_id: invalidationPlanId,
    target_registry_snapshot_id: candidate.target_registry_snapshot_id,
    target_configuration_revision_id: candidate.target_configuration_revision_id,
    created_at: now(),
    work_digest: stableId("workspace-scan-work-digest", { candidateId, ...(rustOwnedPlan ? { owner: "rust-indexing-core" } : { artifacts: scannedArtifacts.map((artifact) => artifact.artifact_version_id) }) }),
  };
  const completeness: CompletenessReport = { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] };
  const invalidationContract: InvalidationPlan = {
    invalidation_plan_id: invalidationPlanId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    seed_change_set: orderedSet(stableId("workspace-scan-seed-change-set", { candidateId }), "core:seed_change", 0, []),
    affected_artifact_set: orderedSet(stableId("workspace-scan-affected-artifact-set", { candidateId }), "core:artifact", rustOwnedPlan ? 0 : scannedArtifacts.length, rustOwnedPlan ? [] : scannedArtifacts.map((artifact) => artifact.artifact_id)),
    affected_record_set: orderedSet(stableId("workspace-scan-affected-record-set", { candidateId }), "core:record", 0, []),
    affected_projection_set: orderedSet(stableId("workspace-scan-affected-projection-set", { candidateId }), "core:projection", 0, []),
    dependency_index_digest: stableId("workspace-scan-dependency-index", { candidateId }),
    maximum_scope: "workspace",
    fallback_scopes: [],
    completeness,
    created_at: now(),
    plan_digest: stableId("workspace-scan-invalidation-plan-digest", { invalidationPlanId }),
  };
  const dag: CandidateExecutionDag = { levels: [], prerequisites: new Map(), dag_digest: stableId("workspace-scan-dag", { candidateId }), work_items: new Map() };
  const plan: CandidatePlan = {
    invalidation: { contract: invalidationContract, seeds: [], affected_artifacts: [], affected_records: [], affected_projections: [], maximum_scope: "workspace" },
    manifest,
    artifact_work_items: [],
    projection_work_items: [],
    lookup_decisions: [],
    dag,
  };

  let analysis: WorkspaceScanAnalysisOutcome | undefined;
  // (3a) Eligible only for a genuine first scan: `currentState === undefined`
  // guarantees `seal`'s `baseRecords`/`globalIdentityRecords`/`absenceBarriers`
  // (below) will all be empty -- the accumulator's own precondition -- without
  // waiting for those DB reads to confirm it, since they're all `[] `
  // literals in that branch already (see `seal`, below). This caller never
  // supplies `record_dependencies`/`lookup_bindings`/`projection_dependencies`
  // to `CandidateMaterializer.seal()`, so `retainEveryProposalId` is always
  // `false` here. `seal()` re-validates every precondition itself before
  // trusting this accumulator's output, so a wrong guess here only costs the
  // optimization, never correctness.
  const continuesInitialProgressivePublication = currentState !== undefined
    && preparedScan?.initial_publication === true
    && input.publication_stage_ordinal !== undefined
    && input.publication_stage_ordinal > 1;
  // Rust-owned structural generations already perform acceptance, materialization,
  // and publication in the composition worker. Do not allocate the TypeScript
  // record-template accumulator on that route; it would retain a second
  // owner-oriented staging surface even though no TypeScript deltas are fed.
  const templateAccumulator = indexingCore === undefined
    && (currentState === undefined || continuesInitialProgressivePublication)
    ? new CandidateRecordTemplateAccumulator(workspaceId, false, { file_backed: scannedArtifacts.length >= 10_000 })
    : undefined;
  // Marks the moment `execute` (below) finishes accepting this scan's
  // analysis output; read back inside `seal` (below), right before the
  // materializer's own `seal()` call, to report `publish_handoff_pre` for
  // the compatibility route. Rust-owned generations keep candidate
  // lifecycle state and structural staging inside the worker boundary.
  let handoffPreStartedAt = 0;
  const stagePlanStartedAt = performance.now();
  // Rust's compact source plan intentionally carries no TypeScript transition
  // array.  A changed source frontier must therefore force the candidate even
  // though `plan.transitions.length === 0`; otherwise CandidateIndexer treats
  // every incremental Rust capture as an equivalent rescan and never invokes
  // the composition worker.  Keep the force restricted to an actual changed
  // source result (or a non-empty deferred commit) so a duplicate watcher
  // observation still takes the cheap equivalent path.
  const deferredSourceChanged = deferredSourceCommits.some((commit) => commit.versions.length > 0
    || commit.tombstones.length > 0
    || commit.version_closures.length > 0
    || commit.tombstone_closures.length > 0);
  const forceCandidate = currentState === undefined || lockChanged || watchResult?.changed === true
    || (watchResult?.watch_absences?.length ?? 0) > 0
    || sourceIndexResult.changed === true
    || deferredSourceChanged
    || (input.publication_stage_ordinal !== undefined && input.publication_stage_ordinal > 1);
  const precomputedRustPlan = indexingCore === undefined ? undefined : rustSourcePlan({
    workspace_id: workspaceId,
    observations,
    base,
    source_result: sourceIndexResult,
    deferred_commits: deferredSourceCommits,
    force_candidate: forceCandidate,
    now: now(),
  });
  // The Rust composition worker is the production owner of candidate
  // planning, acceptance, staging, sealing, and publication.  Do not route
  // this generation through CandidateIndexer merely to obtain a compact
  // compatibility plan: that still constructs a second TypeScript
  // coordination shell and obscures the actual Rust transaction boundary.
  // CandidateIndexer remains below for the TypeScript oracle/compatibility
  // route only.
  if (rustCore !== undefined) {
    const rustPlan = precomputedRustPlan!;
    const sourceOperationId = `source-index:${workspaceId}:${sourceIndexResult.generation}:${capturedArtifactVersionsDigestFor(workspaceId, sourceIndexResult.generation, scannedArtifacts)}`;
    try {
      if (rustPlan.equivalent) {
        if (sourceCommit !== undefined && deferredSourceCommits.length > 0) {
          await timed("stage_plan_commit_rust_source_capture", () => commitRustSourceCapture({
            commit: sourceCommit,
            operation_id: sourceOperationId,
            workspace_id: workspaceId,
            database_path: database.database.filename,
            commits: deferredSourceCommits,
          }));
        }
        templateAccumulator?.dispose();
        stageTimings["stage_plan"] = Math.round(performance.now() - stagePlanStartedAt);
        logStageTimings("equivalent");
        return {
          candidate_generation_id: candidate.candidate_generation_id,
          snapshot_id: currentState?.current_snapshot_id ?? "",
          generation_manifest_id: currentSnapshot?.generation_manifest_id ?? "",
          generation: currentState?.current_generation ?? 0,
          published_at: currentSnapshot?.published_at ?? now(),
          status: "already_published",
          state: "published",
        };
      }
      if (sourceCommit !== undefined && deferredSourceCommits.length > 0) {
        await timed("stage_plan_commit_rust_source_capture", () => commitRustSourceCapture({
          commit: sourceCommit,
          operation_id: sourceOperationId,
          workspace_id: workspaceId,
          database_path: database.database.filename,
          commits: deferredSourceCommits,
        }));
      }
      stageTimings["stage_plan"] = Math.round(performance.now() - stagePlanStartedAt);
      throwIfCancelled();
      const changedArtifactIds = preparedScan === undefined
        ? currentState === undefined || lockChanged ? undefined : rustChangedArtifactIds(deferredSourceCommits)
        : preparedScan.changed_artifact_ids;
      // The Rust worker resolves the complete language frontier from its
      // leased SQLite connection. Passing an empty artifact list here is
      // intentional: no source manifest, owner rows, or templates cross back
      // through the application process.
      const analyzeStartedAt = performance.now();
      analysis = await timed("plugin_analyze", () => input.plugin.analyze({
        workspace_id: workspaceId,
        candidate,
        frozen_base: frozenBase,
        source_state_digest: capturedArtifactVersionsDigestFor(workspaceId, sourceIndexResult.generation, scannedArtifacts),
        source_snapshot_id: `source-snapshot:${sourceIndexResult.generation}`,
        artifacts: [],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(changedArtifactIds === undefined ? {} : { changed_artifact_ids: changedArtifactIds }),
        ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }),
        ...(input.included_publication_stage_ids === undefined ? {} : { included_publication_stage_ids: input.included_publication_stage_ids }),
        indexing_core: rustCore,
      }));
      if (engineTimingEnabled()) stageTimings["execute_non_analyze"] = Math.round(Math.max(0, performance.now() - analyzeStartedAt - (stageTimings["plugin_analyze"] ?? 0)));
      if (analysis.accepted_deltas.length !== 0 || (analysis.native_batches?.length ?? 0) !== 0) {
        throw new EngineError("engine:workspace_scan_exclusive_work", "Rust-owned structural indexing cannot return TypeScript structural deltas or native batches to the application.");
      }
      const publish = analysis.external_publication;
      if (publish === undefined) throw new EngineError("engine:workspace_scan_external_publication_missing", "Rust indexing-core publication callback is missing.");
      if (analysis.on_pre_published !== undefined) await analysis.on_pre_published();
      const publication = await timed("publish", () => publish({
        candidate,
        frozen_base: frozenBase,
        source_transitions: [],
        capability_state_entries: analysis?.capability_state_entries ?? [],
        freshness_checkpoint: rustPlan.next_freshness_checkpoint,
        source_snapshot_id: `source-snapshot:${sourceIndexResult.generation}`,
        publication_kind: input.publication_stage_id === undefined ? "activation" : `structural_stage:${input.publication_stage_id}`,
        publication_stage_id: input.publication_stage_id,
        publication_stage_ordinal: input.publication_stage_ordinal,
        publication_stage_count: input.publication_stage_count,
        source_index_commits: [],
      }));
      if (analysis.on_published !== undefined) await analysis.on_published();
      scannedArtifacts.length = 0;
      stageTimings[input.publication_stage_id === undefined ? "structural_ready_ms" : `structural_stage_${input.publication_stage_ordinal ?? 0}_ready_ms`] = Math.round(performance.now() - scanStartedAt);
      logStageTimings("published");
      return { ...publication, state: "published" };
    } catch (error) {
      await rustCore.cancel().catch(() => undefined);
      throw error;
    }
  }
  const indexer = new CandidateIndexer({ workspace: createWorkspaceCandidatePort(database) });
  const staged = await indexer.stageSourceBatch({
    observations,
    base,
    ...(precomputedRustPlan === undefined ? {} : { precomputed_plan: precomputedRustPlan, rust_owned_lifecycle: true }),
    allow_partial_coverage: incrementalSourceCapture,
    // A target-lock change must publish a new generation even over a
    // byte-identical tree (docs/decisions/09's upgrade clause: an upgrade
    // flows through the normal candidate pipeline). Without this,
    // `stageSourceBatch`'s own `plan.equivalent` short-circuit would never
    // even reach `publish()` for a plugin upgrade scan that touched no
    // files, silently leaving the workspace's records on the OLD analyzer's
    // output forever.
    // Source-first publication can survive a cancelled structural pass. In
    // that state the source planner quite correctly reports an equivalent
    // catalog, but there is still no structural snapshot to return from the
    // ordinary no-op path. Force the first structural candidate so recovery
    // publishes the missing snapshot instead of returning an empty id to the
    // progressive-stage callback.
    force_candidate: forceCandidate,
    trigger: {
      candidate,
      frozen_base: frozenBase,
      buildPlan: () => plan,
      execute: async (executingCandidate) => {
        // `execute_non_analyze`: this whole callback's wall time minus the
        // `plugin_analyze` span it wraps below -- everything else `execute`
        // does (native-batch acceptance, feeding the template accumulator)
        // that would otherwise show up only as unattributed time inside the
        // outer `publish` stage span. `analyzeElapsedMs` is measured
        // separately (immediately around the `plugin_analyze` call, below)
        // rather than read back off `stageTimings["plugin_analyze"]`, since
        // that map only ever accumulates a rounded running total and could
        // already hold time from an earlier progressive-publication stage's
        // own `plugin_analyze` call.
        const executeStartedAt = engineTimingEnabled() ? performance.now() : 0;
        // `staged.plan.transitions` (the planner's actual diff, computed
        // above by `stageSourceBatch`) is the authoritative "what changed
        // this scan" set -- referencing `staged` here, inside a closure
        // built as part of `staged`'s own initializer, is safe: this
        // callback only ever runs later (during `staged.publish()`), by
        // which time `staged` is already a fully assigned binding.
        // `currentState === undefined` (a genuine first scan) intentionally
        // stays `undefined` rather than an artifact id list: a first scan
        // has no prior generation to reuse anything from, so every artifact
        // must be treated as affected. `lockChanged` (above) forces the same
        // `undefined` -- full re-analysis -- for the same reason: a changed
        // resolution lock means a changed analyzer/analysis-configuration,
        // so an unchanged file's records under the OLD analyzer are stale
        // and must not survive via incremental reuse, exactly like a first
        // scan (docs/decisions/14-plugin-upgrade-relock.md).
        // Progressive publication stages share the same candidate base.  The
        // stage ordinal is not an invalidation signal: passing `undefined`
        // here used to make every later stage re-analyse the complete
        // workspace (and re-stage all records) even when only one artifact had
        // changed.  A full pass remains correct for a first scan or a changed
        // analyzer/lock; otherwise the planner's exact transition set is the
        // only work that may be sent to the plugin.
        // This branch is the compatibility/oracle writer and is unreachable
        // once a Rust composition transport is attached (the Rust-owned branch
        // above returns before constructing `CandidateIndexer`). Keep its
        // invalidation input entirely TypeScript-owned so the two routes do
        // not retain a second Rust-shaped planning path.
        const changedArtifactIds = preparedScan === undefined
          ? currentState === undefined || lockChanged ? undefined
            : [...new Set(staged.plan.transitions.map((transition) => transition.artifact_change.artifact_id))]
          : preparedScan.changed_artifact_ids;
        // A successful targeted provider capture contains only concrete,
        // stable changed files, so narrow the expensive plugin input to those
        // paths. If the provider fell back to a complete reconciliation (for
        // example a delete, rename, directory event, or missing path), retain
        // the full plugin corpus: the hint is no longer sufficient to prove
        // the affected closure and correctness is more important than the
        // optimization. The plugin still receives exact changed artifact ids
        // from the source plan as an additional guard.
        const incrementalArtifacts = currentState === undefined || lockChanged || !incrementalSourceCapture || input.changed_uris === undefined
          ? scannedArtifacts
          : (() => {
            const normalizeUri = (uri: string): string => {
              const normalized = uri.replaceAll("\\", "/");
              return normalized.startsWith("./") ? normalized.slice(2) : normalized;
            };
            const changedUris = new Set(input.changed_uris.map(normalizeUri));
            const selected = scannedArtifacts.filter((artifact) => changedUris.has(normalizeUri(artifact.path)));
            stageTimings["changed_uri_count"] = changedUris.size;
            stageTimings["analyzed_artifact_count_before_plugin"] = selected.length;
            return selected;
          })();
        const analysisArtifacts = input.plugin.requires_complete_artifact_manifest === true ? scannedArtifacts : incrementalArtifacts;
        stageTimings["analyzed_artifact_count_before_plugin"] = analysisArtifacts.length;
        const accumulatorFed = templateAccumulator === undefined ? undefined : new Set<string>();
        // Consume compacted deltas immediately on a genuine first scan. The
        // provider can then release each response instead of retaining a
        // corpus-sized accepted_deltas array until sealing.
        const onAcceptedDelta = templateAccumulator === undefined ? undefined : (delta: MaterializationAcceptedFactDelta): void => { templateAccumulator.accept(delta); };
        const analyzeStartedAt = engineTimingEnabled() ? performance.now() : 0;
        analysis = await timed("plugin_analyze", () => input.plugin.analyze({ workspace_id: workspaceId, candidate: executingCandidate, frozen_base: frozenBase, source_state_digest: capturedArtifactVersionsDigestFor(workspaceId, sourceIndexResult.generation, scannedArtifacts), source_snapshot_id: `source-snapshot:${sourceIndexResult.generation}`, candidate_work_manifest: plan.manifest, artifacts: analysisArtifacts, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(changedArtifactIds === undefined ? {} : { changed_artifact_ids: changedArtifactIds }), ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }), ...(input.included_publication_stage_ids === undefined ? {} : { included_publication_stage_ids: input.included_publication_stage_ids }), ...(onAcceptedDelta === undefined ? {} : { on_accepted_delta: onAcceptedDelta }) }));
        const analyzeElapsedMs = engineTimingEnabled() ? performance.now() - analyzeStartedAt : 0;
        // (3a) Feed each delta into the template accumulator as its native
        // batch's own durable write confirms, keyed by `fact_delta_id` (the
        // two lists aren't necessarily co-ordered). This puts the dominant
        // per-record seal cost (`CandidateRecordTemplateAccumulator.accept`'s
        // `recordDigest` calls) on the main thread WHILE the next batch's
        // `acceptNativeFactDeltaBatch` awaits a SQLite worker-thread round
        // trip, instead of leaving it all for one blocking pass at `seal`
        // (below). `matchesAcceptedDeltas` (candidate-materialization.ts) is
        // order-independent, so feeding native-batch deltas before any
        // remaining non-native ones is safe.
        const acceptedDeltasByFactDeltaId = templateAccumulator === undefined ? undefined : new Map(analysis.accepted_deltas.map((delta) => [delta.delta.fact_delta_id, delta] as const));
        for (const native of analysis.native_batches ?? []) {
          // `accept_native_stage_engine_loop` (P3-3c: renamed from
          // `accept_native_stage` -- see that item for the investigation).
          // This loop, and this bucket, is DEAD on the real `apps/urdira`
          // path: `buildJavascriptTypescriptPluginProvider`'s `analyze()`
          // always receives a defined `acceptNativeBatches` callback, so
          // every native batch it produces is diverted into its own
          // `pendingNativeBatches`/`flushNativeBatches` and accepted (via
          // `database.candidates.acceptNativeFactDeltaBatches`, plural)
          // BEFORE `analyze()` even returns -- `analysis.native_batches` sent
          // back to the engine is then always empty, so this loop iterates
          // zero times on every real scan; its `execute_non_analyze` share
          // is therefore, in practice, always ~0 too. It stays here (rather
          // than being deleted) because a plugin provider that does NOT
          // supply an `acceptNativeBatches` callback (or a test double) is
          // still a legal `WorkspaceScanPluginProvider` and DOES reach this
          // loop -- see `accept_native_stage` (below, in `analyze()`'s own
          // implementation, `apps/urdira/src/index.ts`) for the sub-buckets
          // that actually cover the real path's native-batch acceptance and
          // `acceptance.accept()` service cost.
          const nativeAcceptStartedAt = engineTimingEnabled() ? performance.now() : 0;
          await database.candidates.acceptNativeFactDeltaBatch(executingCandidate.candidate_generation_id, native.fact_delta_id, native.batch);
          if (engineTimingEnabled()) recordEngineTiming("accept_native_stage_engine_loop", performance.now() - nativeAcceptStartedAt);
          if (templateAccumulator !== undefined) {
            const delta = acceptedDeltasByFactDeltaId!.get(native.fact_delta_id);
            if (delta !== undefined && !accumulatorFed!.has(native.fact_delta_id)) { templateAccumulator.accept(delta); accumulatorFed!.add(native.fact_delta_id); }
          }
        }
        // Compatibility providers that do not stream still return their
        // accepted deltas and are consumed here. The production provider has
        // already fed the accumulator through `on_accepted_delta`.
        if (templateAccumulator !== undefined && analysis.accepted_deltas.length > 0) {
          timedSyncEngine("template_accumulator_accept", () => {
            for (const delta of analysis!.accepted_deltas) if (!accumulatorFed!.has(delta.delta.fact_delta_id)) templateAccumulator!.accept(delta);
          });
        }
        stageTimings["analyzed_artifact_count"] = analysisArtifacts.length;
        stageTimings["accepted_delta_count"] = templateAccumulator?.acceptedDeltaCount ?? analysis.accepted_deltas.length;
        if (templateAccumulator !== undefined && !templateAccumulator.isDisqualified && templateAccumulator.acceptedDeltaCount > 0) {
          // All production first-scan deltas have been consumed by the
          // accumulator. Its compact metadata is enough for sealing, so the
          // provider response array can release every record graph now.
          (analysis.accepted_deltas as unknown as unknown[]).length = 0;
        }
        // `seal` (below) only reads `knownArtifactVersions`, precomputed
        // above, so nothing past this point needs the scanned source text
        // (or `scannedArtifacts` at all); dropping the array here lets the
        // GC reclaim every file's text instead of it staying reachable for
        // the rest of the candidate run (materialization, publication).
        scannedArtifacts.length = 0;
        if (engineTimingEnabled()) {
          recordEngineTiming("execute_non_analyze", (performance.now() - executeStartedAt) - analyzeElapsedMs);
          handoffPreStartedAt = performance.now();
        }
        return [];
      },
      seal: async ({ candidate: sealedCandidate, plan: sealedPlan }) => {
        if (!analysis) throw new EngineError("engine:workspace_scan_analysis_missing", "Candidate sealing ran before plugin analysis produced a result.");
        const sealedAnalysis = analysis;
        if (sealedAnalysis.rust_promoted_structural_rows === true) {
          // The Rust composition worker has already validated, canonicalized,
          // grouped and staged every structural owner. Do not instantiate the
          // TypeScript materializer or its corpus-sized template arrays on
          // this route. Rust receives the compact source/control metadata in
          // `before_publication`; storage observes its durable journal and
          // returns without rebuilding a publication plan.
          const orderedSet = (element_type: string, entries: readonly unknown[]) => {
            const content_digest = digestCanonicalArray(entries);
            return {
              descriptor_id: `set:${content_digest.slice("sha256:".length)}`,
              element_type,
              element_schema_version: "1",
              comparator_id: "core:lexicographic_uri",
              comparator_version: "1",
              entry_count: entries.length,
              content_digest,
            };
          };
          const materializationCore = {
            workspace_id: sealedCandidate.workspace_id,
            candidate_generation_id: sealedCandidate.candidate_generation_id,
            accepted_fact_delta_digests: [],
            source_transition_template_set: JSON.stringify(orderedSet("core:CandidateSourceTransitionTemplate", staged.plan.transitions)),
            record_open_template_set: JSON.stringify(orderedSet("core:CandidateRecordOpenTemplate", [])),
            record_closure_template_set: JSON.stringify(orderedSet("core:CandidateRecordClosureTemplate", [])),
            identity_assignment_template_set: JSON.stringify(orderedSet("core:CandidateIdentityAssignmentTemplate", [])),
            projection_open_template_sets: [],
            projection_closure_template_sets: [],
            capability_state_entries: sealedAnalysis.capability_state_entries,
            source_observation_watermarks: [],
            artifact_dependency_template_set: JSON.stringify(orderedSet("core:RecordArtifactDependency", [])),
            lookup_dependency_template_set: JSON.stringify(orderedSet("core:PluginLookupInvalidationDependency", [])),
            lookup_revalidation_template_set: JSON.stringify(orderedSet("core:LookupRevalidationTemplate", [])),
          };
          const materializationDigest = digestBytes(canonicalBytes(materializationCore));
          const materialization = {
            ...materializationCore,
            candidate_materialization_id: `materialization:${materializationDigest.slice("sha256:".length)}`,
            materialization_digest: materializationDigest,
          };
          return {
            materialization,
            reused_record_ids: [],
            source_transitions: staged.plan.transitions,
            record_opens: [],
            record_closures: [],
            identity_assignments: [],
            record_dependencies: [],
            lookup_bindings: [],
            lookup_revalidations: [],
            projection_dependencies: [],
            reused_projection_record_ids: [],
            absence_barrier_keys: [],
            record_open_memo: new Map(),
            rust_promoted_structural_rows: true,
          } satisfies SealedCandidateMaterialization;
        }
        // `base_records`/`base_projections`: the workspace's currently-visible
        // records/projections, at the exact generation this scan's frozen
        // base restated above (`currentState.current_generation`, captured
        // before this scan's own source cataloging ran -- the same "old
        // generation" `computeSnapshotDigestFields`,
        // `packages/storage/src/publication-authority.ts`, uses to compute
        // the publish's snapshot record-set digest -- and never re-read as
        // "current" here, since a plugin-upgrade or concurrent scan could
        // have moved that forward by the time `seal` actually runs).
        // Narrowed to the owner artifact ids this scan's own accepted
        // replacement scopes name (`replacementScopeOwnerArtifactIds`,
        // above) -- exactly the rows `CandidateMaterializer.seal`'s own
        // `matchingBaseRecords` filter (`candidate-materialization.ts`)
        // would keep out of the full set, so this changes nothing about
        // what `seal` produces, only how much gets read to produce it (see
        // that function's doc comment for why no other seal-time consumer
        // needs an id outside this set on the production scan path). Feeding
        // these into `seal` lets its existing reuse branch
        // (`recordTemplates`/`projectionTemplates`,
        // `packages/engine/src/candidate-materialization.ts`) keep any
        // record or projection whose desired content digest is unchanged out
        // of this publish's opens/closures entirely -- so an unchanged
        // file's records are neither closed nor reopened, only its
        // actually-changed records are. On a genuine first scan (no current
        // generation yet) there is nothing to reuse, so both stay empty.
        const streamedFastPath = sealedAnalysis.accepted_deltas.length === 0 ? templateAccumulator?.fastPathMetadata : undefined;
        const ownerArtifactIds = streamedFastPath?.owner_artifact_ids ?? replacementScopeOwnerArtifactIds(sealedAnalysis.accepted_deltas);
        // Avoid a project-sized flattening allocation while accepted deltas
        // remain live for candidate sealing.
        const replacementScopes: ReplacementScope[] = streamedFastPath === undefined ? [] : [...streamedFastPath.replacement_scopes];
        if (streamedFastPath === undefined) for (const delta of sealedAnalysis.accepted_deltas) for (const set of delta.replacement_sets) replacementScopes.push(set.scope);
        const baseRecords = currentState === undefined ? [] : await timed("prior_state_base_records", () => input.publication_stage_ordinal === undefined || input.publication_stage_ordinal === 1
          ? database.repositories.canonicalOccurrences.currentlyVisibleForOwners(currentState.current_generation, ownerArtifactIds)
          : database.repositories.canonicalOccurrences.currentlyVisibleForReplacementScopes(currentState.current_generation, replacementScopes));
        const baseProjections = currentState === undefined ? [] : await timed("prior_state_base_projections", () => database.projectionOccurrences.currentlyVisibleForOwnersSlim(currentState.current_generation, ownerArtifactIds));
        // A first publication has no prior identity or absence authority to
        // query. Building this project-wide map anyway retained one entry per
        // record at exactly the point where all accepted deltas were already
        // live; VS Code exhausted V8 growing this unused Map before seal.
        // Incremental scans still build the exact same deduplicated key set.
        const identityKeys = currentState === undefined || continuesInitialProgressivePublication ? [] : (() => {
          const identityKeyMap = new Map<string, { readonly identity_type: "entity" | "relation" | "diagnostic"; readonly identity_key: string }>();
          for (const delta of sealedAnalysis.accepted_deltas) for (const set of delta.replacement_sets) for (const record of set.records) {
            if (record.category !== "entity" && record.category !== "relation" && record.category !== "diagnostic") continue;
            identityKeyMap.set(`${record.category}\0${record.identity_key}`, { identity_type: record.category, identity_key: record.identity_key });
          }
          return [...identityKeyMap.values()];
        })();
        // Exact identity lookup also includes the affected owners. One
        // content-derived record may carry multiple identity assignments;
        // the owner-scoped base-record read intentionally returns each
        // physical record only once and therefore cannot represent every
        // alias by itself. Keeping all requested exact aliases here prevents
        // a later scan from mistaking an already-open record for a new open.
        // The lookup remains bounded by the identities proposed by this
        // candidate and uses the exact digest/key index; first scans still
        // skip it because they have no current state.
        const globalIdentityRecords = currentState === undefined || identityKeys.length === 0 ? [] : await timed("prior_state_identity_records", () => database.repositories.canonicalOccurrences.currentlyVisibleForIdentityKeys(currentState.current_generation, identityKeys));
        // Closed identities for the same owner scope, as of the same frozen
        // base generation: the production source of `absence_barriers`
        // (`CanonicalOccurrenceRepository.closedIdentitiesForOwners`,
        // `packages/storage/src/repositories.ts`). Without this, a record
        // whose identity was closed in an earlier generation (its owning
        // file deleted) is invisible to `baseByKey` in `recordTemplates`
        // (`candidate-materialization.ts`) -- so a later scan that
        // re-proposes byte-identical content under that same identity_key
        // gets no chain-salt at all, and its pure-content-digest record_id
        // exactly re-mints the closed history row's id, which
        // `assertPublicationImmutableRows` (`publication-authority.ts`)
        // then rejects as a payload/generation mismatch against that closed
        // row (`storage:publication_conflict`) on every subsequent scan
        // (the classic delete-then-restore-identical-content wedge). On a
        // genuine first scan there is no prior generation to have closed
        // anything, so this stays empty like `baseRecords`/`baseProjections`.
        const scopedAbsenceBarriers = currentState === undefined || continuesInitialProgressivePublication ? [] : await timed("prior_state_scoped_absence", () => database.repositories.canonicalOccurrences.closedIdentitiesForOwners(currentState.current_generation, ownerArtifactIds));
        const globalAbsenceBarriers = currentState === undefined || continuesInitialProgressivePublication || identityKeys.length === 0 ? [] : await timed("prior_state_global_absence", () => database.repositories.canonicalOccurrences.closedIdentitiesForIdentityKeys(currentState.current_generation, identityKeys));
        const absenceBarriers = [...new Map([...scopedAbsenceBarriers, ...globalAbsenceBarriers].map((entry) => [`${entry.identity_type}\0${entry.identity_key}`, entry])).values()];
        // (3a) `templateAccumulator` (constructed only when `currentState ===
        // undefined`) was fed every accepted delta above, during `execute`.
        // `seal()` independently re-checks its own eligibility -- matching
        // accepted deltas, no base/global-identity/absence-barrier authority
        // -- before trusting it, so it's passed through unconditionally here.
        if (engineTimingEnabled()) recordEngineTiming("publish_handoff_pre", performance.now() - handoffPreStartedAt);
        // The two corpus-scale ordered-set digests go to worker threads
        // (`MaterializationDigestOffload`) while the main thread computes the
        // rest of the seal; `sealAsync` falls back to the identical
        // synchronous digests on any worker trouble, and the workers are
        // torn down the moment the seal returns (publication reuses the
        // seeded digest memos, not the workers).
        const digestOffload = MaterializationDigestOffload.create();
        return timed("seal", async () => {
          try {
            return await new CandidateMaterializer().sealAsync({
          candidate: sealedCandidate,
          manifest: sealedPlan.manifest,
          source_plan: staged.plan,
              accepted_deltas: sealedAnalysis.accepted_deltas,
              ...(sealedAnalysis.rust_promoted_structural_rows === true ? { rust_promoted_structural_rows: true } : {}),
          accepted_projection_sets: [],
          base_records: baseRecords,
          global_identity_records: globalIdentityRecords,
          base_projections: baseProjections,
          absence_barriers: absenceBarriers,
          capability_state_entries: sealedAnalysis.capability_state_entries,
          source_observation_watermarks: [],
          created_at: now(),
              known_artifact_versions: knownArtifactVersions,
              known_dependency_roles: input.plugin.dependency_roles,
              known_lookup_dependencies: [],
            }, templateAccumulator, digestOffload);
          } finally {
            digestOffload?.close();
            // P4 (seal/publish-window RSS): the accepted deltas have no
            // reader after seal -- publication consumes the sealed template
            // sets, and durable recovery rehydrates confirmed FactDelta
            // batches from storage -- yet each delta held the ONLY second
            // reference to its record's `canonical_record` string (the first
            // lives on via the open template's `record_without_validity`).
            // Truncating here, mirroring `scannedArtifacts.length = 0` below,
            // halves the corpus-string root count for the whole publish
            // window. The array is the app-built mutable array `analyze()`
            // returned; the readonly cast is only the engine-facing type.
            (sealedAnalysis.accepted_deltas as unknown as unknown[]).length = 0;
          }
        });
      },
      publication: ({ candidate: publishingCandidate, frozen_base: publishingFrozenBase, materialization, template_sets }): CandidatePublicationInput => timedSyncEngine("publication_input_build", () => ({
        // These two fields must mirror the patch already applied by CandidateIndexer's
        // "projecting" -> "ready" transition (which rewrites the persisted candidate
        // payload), or storage's immutable-identity check rejects the publication.
        candidate: { ...publishingCandidate, candidate_materialization_id: materialization.candidate_materialization_id, candidate_digest: materialization.materialization_digest },
        frozen_base: publishingFrozenBase,
        materialization,
        template_sets,
        target_registry: input.plugin.registry as unknown as RegistrySnapshot,
        target_resolution_lock: input.plugin.resolution_lock as unknown as PluginResolutionLock,
        target_configuration: input.plugin.configuration,
        freshness_checkpoint: staged.plan.next_freshness_checkpoint,
        publication_kind: input.publication_stage_id === undefined ? "activation" : `structural_stage:${input.publication_stage_id}`,
        source_snapshot_id: `source-snapshot:${sourceIndexResult.generation}`,
        ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id, publication_stage_ordinal: input.publication_stage_ordinal, publication_stage_count: input.publication_stage_count }),
      })),
      // Resolve the analysis hook lazily: `analysis` is populated by
      // `execute` after this trigger object is constructed. This keeps the
      // hook available for Rust cutover without eagerly copying a callback
      // from an as-yet-unassigned analysis result.
      before_publication: async (context): Promise<void> => { if (context.publication !== undefined) await analysis?.before_publication?.({ publication: context.publication }); },
    } satisfies Omit<CandidateRunTrigger, "source_plan">,
  });
  if (preparedScan !== undefined) console.error(`[urdira] progressive stage plan complete workspace=${workspaceId} stage=${input.publication_stage_id ?? "unknown"}`);
  stageTimings["stage_plan"] = Math.round(performance.now() - stagePlanStartedAt);
  if (staged.status === "degraded") throw new EngineError("engine:workspace_scan_candidate_degraded", "The candidate source plan could not be staged from a stable, complete observation.");
  const needsPreparedScanForPartialResume = staged.status === "equivalent"
    && currentSnapshot?.publication_stage_ordinal !== undefined
    && currentSnapshot.publication_stage_count !== undefined
    && currentSnapshot.publication_stage_ordinal < currentSnapshot.publication_stage_count;
  if (preparedScan === undefined && input.on_prepared_scan !== undefined
    && (staged.status !== "equivalent" || needsPreparedScanForPartialResume)) {
    const metadata = scannedArtifacts.map(({ text: _text, ...artifact }) => artifact);
    const changedArtifactIds = currentState === undefined || lockChanged
      ? undefined
      : indexingCore !== undefined ? rustChangedArtifactIds(deferredSourceCommits)
        : [...new Set(staged.plan.transitions.map((transition) => transition.artifact_change.artifact_id))];
    await input.on_prepared_scan({
      source_artifacts: metadata,
      observations,
      source_index_generation: sourceIndexResult.generation,
      captured_byte_lease: capturedByteLease(workspaceId, sourceIndexResult.generation, metadata),
      changed_artifact_ids: changedArtifactIds,
      initial_publication: currentState === undefined,
    });
  }

  // A stable, complete reconciliation that produced no transitions against
  // `base` (now populated from the workspace's actual prior state, above) is
  // a genuine no-op rescan: per docs/decisions/04's "Duplicate events and
  // equivalent rescans advance freshness checkpoints without publishing empty
  // generations", this settles back on the current published generation
  // instead of publishing an empty one (and, unlike a real publish, never
  // reaches `CandidateIndexer.run`/`candidates.insert`, so it cannot collide
  // with a prior candidate that happens to share this scan's — content-derived,
  // and therefore possibly repeated — observation batch id).
  if (staged.status === "equivalent") {
    if (sourceCommit !== undefined && deferredSourceCommits.length > 0) {
      await sourceCommit({
        // Observation batch ids can be reused by watcher coalescing. Include
        // the captured source frontier so a real incremental source commit
        // cannot be mistaken for an idempotent replay of the prior generation.
        operation_id: `source-index:${workspaceId}:${sourceIndexResult.generation}:${capturedArtifactVersionsDigestFor(workspaceId, sourceIndexResult.generation, scannedArtifacts)}`,
        workspace_id: workspaceId,
        database_path: database.database.filename,
        commits: deferredSourceCommits,
      });
    }
    templateAccumulator?.dispose();
    logStageTimings("equivalent");
    return {
      candidate_generation_id: candidate.candidate_generation_id,
      snapshot_id: currentState?.current_snapshot_id ?? "",
      generation_manifest_id: currentSnapshot?.generation_manifest_id ?? "",
      generation: currentState?.current_generation ?? 0,
      published_at: currentSnapshot?.published_at ?? now(),
      status: "already_published",
      state: "published",
    };
  }

  if (input.publication_stage_id !== undefined) console.error(`[urdira] progressive stage publish start workspace=${workspaceId} stage=${input.publication_stage_id}`);
  throwIfCancelled();
  // Same `resetEngineTimings`/`snapshotEngineTimings` pattern used around
  // `source_catalog` above, mirrored here for `publish`: attributes wall
  // time inside `staged.publish()` (`CandidateIndexer.run`,
  // `candidate-indexer.ts`) that isn't inside `plugin_analyze`/`seal`
  // (themselves timed above, inside the `execute`/`seal` trigger callbacks)
  // or storage's own `publish_plan_build`/`publish_sql_transaction`/etc.
  // (`@urdira/storage`'s own timing line) -- specifically the handoff spans
  // either side of sealing (`publish_handoff_pre`/`publish_handoff_post`)
  // and the storage writer's queueing (`publish_writer_queue_wait`, logged
  // on storage's own line but sharing this same wall-clock window).
  if (engineTimingEnabled()) resetEngineTimings();
  let result!: Awaited<ReturnType<typeof staged.publish>>;
  try {
    if (analysis?.on_pre_published !== undefined) await analysis.on_pre_published();
    result = await timed("publish", () => { throwIfCancelled(); return staged.publish(); });
    if (analysis?.on_published !== undefined) await analysis.on_published();
  } catch (error) {
    if (indexingCore !== undefined) await indexingCore.cancel().catch(() => undefined);
    throw error;
  } finally {
    templateAccumulator?.dispose();
  }
  if (engineTimingEnabled()) console.error(`[urdira] engine timings publish workspace:${workspaceId} ms=${JSON.stringify(snapshotEngineTimings())}`);
  if (input.publication_stage_id !== undefined) console.error(`[urdira] progressive stage publish complete workspace=${workspaceId} stage=${input.publication_stage_id}`);
  if (!("state" in result)) throw new EngineError("engine:workspace_scan_no_changes", `No candidate changes were staged for workspace ${workspaceId}; nothing was published.`);
  stageTimings[input.publication_stage_id === undefined ? "structural_ready_ms" : `structural_stage_${input.publication_stage_ordinal ?? 0}_ready_ms`] = Math.round(performance.now() - scanStartedAt);
  logStageTimings(result.status);
  return result;
}

/**
 * Publishes an ordered structural stage sequence when the active registry
 * declares one. Each stage is a normal immutable candidate publication, so a
 * crash or source change can expose only the last completed stage. Providers
 * without declarations retain the historical single-publication behavior.
 */
export async function runProgressiveWorkspaceScan(input: RunFullWorkspaceScanInput): Promise<CandidateRunResult> {
  if (input.plugin.supports_progressive_publication !== true) return runFullWorkspaceScan(input);
  const stages = input.plugin.registry.contributions
    .flatMap((contribution) => contribution.structural_stage_definitions ?? [])
    .map((stage) => stage as unknown as PluginStructuralStageDeclaration)
    .sort((left, right) => left.ordinal - right.ordinal || left.stage_id.localeCompare(right.stage_id));
  if (stages.length === 0) return runFullWorkspaceScan(input);
  const firstStage = stages[0]!;
  const initialStageGroups = (input.plugin.initial_publication_stage_groups ?? []).map((declaration) => {
    const grouped = declaration.stage_ids.map((stageId) => stages.find((stage) => stage.stage_id === stageId));
    if (grouped.length < 2 || grouped.some((stage) => stage === undefined)) throw new TypeError("An initial publication stage group must name at least two declared stages.");
    const defined = grouped as PluginStructuralStageDeclaration[];
    const firstIndex = stages.indexOf(defined[0]!);
    if (firstIndex <= 0 || defined.some((stage, index) => stages[firstIndex + index]?.stage_id !== stage.stage_id)) throw new TypeError("An initial publication stage group must be contiguous and follow an independently published predecessor.");
    return Object.freeze({ stages: Object.freeze(defined), first_index: firstIndex, final_stage_id: defined.at(-1)!.stage_id });
  });
  const groupedStageIds = new Set<string>();
  for (const group of initialStageGroups) for (const stage of group.stages) {
    if (groupedStageIds.has(stage.stage_id)) throw new TypeError("Initial publication stage groups cannot overlap.");
    groupedStageIds.add(stage.stage_id);
  }
  const stageSequenceDigest = progressiveStageSequenceDigest(stages);
  const checkpointCoordinates = (sourceSnapshotId: string): Omit<ProgressiveChangedArtifactCheckpoint, "analysis_scope" | "changed_artifact_ids" | "initial_publication"> => ({
    workspace_id: input.workspace_id,
    source_snapshot_id: sourceSnapshotId,
    registry_snapshot_id: input.plugin.registry_snapshot_id,
    resolution_lock_id: input.plugin.resolution_lock.resolution_lock_id,
    configuration_revision_id: input.plugin.configuration_revision_id,
    stage_sequence_digest: stageSequenceDigest,
    first_stage_id: firstStage.stage_id,
    first_stage_ordinal: firstStage.ordinal,
    stage_count: stages.length,
  });

  // A partially published structural generation is the only state that may
  // resume from a previous process. Its source work set must come from the
  // immutable checkpoint written before stage 1 was made visible; deriving
  // it from the now-current stage-1 snapshot would incorrectly produce an
  // empty diff and let later stages claim empty capabilities as complete.
  let recoveredCheckpoint: ProgressiveChangedArtifactCheckpoint | undefined;
  const currentState = await input.database.repositories.snapshots.getCurrent();
  const currentSnapshot = currentState === undefined ? undefined : await input.database.repositories.snapshots.get(currentState.current_snapshot_id);
  const startingStageOrdinal = currentSnapshot?.publication_stage_ordinal ?? 0;
  const currentStage = currentSnapshot?.publication_stage_ordinal === undefined
    ? undefined
    : stages.find((stage) => stage.ordinal === currentSnapshot.publication_stage_ordinal);
  const resumablePartialSnapshot = currentSnapshot?.source_snapshot_id !== undefined
    && currentSnapshot.publication_stage_ordinal !== undefined
    && currentSnapshot.publication_stage_ordinal >= firstStage.ordinal
    && currentSnapshot.publication_stage_ordinal < stages.length
    && currentSnapshot.publication_stage_count === stages.length
    && currentStage?.stage_id === currentSnapshot.publication_stage_id
    && currentSnapshot.registry_snapshot_id === input.plugin.registry_snapshot_id
    && currentSnapshot.resolution_lock_id === input.plugin.resolution_lock.resolution_lock_id
    && currentSnapshot.configuration_revision_id === input.plugin.configuration_revision_id;
  if (resumablePartialSnapshot) {
    const expected = checkpointCoordinates(currentSnapshot.source_snapshot_id!);
    const checkpointKey = progressiveChangedArtifactCheckpointKey(expected);
    const stored = await input.database.repositories.controlPlane.get<unknown>(checkpointKey);
    if (!isProgressiveChangedArtifactCheckpoint(stored, expected)) {
      throw new EngineError(
        "engine:workspace_scan_stale",
        `Structural snapshot ${currentSnapshot.snapshot_id} cannot resume without its validated changed-artifact checkpoint.`,
      );
    }
    recoveredCheckpoint = stored;
  }

  let result: CandidateRunResult | undefined;
  let preparedScan: PreparedWorkspaceScan | undefined = input.prepared_scan;
  const retainPreparedScan = async (scan: PreparedWorkspaceScan, notify: boolean): Promise<void> => {
    const sourceSnapshotId = `source-snapshot:${scan.source_index_generation}`;
    const recoveredChangedArtifactIds = recoveredCheckpoint?.source_snapshot_id === sourceSnapshotId
      ? recoveredCheckpoint.analysis_scope === "full" ? undefined : recoveredCheckpoint.changed_artifact_ids
      : scan.changed_artifact_ids;
    const initialPublication = recoveredCheckpoint?.source_snapshot_id === sourceSnapshotId
      ? recoveredCheckpoint.initial_publication
      : scan.initial_publication;
    const effectiveScan: PreparedWorkspaceScan = {
      ...scan,
      changed_artifact_ids: recoveredChangedArtifactIds,
      initial_publication: initialPublication,
    };
    if (effectiveScan.changed_artifact_ids !== undefined && effectiveScan.changed_artifact_ids.length === 0) {
      throw new EngineError(
        "engine:workspace_scan_stale",
        `Progressive source snapshot ${sourceSnapshotId} has no changed artifacts to publish.`,
      );
    }
    const checkpoint = makeProgressiveChangedArtifactCheckpoint({
      workspace_id: input.workspace_id,
      source_snapshot_id: sourceSnapshotId,
      registry_snapshot_id: input.plugin.registry_snapshot_id,
      resolution_lock_id: input.plugin.resolution_lock.resolution_lock_id,
      configuration_revision_id: input.plugin.configuration_revision_id,
      stages,
      changed_artifact_ids: effectiveScan.changed_artifact_ids,
      initial_publication: effectiveScan.initial_publication,
    });
    await input.database.repositories.controlPlane.put(
      "progressive_changed_artifact_checkpoint",
      progressiveChangedArtifactCheckpointKey(checkpoint),
      checkpoint,
    );
    preparedScan = effectiveScan;
    if (notify) await input.on_prepared_scan?.(effectiveScan);
  };
  try {
  if (preparedScan !== undefined) await retainPreparedScan(preparedScan, false);
  for (const [index, stage] of stages.entries()) {
    if (input.signal?.aborted) throw new EngineError("core:operation_cancelled", `Structural scan generation for ${input.workspace_id} was superseded before stage ${stage.stage_id}.`);
    const initialGroup = preparedScan?.initial_publication === true
      ? initialStageGroups.find((group) => group.stages.some((entry) => entry.stage_id === stage.stage_id) && startingStageOrdinal < group.stages[0]!.ordinal)
      : undefined;
    if (initialGroup !== undefined && stage.stage_id !== initialGroup.final_stage_id) {
      console.error(`[urdira] progressive initial accumulation workspace=${input.workspace_id} stage=${stage.stage_id} into=${initialGroup.final_stage_id}`);
      continue;
    }
    console.error(`[urdira] progressive stage start workspace=${input.workspace_id} stage=${stage.stage_id} ordinal=${stage.ordinal}`);
    if (result?.status === "already_published") {
      const publishedSnapshot = await input.database.repositories.snapshots.get(result.snapshot_id);
      // Recovery first replays stage 1 as an equivalent source scan solely
      // to acquire a fresh bounded byte lease. If the durable current
      // snapshot had already reached a later stage, skip that already-visible
      // stage rather than attempting to republish it.
      if (publishedSnapshot?.publication_stage_ordinal !== undefined
        && publishedSnapshot.publication_stage_ordinal >= stage.ordinal) continue;
    }
    if (index > 0 && result !== undefined) {
      // A later stage is valid only as the direct successor of the snapshot
      // just published.  This closes the race where a watcher publishes a
      // newer source/configuration generation while the prepared analysis is
      // still running: never append stage 2/3 to an unrelated predecessor.
      const current = await input.database.repositories.snapshots.getCurrent();
      const predecessor = await input.database.repositories.snapshots.get(result.snapshot_id);
      const expectedPredecessor = initialGroup === undefined ? stages[index - 1] : stages[initialGroup.first_index - 1];
      if (current?.current_snapshot_id !== result.snapshot_id
        || predecessor?.publication_stage_id !== expectedPredecessor?.stage_id
        || predecessor?.publication_stage_ordinal !== expectedPredecessor?.ordinal
        || predecessor?.source_snapshot_id !== `source-snapshot:${preparedScan?.source_index_generation ?? predecessor?.generation}`
        || predecessor?.registry_snapshot_id !== input.plugin.registry_snapshot_id
        || predecessor?.resolution_lock_id !== input.plugin.resolution_lock.resolution_lock_id
        || predecessor?.configuration_revision_id !== input.plugin.configuration_revision_id) {
        throw new EngineError("engine:workspace_scan_stale", `Structural stage ${stage.stage_id} was superseded before publication.`);
      }
    }
    result = await runFullWorkspaceScan({
      ...input,
      publication_stage_id: stage.stage_id,
      publication_stage_ordinal: stage.ordinal,
      publication_stage_count: stage.stage_count,
      ...(initialGroup === undefined ? {} : { included_publication_stage_ids: initialGroup.stages.map((entry) => entry.stage_id) }),
      ...(preparedScan === undefined ? {} : { prepared_scan: preparedScan }),
      ...(index === 0 && preparedScan === undefined ? { on_prepared_scan: (scan: PreparedWorkspaceScan) => retainPreparedScan(scan, true) } : {}),
    });
    await input.on_stage_published?.(stage, result);
    // The expanded agent benchmark measures the source-first structural
    // readiness boundary. Keep later stages available in normal runtime, but
    // allow that benchmark control to stop after the first atomic publication
    // instead of retaining a second whole-project result graph while the
    // agent is already working against the published stage.
    // Readiness is an observation boundary, not a scan cancellation request.
    // Source-ready consumers may start immediately while later structural
    // stages continue in this same background generation.
    if (result.status === "already_published") {
      const currentSnapshot = await input.database.repositories.snapshots.get(result.snapshot_id);
      // An equivalent source rescan can legitimately return the already
      // complete structural snapshot. Do not try to append stage 2/3 to that
      // final snapshot; there is no new source context to analyze.
      if (currentSnapshot?.publication_stage_ordinal === undefined
        || currentSnapshot.publication_stage_ordinal >= stage.stage_count) return result;
    }
  }
  if (result === undefined) throw new EngineError("engine:workspace_scan_no_stages", "Progressive publication declared no executable stages.");
  return result;
  } finally {
    preparedScan?.captured_byte_lease.release();
  }
}
