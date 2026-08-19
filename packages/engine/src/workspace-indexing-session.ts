import { canonicalBytes, digestBytes } from "@urdira/canonical";
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
  SnapshotCapabilityStateEntry,
  SourceProviderRequestEnvelope,
  WorkspaceConfigurationRevision,
} from "@urdira/contracts";
import type { AssembledPluginRegistry, SdkPluginResolutionLock } from "@urdira/plugin-sdk";
import type { CandidatePublicationInput, WorkspaceDatabase } from "@urdira/storage";
import { frozenCandidateBaseTupleDigest, normalizeObservationBatchIds } from "@urdira/storage";
import type { GitIgnoreRules, InclusionRules } from "@urdira/security";
import {
  CandidateIndexer,
  type CandidateRunResult,
  type CandidateRunTrigger,
} from "./candidate-indexer.js";
import type { CandidateExecutionDag, CandidatePlan, FrozenCandidateBaseTuple } from "./candidate-planning.js";
import { CandidateMaterializer } from "./candidate-materialization.js";
import {
  DirectorySourceProvider,
  type EncodedObservationBatch,
  type ProviderObservation,
} from "./directory-provider.js";
import { EngineError } from "./errors.js";
import type { AcceptedFactDelta } from "./fact-delta.js";
import { GenericSourceIndexer, type SourceIndexApplyResult } from "./source-indexer.js";
import { sourceProviderRequestDigest } from "./source-provider.js";
import type { SourceCandidateBase, SourceCandidateBaseAbsence, SourceCandidateBaseOccurrence, SourceCandidateObservationSet, SourceCandidatePresentObservation } from "./source-candidate-planning.js";
import { createWorkspaceCandidatePort } from "./workspace-indexing-port.js";

/**
 * A single cataloged source file, ready to hand to a language plugin for analysis.
 * `text` is the exact UTF-8 content that stage 1 (source cataloging) durably
 * committed for this artifact version, so plugin analysis always operates on
 * the same bytes that are now visible in the workspace's source index.
 */
export interface WorkspaceScanSourceArtifact {
  readonly path: string;
  readonly text: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_blob_id: string;
  readonly content_hash: string;
  readonly byte_length: number;
}

export interface WorkspaceScanAnalysisOutcome {
  readonly accepted_deltas: readonly AcceptedFactDelta[];
  readonly capability_state_entries: readonly SnapshotCapabilityStateEntry[];
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
  /** Providers opt into staged calls after validating stage coordinates end-to-end. */
  readonly supports_progressive_publication?: boolean;
  readonly registry_snapshot_id: string;
  readonly configuration_revision_id: string;
  readonly registry: AssembledPluginRegistry;
  readonly resolution_lock: SdkPluginResolutionLock;
  readonly configuration: WorkspaceConfigurationRevision;
  readonly dependency_roles: readonly string[];
  analyze(input: {
    readonly workspace_id: string;
    readonly candidate: IndexCandidate;
    readonly artifacts: readonly WorkspaceScanSourceArtifact[];
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
    readonly preceding_stage_snapshot_id?: string;
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
  /** Source capture prepared by stage 1 and reused by later progressive stages. */
  readonly prepared_scan?: PreparedWorkspaceScan;
  /** Internal progressive-scan hook; never crosses the public engine port. */
  readonly on_prepared_scan?: (scan: PreparedWorkspaceScan) => void;
  /** Called after each atomic structural publication in a progressive scan. */
  readonly on_stage_published?: (stage: PluginStructuralStageDeclaration, result: CandidateRunResult) => void | Promise<void>;
}

export interface PreparedWorkspaceScan {
  /** Metadata only; stage transitions reload the verified bytes from CAS. */
  readonly source_artifacts: readonly Omit<WorkspaceScanSourceArtifact, "text">[];
  readonly observations: SourceCandidateObservationSet;
  readonly source_index_generation: number;
  readonly captured_byte_lease: CapturedByteLease;
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
}

export interface SourceOnlyWorkspaceScanResult {
  readonly status: "source_ready";
  readonly source_snapshot_id: string;
  readonly generation: number;
}

/** Publishes only the generic source catalog when no language plugin is available. */
export async function runSourceOnlyWorkspaceScan(input: RunSourceOnlyWorkspaceScanInput): Promise<SourceOnlyWorkspaceScanResult> {
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
  const response = await provider.enumerate(providerRequest({
    call: "enumerate", workspaceId, bindingId, componentId: provider.component_id, componentVersion: provider.component_version,
    payload: { coverage_scopes: [scope] }, ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }), now,
  }));
  if (response.outcome !== "success" || response.payload === undefined) throw new EngineError("engine:workspace_scan_enumeration_failed", `Directory enumeration for ${input.root} did not succeed (outcome ${response.outcome}).`);
  const payload = response.payload as { readonly observation_batch: string; readonly watermark: string };
  const parsedBatch = JSON.parse(payload.observation_batch) as EncodedObservationBatch;
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
  const current = await input.database.repositories.snapshots.getCurrent();
  const result = await new GenericSourceIndexer(input.database).apply({
    response,
    parsed_batch: parsedBatch,
    read,
    publication_current_generation: current?.current_generation ?? 0,
    ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }),
  });
  if (result.status !== "published" && result.status !== "equivalent") throw new EngineError("engine:workspace_scan_source_index_degraded", `Source cataloging of ${input.root} did not complete (status ${result.status}, error ${result.error_code ?? "none"}).`);
  const state = await input.database.sourceIndex.getState();
  const occurrences = await input.database.sourceIndex.currentOccurrencesSlim(bindingId);
  if (state === undefined || occurrences.length === 0) throw new EngineError("engine:workspace_scan_empty", `No eligible source files were found under ${input.root}.`);
  return { status: "source_ready", source_snapshot_id: `source-snapshot:${state.current_generation}`, generation: state.current_generation };
}

function digest(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

function stableId(kind: string, value: unknown): string {
  return `${kind}:${digest(value).slice("sha256:".length)}`;
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
function replacementScopeOwnerArtifactIds(acceptedDeltas: readonly AcceptedFactDelta[]): readonly string[] {
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

// Default duration budget is sized for full enumeration of large real-world
// repositories (hundreds of files, two stability inventories); 60s proved too
// tight and spuriously tripped `resource_exhausted` mid-enumeration.
const DEFAULT_SCAN_MAX_DURATION_MS = 600_000;
const DEFAULT_SCAN_MAX_RESPONSE_BYTES = 64_000_000;

function providerRequest(options: {
  readonly call: "enumerate" | "read";
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

/**
 * Runs a full, real-filesystem indexing session for one workspace: it
 * catalogs every eligible file under `root` into the workspace's durable
 * source index (stage 1, via {@link DirectorySourceProvider} and
 * {@link GenericSourceIndexer}), then drives a full {@link CandidateIndexer}
 * run (stage 2) that hands the cataloged files to `plugin.analyze` and
 * publishes the resulting candidate materialization.
 *
 * This is the first production (non-test) composition of the directory
 * source provider, the generic source indexer, and the candidate indexer
 * together; every stage it calls is otherwise already exercised in isolation.
 */
export async function runFullWorkspaceScan(input: RunFullWorkspaceScanInput): Promise<CandidateRunResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const workspaceId = input.workspace_id;
  const bindingId = input.source_provider_binding_id ?? "provider:filesystem";
  const database = input.database;
  const preparedScan = input.prepared_scan;
  // Wall-clock stage timings, logged to stderr on completion so operators can
  // see where scan time actually goes (analysis vs. sealing vs. storage
  // writes). Stages nest: `publish` spans `plugin_analyze` and `seal`, so its
  // storage-write share is `publish - plugin_analyze - seal`.
  const scanStartedAt = performance.now();
  const stageTimings: Record<string, number> = {};
  const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    const startedAt = performance.now();
    try { return await action(); } finally { stageTimings[stage] = Math.round((stageTimings[stage] ?? 0) + (performance.now() - startedAt)); }
  };
  const logStageTimings = (status: string): void => {
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
  const currentState = await timed("prior_state_current", () => database.repositories.snapshots.getCurrent());
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
  if (preparedScan === undefined) {
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
  const enumerateResponse = await timed("enumerate", () => provider.enumerate(providerRequest({
    call: "enumerate",
    workspaceId,
    bindingId,
    componentId: provider.component_id,
    componentVersion: provider.component_version,
    payload: { coverage_scopes: [scope] },
    ...(input.scan_budget === undefined ? {} : { budget: input.scan_budget }),
    now,
  })));
  if (enumerateResponse.outcome !== "success" || enumerateResponse.payload === undefined) {
    throw new EngineError("engine:workspace_scan_enumeration_failed", `Directory enumeration for ${input.root} did not succeed (outcome ${enumerateResponse.outcome}).`);
  }
  const enumeratePayload = enumerateResponse.payload as { readonly observation_batch: string; readonly watermark: string };
  const encodedBatch = JSON.parse(enumeratePayload.observation_batch) as EncodedObservationBatch;

  const texts = new Map<string, string>();
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
    if (response.outcome === "success" && response.payload !== undefined) {
      const payload = response.payload as { readonly content_bytes: string };
      texts.set(observation.normalized_uri, Buffer.from(payload.content_bytes, "base64").toString("utf8"));
    }
    return response;
  };

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
  sourceIndexResult = await timed("source_catalog", () => new GenericSourceIndexer(database).apply({ response: enumerateResponse, read: readObservation, parsed_batch: encodedBatch, publication_current_generation: currentState?.current_generation ?? 0, ...(input.io_concurrency === undefined ? {} : { io_concurrency: input.io_concurrency }) }));
  if (sourceIndexResult.status !== "published" && sourceIndexResult.status !== "equivalent") {
    throw new EngineError("engine:workspace_scan_source_index_degraded", `Source cataloging of ${input.root} did not complete (status ${sourceIndexResult.status}, error ${sourceIndexResult.error_code ?? "none"}).`);
  }
  // This is the first agent-useful readiness boundary. Keep it separate from
  // the later structural publication timing so cold-start regressions cannot
  // be hidden inside the plugin/checker phase.
  stageTimings["source_ready_ms"] = Math.round(performance.now() - scanStartedAt);

  const occurrences = await database.sourceIndex.currentOccurrencesSlim(bindingId);
  stageTimings["enumerated_artifact_count"] = encodedBatch.observations.length;
  stageTimings["cataloged_artifact_count"] = occurrences.length;
  if (occurrences.length === 0) throw new EngineError("engine:workspace_scan_empty", `No eligible source files were found under ${input.root}.`);

  scannedArtifacts = [];
  const presentObservations: SourceCandidatePresentObservation[] = [];
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
    const text = texts.get(occurrence.artifact.normalized_uri);
    if (text === undefined) continue;
    scannedArtifacts.push({
      path: occurrence.artifact.normalized_path ?? occurrence.artifact.normalized_uri,
      text,
      artifact_id: occurrence.artifact.artifact_id,
      artifact_version_id: occurrence.version.artifact_version_id,
      content_blob_id: occurrence.version.content_blob_id,
      content_hash: occurrence.version.content_hash,
      byte_length: occurrence.version.byte_length,
    });
  }
  // Every `scannedArtifacts[i].text` is now also referenced from `texts`
  // (keyed by URI); the map itself is never read again, so it can be
  // released immediately instead of outliving the (much larger) analysis
  // stage below.
  texts.clear();
  // `seal` (below) only ever needs these three fields, computed here from
  // data that is already fully known before `plugin.analyze` runs, so that
  // `scannedArtifacts` itself (and the source text each entry carries) can be
  // released once `execute` below no longer needs it, instead of staying
  // reachable through `seal`'s closure for the rest of the candidate run.
  observations = {
    outcome: "success",
    stable: true,
    workspace_id: workspaceId,
    observation_batch_id: encodedBatch.batch.observation_batch_id,
    source_provider_binding_id: bindingId,
    source_provider: provider.component_id,
    source_provider_version: provider.component_version,
    watermark: enumeratePayload.watermark,
    completed_at: encodedBatch.batch.completed_at,
    observation_mode: "scan",
    coverage_completeness: "complete",
    deletion_authority: "authoritative",
    coverage_scopes: [{ scope_type: "source_root", normalized_scope_key: "" }],
    supports_authoritative_delete_events: false,
    observations: presentObservations,
  };
  } else {
    sourceIndexResult = { status: "equivalent", generation: preparedScan.source_index_generation };
    preparedScan.captured_byte_lease.renew();
    console.error(`[urdira] captured bytes verify start workspace=${workspaceId} artifacts=${preparedScan.source_artifacts.length}`);
    const capturedVerifyStartedAt = performance.now();
    const verifiedBytes = await preparedScan.captured_byte_lease.verify(database);
    stageTimings["captured_verify_ms"] = Math.round(performance.now() - capturedVerifyStartedAt);
    console.error(`[urdira] captured bytes verify complete workspace=${workspaceId} ms=${stageTimings["captured_verify_ms"]}`);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const capturedHydrationStartedAt = performance.now();
    scannedArtifacts = preparedScan.source_artifacts.map((artifact) => {
      const bytes = verifiedBytes.get(artifact.artifact_id);
      if (bytes === undefined) throw new EngineError("engine:workspace_scan_stale", `Captured-byte lease ${preparedScan.captured_byte_lease.lease_id} omitted ${artifact.artifact_id}.`);
      return { ...artifact, text: decoder.decode(bytes) };
    });
    stageTimings["captured_hydration_ms"] = Math.round(performance.now() - capturedHydrationStartedAt);
    console.error(`[urdira] captured bytes hydration complete workspace=${workspaceId} ms=${stageTimings["captured_hydration_ms"]}`);
    observations = preparedScan.observations;
    stageTimings["source_ready_ms"] = Math.round(performance.now() - scanStartedAt);
    stageTimings["enumerated_artifact_count"] = scannedArtifacts.length;
    stageTimings["cataloged_artifact_count"] = scannedArtifacts.length;
  }
  const knownArtifactVersions = scannedArtifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, artifact_version_id: artifact.artifact_version_id, content_digest: artifact.content_hash }));
  if (preparedScan === undefined && input.on_prepared_scan !== undefined) {
    const metadata = scannedArtifacts.map(({ text: _text, ...artifact }) => artifact);
    input.on_prepared_scan({ source_artifacts: metadata, observations, source_index_generation: sourceIndexResult.generation, captured_byte_lease: capturedByteLease(workspaceId, sourceIndexResult.generation, metadata) });
  }
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
  const lockChanged = currentState !== undefined && currentState.current_resolution_lock_id !== input.plugin.resolution_lock.resolution_lock_id;
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
  const manifest: CandidateWorkManifest = {
    work_manifest_id: manifestId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    artifact_work_set: orderedSet(stableId("workspace-scan-artifact-work-set", { candidateId }), "core:artifact_work_item", scannedArtifacts.length, scannedArtifacts.map((artifact) => artifact.artifact_version_id)),
    projection_work_set: orderedSet(stableId("workspace-scan-projection-work-set", { candidateId }), "core:projection_work_item", 0, []),
    invalidation_plan_id: invalidationPlanId,
    target_registry_snapshot_id: candidate.target_registry_snapshot_id,
    target_configuration_revision_id: candidate.target_configuration_revision_id,
    created_at: now(),
    work_digest: stableId("workspace-scan-work-digest", { candidateId, artifacts: scannedArtifacts.map((artifact) => artifact.artifact_version_id) }),
  };
  const completeness: CompletenessReport = { workspace_snapshot_binding_ids: [], overall_status: "complete", dimensions: [], diagnostic_record_ids: [] };
  const invalidationContract: InvalidationPlan = {
    invalidation_plan_id: invalidationPlanId,
    workspace_id: workspaceId,
    candidate_generation_id: candidateId,
    seed_change_set: orderedSet(stableId("workspace-scan-seed-change-set", { candidateId }), "core:seed_change", 0, []),
    affected_artifact_set: orderedSet(stableId("workspace-scan-affected-artifact-set", { candidateId }), "core:artifact", scannedArtifacts.length, scannedArtifacts.map((artifact) => artifact.artifact_id)),
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
  const indexer = new CandidateIndexer({ workspace: createWorkspaceCandidatePort(database) });
  const stagePlanStartedAt = performance.now();
  const staged = await indexer.stageSourceBatch({
    observations,
    base,
    // A target-lock change must publish a new generation even over a
    // byte-identical tree (docs/decisions/09's upgrade clause: an upgrade
    // flows through the normal candidate pipeline). Without this,
    // `stageSourceBatch`'s own `plan.equivalent` short-circuit would never
    // even reach `publish()` for a plugin upgrade scan that touched no
    // files, silently leaving the workspace's records on the OLD analyzer's
    // output forever.
    force_candidate: lockChanged || (input.publication_stage_ordinal !== undefined && input.publication_stage_ordinal > 1),
    trigger: {
      candidate,
      frozen_base: frozenBase,
      buildPlan: () => plan,
      execute: async (executingCandidate) => {
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
        const changedArtifactIds = currentState === undefined || lockChanged || input.publication_stage_id !== undefined ? undefined : [...new Set(staged.plan.transitions.map((transition) => transition.artifact_change.artifact_id))];
        analysis = await timed("plugin_analyze", () => input.plugin.analyze({ workspace_id: workspaceId, candidate: executingCandidate, artifacts: scannedArtifacts, ...(changedArtifactIds === undefined ? {} : { changed_artifact_ids: changedArtifactIds }), ...(input.publication_stage_id === undefined ? {} : { publication_stage_id: input.publication_stage_id }) }));
        stageTimings["analyzed_artifact_count"] = scannedArtifacts.length;
        stageTimings["accepted_delta_count"] = analysis.accepted_deltas.length;
        // `seal` (below) only reads `knownArtifactVersions`, precomputed
        // above, so nothing past this point needs the scanned source text
        // (or `scannedArtifacts` at all); dropping the array here lets the
        // GC reclaim every file's text instead of it staying reachable for
        // the rest of the candidate run (materialization, publication).
        scannedArtifacts.length = 0;
        return [];
      },
      seal: async ({ candidate: sealedCandidate, plan: sealedPlan }) => {
        if (!analysis) throw new EngineError("engine:workspace_scan_analysis_missing", "Candidate sealing ran before plugin analysis produced a result.");
        const sealedAnalysis = analysis;
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
        const ownerArtifactIds = replacementScopeOwnerArtifactIds(sealedAnalysis.accepted_deltas);
        const replacementScopes = sealedAnalysis.accepted_deltas.flatMap((delta) => delta.replacement_sets.map((set) => set.scope));
        const baseRecords = currentState === undefined ? [] : await timed("prior_state_base_records", () => input.publication_stage_ordinal === undefined || input.publication_stage_ordinal === 1
          ? database.repositories.canonicalOccurrences.currentlyVisibleForOwners(currentState.current_generation, ownerArtifactIds)
          : database.repositories.canonicalOccurrences.currentlyVisibleForReplacementScopes(currentState.current_generation, replacementScopes));
        const baseProjections = currentState === undefined ? [] : await timed("prior_state_base_projections", () => database.projectionOccurrences.currentlyVisibleForOwnersSlim(currentState.current_generation, ownerArtifactIds));
        const identityKeys = [...new Map(sealedAnalysis.accepted_deltas
          .flatMap((delta) => delta.replacement_sets.flatMap((set) => set.records))
          .filter((record) => record.category === "entity" || record.category === "relation" || record.category === "diagnostic")
          .map((record) => [
            `${record.category}\0${record.identity_key}`,
            { identity_type: record.category, identity_key: record.identity_key },
          ])).values()];
        // Stage 1 is the ownership boundary: it replaces every record family
        // and validates the complete identity set. Later progressive stages
        // replace disjoint capability families over that published stage-1
        // base; re-reading every global identity assignment for each stage
        // only recreates the same cross-owner map (hundreds of thousands of
        // rows on the benchmark corpus). Keep the global lookup for the
        // non-progressive/first-stage path, while later stages reuse their
        // owner-scoped base records and retain stage-1 identity ownership.
        const laterProgressiveStage = input.publication_stage_ordinal !== undefined && input.publication_stage_ordinal > 1;
        const globalIdentityRecords = currentState === undefined || identityKeys.length === 0 || laterProgressiveStage ? [] : await timed("prior_state_identity_records", () => database.repositories.canonicalOccurrences.currentlyVisibleForIdentityKeys(currentState.current_generation, identityKeys, { exclude_owner_artifact_ids: ownerArtifactIds }));
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
        const scopedAbsenceBarriers = currentState === undefined ? [] : await timed("prior_state_scoped_absence", () => database.repositories.canonicalOccurrences.closedIdentitiesForOwners(currentState.current_generation, ownerArtifactIds));
        const globalAbsenceBarriers = currentState === undefined || identityKeys.length === 0 ? [] : await timed("prior_state_global_absence", () => database.repositories.canonicalOccurrences.closedIdentitiesForIdentityKeys(currentState.current_generation, identityKeys));
        const absenceBarriers = [...new Map([...scopedAbsenceBarriers, ...globalAbsenceBarriers].map((entry) => [`${entry.identity_type}\0${entry.identity_key}`, entry])).values()];
        return timed("seal", async () => new CandidateMaterializer().seal({
          candidate: sealedCandidate,
          manifest: sealedPlan.manifest,
          source_plan: staged.plan,
          accepted_deltas: sealedAnalysis.accepted_deltas,
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
        }));
      },
      publication: ({ candidate: publishingCandidate, frozen_base: publishingFrozenBase, materialization, template_sets }): CandidatePublicationInput => ({
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
      }),
    } satisfies Omit<CandidateRunTrigger, "source_plan">,
  });
  if (preparedScan !== undefined) console.error(`[urdira] progressive stage plan complete workspace=${workspaceId} stage=${input.publication_stage_id ?? "unknown"}`);
  stageTimings["stage_plan"] = Math.round(performance.now() - stagePlanStartedAt);
  if (staged.status === "degraded") throw new EngineError("engine:workspace_scan_candidate_degraded", "The candidate source plan could not be staged from a stable, complete observation.");

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
  const result = await timed("publish", () => staged.publish());
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
  let result: CandidateRunResult | undefined;
  let preparedScan: PreparedWorkspaceScan | undefined = input.prepared_scan;
  try {
  for (const [index, stage] of stages.entries()) {
    console.error(`[urdira] progressive stage start workspace=${input.workspace_id} stage=${stage.stage_id} ordinal=${stage.ordinal}`);
    if (index > 0 && result !== undefined) {
      // A later stage is valid only as the direct successor of the snapshot
      // just published.  This closes the race where a watcher publishes a
      // newer source/configuration generation while the prepared analysis is
      // still running: never append stage 2/3 to an unrelated predecessor.
      const current = await input.database.repositories.snapshots.getCurrent();
      const predecessor = await input.database.repositories.snapshots.get(result.snapshot_id);
      if (current?.current_snapshot_id !== result.snapshot_id
        || predecessor?.publication_stage_id !== stages[index - 1]?.stage_id
        || predecessor?.publication_stage_ordinal !== stages[index - 1]?.ordinal
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
      ...(preparedScan === undefined ? {} : { prepared_scan: preparedScan }),
      ...(index === 0 && preparedScan === undefined ? { on_prepared_scan: (scan: PreparedWorkspaceScan) => { preparedScan = scan; } } : {}),
    });
    await input.on_stage_published?.(stage, result);
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
