import { chmod, readdir, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DaemonError } from "./errors.js";
import { basename } from "node:path";
import { attemptWorkspaceFork, CanonicalRecordQueryDataPort, createLocalHashProvider, CursorCache, QueryEngine, reconcileSemanticProjection, RecordBodyInterner, semanticMaterializationIdentity, SqliteCanonicalQuerySnapshotPort, WorkspaceConfigurationCoordinator, detectWorkspaceTechnologies, ParcelWatcherAdapter, reconcileLexicalProjection, resolveIndexStatusRequest, runProgressiveWorkspaceScan, runSourceOnlyWorkspaceScan, WorkspaceWatcherManager, type QueryExecutionPage, type ReconcileSemanticProjectionResult, type RegisteredWorkspace, type ResolvedSemanticProvider, type WorkspacePluginCatalogEntry, type WorkspaceRegistry, type WorkspaceScanBudget, type WorkspaceScanPluginProvider } from "@urdira/engine";
import { recipeDefinitions, type PluginCapabilityDeclaration, type QueryRequest, type SemanticMaterializationStatusView, type WorkspaceStructuralProgressView } from "@urdira/contracts";
import { createDurableStorage, type CollectionOptions, type DurableStorage, type RepairComponentKind, type RepairRequest, type WorkspaceDatabase } from "@urdira/storage";
import { runLexicalReconcileInThread, type LexicalThreadRun } from "./lexical-thread.js";
import { EndpointDescriptorStore, LastKnownGoodStore, ProcessLock, daemonPaths, type DaemonPaths } from "./ownership.js";
import { buildSemanticProvider, ensureSemanticAssets, type SemanticModelProvisioningNotice, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
import { ensureSemanticAssetsInProcess, runSemanticReconcileInProcess, startNeuralSemanticProviderHost, type NeuralSemanticProviderHost, type SemanticProcessRun } from "./semantic-process.js";
import { LocalIpcClient, LocalIpcServer, type LocalIpcClientOptions, type LocalIpcRequestOptions, type UceResponse, type UceRequestHandler } from "./protocol.js";
import { DaemonScheduler, PersistentCursorRecovery, type PersistedCursorState, type SchedulerOptions } from "./scheduler.js";

export interface DaemonPluginCatalogEntry extends WorkspacePluginCatalogEntry {
  readonly capability_declarations: readonly PluginCapabilityDeclaration[];
}

export interface DaemonRuntimeOptions {
  readonly data_root: string;
  readonly engine_build_id: string;
  readonly scheduler: SchedulerOptions;
  readonly calls?: Readonly<Record<string, UceRequestHandler>>;
  readonly max_frame_bytes?: number;
  readonly known_cursors?: ReadonlyArray<string>;
  readonly workspace_registry?: WorkspaceRegistry;
  readonly workspace_status?: UceRequestHandler;
  readonly plugin_catalog?: readonly DaemonPluginCatalogEntry[];
  /**
   * Builds the language-plugin half of a real workspace scan (see
   * `packages/engine/src/workspace-indexing-session.ts`'s
   * `WorkspaceScanPluginProvider`) for one workspace, given its already-open
   * storage handle. Returns `undefined` when the workspace has no compatible
   * activated plugin, in which case the workspace cannot be indexed yet.
   * `@urdira/daemon` intentionally has no production language plugin
   * dependency (see AGENTS.md), so this is injected by the composing
   * application (`apps/urdira`) instead of constructed here.
   */
  readonly resolve_plugin_provider?: (workspace: RegisteredWorkspace, database: WorkspaceDatabase) => Promise<WorkspaceScanPluginProvider | undefined>;
  /**
   * Optional overrides for the per-provider-call scan resource budget
   * (duration / response size), injected by the composing application
   * (e.g. from environment variables). Defaults live in
   * `packages/engine/src/workspace-indexing-session.ts`.
   */
  readonly scan_budget?: WorkspaceScanBudget;
  /**
   * Optional override for the maximum number of concurrent provider I/O
   * operations during a full workspace scan (see
   * `packages/engine/src/workspace-indexing-session.ts`'s `io_concurrency`),
   * injected by the composing application from an environment variable.
   */
  readonly scan_io_concurrency?: number;
  /**
   * Whether a successful workspace scan submits a post-ready lexical
   * maintenance job (see `scheduleWorkspaceScan`'s `submitLexicalMaintenance`
   * below, and `reconcileLexicalProjection`, `@urdira/engine`'s
   * `lexical-reconciler.ts`) that brings `lexical_documents`/`lexical_trigrams`
   * up to date for `core:search_text` pushdown. Injected by the composing
   * application from an environment variable (a kill switch: `false` only
   * when explicitly disabled). Defaults to ON (`true`) when omitted --
   * maintenance failure never affects scan success (its own try/catch, see
   * `submitLexicalMaintenance`), so there is no cost to leaving it on besides
   * the maintenance job's own bounded work.
   */
  readonly lexical_index?: boolean;
  /**
   * How often (in ms) the background reconciliation sweep re-checks every
   * `ready`/`degraded` workspace against disk, independent of the file
   * watcher. Defaults to 300_000 (5 minutes) when omitted; `0` disables the
   * sweep entirely (used by tests that want to control reconciliation
   * timing explicitly).
   *
   * A real, reproduced incident (see `currentOccurrencesSlimAsOf`'s doc
   * comment, `packages/storage/src/source-index.ts`) left a running daemon's
   * scan silently stuck partway through publish after a bulk `git checkout
   * -- .` reversion, with no further watcher-triggered scan ever landing for
   * the rest of that process's life -- the daemon looked alive (per
   * `core:status`) but was permanently wedged, serving stale content with no
   * further indication anything was wrong. This sweep is the backstop for
   * exactly that class of failure -- ANY reason a workspace's watcher
   * silently stops delivering usable reconcile triggers (a watcher error the
   * `on_error` handler failed to re-arm from, a swallowed exception
   * somewhere in the delivery chain, a scan that hangs forever without ever
   * settling `scanInFlight`) -- by periodically re-submitting the SAME
   * `scheduleWorkspaceScan` a watcher event would have triggered. This is
   * NOT a separate, hand-rolled "cheap enumerate+hash compare": it reuses
   * `runFullWorkspaceScan`'s own equivalence check verbatim (the same fix
   * that makes it compare against the actual PUBLISHED generation, not just
   * the stage-1 catalog -- see `workspace-indexing-session.ts`'s
   * `currentOccurrencesSlimAsOf`/`currentAbsencesSlimAsOf` usage), which
   * already short-circuits in ~1-1.5s on an unchanged tree of this repo's
   * scale (see that fix's own measured `scan timings ... status=equivalent`
   * log line) -- so a sweep that finds nothing to do costs about as much as
   * the "cheap comparison" this could have been hand-rolled as, without a
   * second, parallel comparison implementation to keep in sync.
   */
  readonly reconciliation_sweep_interval_ms?: number;
  /**
   * Whether an enabled lexical maintenance job (see `lexical_index` above)
   * runs `reconcileLexicalProjection` inside a dedicated `node:worker_threads`
   * worker (`runLexicalReconcileInThread`, `./lexical-thread.js`) instead of
   * in-process. The in-process path only yields to the event loop BETWEEN
   * documents (see `reconcileLexicalProjection`'s `yieldToEventLoop` doc
   * comment, `@urdira/engine`'s `lexical-reconciler.ts`) -- each document's
   * own synchronous trigram computation still runs on the daemon's main
   * thread, which measured as a multi-minute status-RPC lag on a real large
   * repository. The threaded path moves that work off the main thread
   * entirely; `submitLexicalMaintenance` below also aborts an in-flight
   * threaded run (never the in-process path, which has no external abort
   * hook) as soon as a new scan starts for the same workspace, so the
   * worker's own bounded per-document write transactions never contend for
   * long with that scan's publish. Injected by the composing application
   * from an environment variable (a kill switch: `false` only when
   * explicitly disabled, mirroring `lexical_index`/`workspace_fork`).
   * Defaults to ON (`true`) when omitted.
   */
  readonly lexical_thread?: boolean;
  /**
   * Whether a workspace's genuine first-ever scan (no prior published
   * snapshot) first attempts a workspace fork (docs/decisions/12-workspace-fork.md,
   * `attemptWorkspaceFork` in `@urdira/engine`'s `workspace-fork.ts`) before
   * falling back to `runFullWorkspaceScan`. A fork bootstraps the workspace
   * from a content-identical `ready` donor on the same installation by
   * copying its currently-visible canonical rows instead of re-running
   * plugin analysis, and only ever succeeds when its own identity
   * predicates and a post-publish `StorageMaintenance.verify()` all pass;
   * any failure falls back to a full scan (see `scheduleWorkspaceScan`
   * below). Injected by the composing application from an environment
   * variable (a kill switch: `false` only when explicitly disabled).
   * Defaults to ON (`true`) when omitted.
   */
  readonly workspace_fork?: boolean;
  /**
   * Which `StorageMaintenance.verify()` gate a workspace fork's own publish
   * runs before `registry.markReady` (`WorkspaceForkOptions.verify_mode`,
   * `@urdira/engine`'s `workspace-fork.ts`): `"full"` runs the whole-database
   * `verify()` this feature always used to run (measured ~23s on a real
   * 981-file repository); `"fast"` (the default) runs a narrower, much
   * cheaper equivalent (row-count equality, a spot-check byte-compare of 50
   * random records, and a snapshot self-consistency check). Injected by the
   * composing application from `URDIRA_FORK_VERIFY`.
   */
  readonly workspace_fork_verify?: "fast" | "full";
  /**
   * Whether a successful workspace scan (and a successful workspace fork,
   * and daemon startup for every already-`ready`/`degraded` workspace) also
   * submits a post-ready SEMANTIC maintenance job (see
   * `scheduleWorkspaceScan`'s `submitSemanticMaintenance` below, and
   * `reconcileSemanticProjection`, `@urdira/engine`'s `semantic-reconciler.ts`)
   * that brings `vector_projection_rows` up to date for
   * `core:search_semantic`/`core:search_hybrid`. Mirrors `lexical_index`
   * above exactly, one layer over: injected by the composing application
   * from an environment variable (a kill switch: `false` only when
   * explicitly disabled). Defaults to ON (`true`) when omitted --
   * maintenance failure never affects scan success (its own try/catch, see
   * `submitSemanticMaintenance`), so there is no cost to leaving it on
   * besides the maintenance job's own bounded work.
   */
  readonly semantic_index?: boolean;
  /**
   * An already-constructed embedding provider instance (profile identity +
   * runtime binding -- `ResolvedSemanticProvider`, `@urdira/engine`'s
   * `semantic-provider.ts`), for IN-PROCESS callers that already have one --
   * tests overwhelmingly, since this is the only way to hand `DaemonRuntime`
   * a hermetic fake/hash provider without it ever touching a descriptor at
   * all. When both this and `semantic_descriptor` below are given, THIS
   * instance wins for everything this process does with it (every
   * maintenance job, every query port); the descriptor is still recorded
   * (for a future worker-thread run, which cannot cross a thread boundary
   * with a live instance and must serialize a descriptor instead), but this
   * process itself never rebuilds or re-provisions anything for it -- see
   * `ensureAndActivateSemanticProvider` below, which no-ops whenever a
   * provider is already active. When `semantic_index` above is enabled (the
   * default) and NEITHER this nor `semantic_descriptor` is given,
   * `DaemonRuntime.start` defaults to `createLocalHashProvider()` itself,
   * ONCE, at runtime construction -- the bare-library/test fallback for
   * callers with no opinion at all. Ignored entirely when
   * `semantic_index: false` (no provider is ever constructed).
   */
  readonly semantic_provider?: ResolvedSemanticProvider;
  /**
   * A serializable DESCRIPTION of which embedding provider to build (PINNED
   * shape, `SemanticProviderDescriptor`, `./semantic-provider-runtime.js`) --
   * the composing application (`apps/urdira`) resolves this from environment
   * configuration at startup via pure parsing only (no network, no ONNX
   * load: see that app's `resolveSemanticDescriptor`). Configure-time
   * provisioning (USER DECISION, 2026-08-13): the daemon and every embed
   * path run strictly OFFLINE.
   *
   * - At `DaemonRuntime.start`, when no `semantic_provider` instance was
   *   also given, this descriptor is built via `buildSemanticProvider` --
   *   which for a `"neural"` descriptor ALWAYS forces `allow_download: false`
   *   -- so daemon start NEVER touches the network or downloads a model.
   *   A `"neural"` descriptor whose model is not yet present offline makes
   *   this fail: the daemon logs a `console.warn` naming the configure
   *   remedy and starts anyway with semantic search effectively unavailable
   *   (`core:search_semantic` throws `core:semantic_index_unavailable`,
   *   `core:search_hybrid` degrades to its lexical-only lane, and
   *   `submitSemanticMaintenance` no-ops) rather than crashing the daemon
   *   over a missing embedding model.
   * - At each of the three configure-time admin RPCs
   *   (`core:workspace_add`/`core:workspace_configure`/`core:configuration_set`),
   *   after that RPC's own validation succeeds, the daemon calls
   *   `ensureAndActivateSemanticProvider` (below), which runs
   *   `ensureSemanticAssets(descriptor)` -- the one point in the whole
   *   system allowed to actually download the model. A download failure
   *   there `console.warn`s and the RPC continues normally: a model
   *   download must never block structural indexing (decision 06). A
   *   download SUCCESS, when semantic was previously unavailable, builds
   *   the provider now, activates it for the rest of this process's
   *   lifetime, and invalidates every cached per-workspace query engine (see
   *   `queryEngines` below) so the very next query against any workspace
   *   picks up the newly active provider without a daemon restart. A
   *   download must also never be SILENT (owner decision 2026-08-13,
   *   docs/decisions/18-semantic-model-pack.md Outcome): `ensureSemanticAssets`
   *   logs a start-of-download line before the network attempt, and
   *   whichever of these three RPCs actually ran the ensure carries its
   *   outcome back as its own response's `semantic_model` field (see
   *   `SemanticModelProvisioningNotice`, `./semantic-provider-runtime.js`).
   */
  readonly semantic_descriptor?: SemanticProviderDescriptor;
  /**
   * Test-only seam: overrides for `buildSemanticProvider`/`ensureSemanticAssets`
   * (`./semantic-provider-runtime.js`), so a test can exercise the full
   * "absent at start -> a configure RPC provisions it -> the SAME daemon
   * serves semantic without restart" activation flow with injected
   * hash-provider-backed fakes instead of a real `"neural"` descriptor and a
   * real model download. Production callers (`apps/urdira`) never set this;
   * omitted, `DaemonRuntime` uses the real `buildSemanticProvider`/
   * `ensureSemanticAssets` from `./semantic-provider-runtime.js`.
   */
  readonly semantic_runtime_hooks?: {
    readonly build?: (descriptor: SemanticProviderDescriptor) => Promise<ResolvedSemanticProvider>;
    readonly ensure?: (descriptor: SemanticProviderDescriptor) => Promise<SemanticModelProvisioningNotice | undefined>;
  };
  /**
   * Whether an enabled semantic maintenance job (see `semantic_index` above)
   * runs `reconcileSemanticProjection` inside a dedicated `node:worker_threads`
   * worker (`runSemanticReconcileInThread`, `./semantic-thread.js`) instead
   * of in-process. Mirrors `lexical_thread` above exactly, one layer over --
   * same `ABORT_GRACE_MS`, same scan-preemption story (`semanticThreadRuns`
   * below, aborted at the same point `lexicalThreadRuns` is) -- but for a
   * different, LATER-discovered reason: `submitSemanticMaintenance`'s
   * original in-process-only design (see its own superseded doc comment
   * below, and docs/decisions/16-semantic-search-wiring.md) assumed the
   * bundled hash embedder's cheap per-document CPU work made a worker
   * thread unnecessary, which held right up until the shipped default
   * became a real ONNX model (`@urdira/embedding-local`, reached through
   * `semantic_descriptor`'s `"neural"` kind). Measured on a real
   * installation: a fleet-wide re-embed of one workspace (tensor
   * preparation plus ONNX inference, all on the main thread) produced
   * 5-20s of `core:query` latency against OTHER, unrelated workspaces
   * sharing the same daemon process -- the same class of main-thread-CPU
   * starvation `lexical_thread` exists to avoid, just discovered later and
   * for a different maintenance pass.
   *
   * Only ever takes effect when a `semantic_descriptor` (below) is what
   * resolved the active provider: a live `ResolvedSemanticProvider`
   * INSTANCE (`semantic_provider`, an in-process override) cannot cross a
   * `node:worker_threads` boundary, so `submitSemanticMaintenance` always
   * runs in-process when one was given, regardless of this flag. The same
   * is true, for a different reason, whenever `semantic_runtime_hooks` is
   * set: a worker thread always builds its provider via the REAL
   * `buildSemanticProvider` (`semantic-worker-thread.ts` imports it
   * directly, with no hook seam of its own), so a test injecting a fake
   * `build`/`ensure` pair would silently stop being exercised the moment
   * maintenance moved onto a thread that cannot see those fakes at all --
   * `submitSemanticMaintenance` treats a configured `semantic_runtime_hooks`
   * as an in-process-only signal for exactly this reason, independent of
   * whether an activation actually used the hook. Injected by the
   * composing application from an environment variable (a kill switch:
   * `false` only when explicitly disabled, mirroring `lexical_thread`).
   * Defaults to ON (`true`) when omitted.
   */
  readonly semantic_thread?: boolean;
  /** Process isolation for native neural embeddings. Defaults to true; the legacy semantic_thread flag is used when this is unset. */
  readonly semantic_process?: boolean;
  /**
   * Optional override for `ReconcileSemanticProjectionInput.embed_batch_size`
   * (`@urdira/engine`'s `semantic-reconciler.ts`) -- how many pending
   * documents a semantic maintenance pass collects before calling the active
   * provider's optional batched `generateVectors`, instead of one
   * `generateVector` call per document. Injected by the composing
   * application (`apps/urdira`) from the `URDIRA_SEMANTIC_EMBED_BATCH`
   * environment variable. Threaded to BOTH the in-process
   * `reconcileSemanticProjection` call and the threaded-worker job
   * (`SemanticThreadJob.embed_batch_size`, `./semantic-thread.js`) below, so
   * it takes effect regardless of which path `semantic_thread` selects.
   * Omitted, `reconcileSemanticProjection` defaults to 16.
   */
  readonly semantic_embed_batch_size?: number;
  /**
   * Optional hook: evicts (closes) any pooled per-workspace analysis worker
   * for a workspace that was just removed via `core:workspace_remove`. Plain
   * function wiring only -- `@urdira/daemon` has no dependency on any
   * production language plugin (AGENTS.md: "Do not add a production
   * language plugin in the Core MVP" to core packages), so it never
   * constructs or knows about the pool itself; the composing app
   * (`apps/urdira`) supplies this closure bound to its own pool instance
   * (see `apps/urdira/src/analysis-worker-pool.ts`). Omitted (the default)
   * means today's behavior, byte-for-byte: no pool exists to evict from.
   */
  readonly analysis_worker_pool_evict?: (workspace_id: string) => Promise<void>;
  /**
   * Optional hook: closes every pooled analysis worker at daemon shutdown,
   * so `stop()` never leaves an orphaned worker thread (and its Go analysis
   * server child process) running past the daemon's own lifetime. See
   * `analysis_worker_pool_evict`'s doc comment for why this is a plain
   * closure rather than a pool instance/dependency.
   */
  readonly analysis_worker_pool_close_all?: () => Promise<void>;
  /**
   * LRU byte budget, in megabytes, for warm per-workspace decoded record
   * caches (`SqliteCanonicalQuerySnapshotPort.recordsCache` and its sibling
   * caches, `@urdira/engine`'s `canonical-query-data-port.ts`, via that
   * port's own `approxWarmBytes()`/`evictWarmRecords()`). A fleet of forked
   * workspaces multiplies the daemon's RAM by workspace count even though
   * forked workspaces share almost all record content (decision 11); this
   * bounds it. After `acquireWorkspaceQueryEngine` touches the LRU (on every
   * cache hit) and after every warm-up completes, the runtime sums
   * `approxWarmBytes()` over every currently cached `queryEngines` entry
   * and, if that sum exceeds this budget, evicts (`evictWarmRecords()` --
   * NOT closing the database handle or dropping the `queryEngines` entry;
   * only the decoded corpus is the RAM problem) least-recently-used
   * workspaces first until back under budget -- but NEVER evicts the single
   * most-recently-used workspace, even if that alone still leaves the total
   * over budget (a corpus larger than the whole budget is an accepted
   * degenerate case: at least the active workspace stays warm). The startup
   * prewarm chain (see `DaemonRuntime.start`) also stops warming additional
   * workspaces once the budget is reached, leaving the rest cold to load on
   * first query (the existing, already-accepted 8-11s cold path) rather
   * than warming them only to immediately evict an earlier one.
   *
   * Default 3072 (3 GiB) when omitted, or when negative/non-finite. `0` is a
   * valid, meaningful value distinct from "omitted": warm caching is
   * disabled almost entirely -- every workspace beyond the single
   * most-recently-used one is evicted immediately after use. Degenerate but
   * must still answer every query correctly, just always cold except for
   * whichever workspace was touched last. Injected by the composing
   * application from `URDIRA_WARM_RECORDS_BUDGET_MB`.
   */
  readonly warm_records_budget_mb?: number;
}
export interface DaemonStatus { readonly state: "starting" | "ready" | "stopping"; readonly pid: number; readonly engine_build_id: string; readonly endpoint: string; readonly active_jobs: number; readonly restart_leases: number; }

function workspaceDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Builds the in-memory `SemanticMaterializationStatusView` (`@urdira/contracts`
 * `models.ts:2731-2739`) `submitSemanticMaintenance` below caches after every
 * `reconcileSemanticProjection` completion -- including its own already-complete
 * fast path, which still returns a fully-formed `ReconcileSemanticProjectionResult`
 * (`marker_written: true`, every count `0`) -- and `core:index_status` serves
 * back verbatim for the workspace's `semantic_materializations` field.
 *
 * `materialization_state`: `"complete"` once the completion marker landed
 * (`marker_written`); otherwise `"degraded"` when this pass left any document
 * `failed` (a real provider error, retried next pass -- see
 * `reconcileSemanticProjection`'s own doc comment for why `failed > 0` alone
 * withholds the marker); otherwise `"updating"` (a pass is still needed, or
 * in flight). `coverage_status` is the stricter "fully clean" check: even a
 * marker-current pass with zero failures can have left permanent, content-
 * driven skips behind (`skipped_oversized`/`skipped_undecodable`/`skipped_empty`,
 * plus their entity-grain siblings `entity_skipped_oversized`/
 * `entity_skipped_undecodable`/`entity_skipped_empty` -- none of which
 * withhold the marker, since retrying them next pass would just reproduce
 * the identical skip), so `coverage_status` is only `"complete"` when NONE
 * of those occurred either; otherwise `"partial"`. Deliberately EXCLUDES
 * `entity_skipped_ineligible`: unlike every other skip counter, this one
 * counts a deliberate, working-as-designed POLICY exclusion (decision 17's
 * eligibility filter -- parameters, indented locals, short spans), not a
 * content-read failure -- on a real corpus the large majority of candidate
 * entity records are expected to be ineligible (the bench gate measured
 * ~86% on excalidraw), so folding it in here would report "partial" on
 * every healthy workspace that has ever embedded a single entity document,
 * which is not the "something is actually incomplete" signal this field
 * means to carry.
 * `pending_document_count` is `failed` PLUS `entity_failed` (decision 17:
 * entity-grain semantic documents) -- the only counts this reconcile result
 * exposes that genuinely mean "retried on the next pass", matching this
 * view's own field doc at `models.ts`, folded into ONE number since this
 * contract field predates the entity pass and was not extended with a
 * grain-specific sibling (kept minimal per decision 17's own daemon-changes
 * note: extend the semantic block "only as far as needed"). `pending_segment_count`
 * is always `0`: v1 has no sub-document segment grain (one vector per
 * visible artifact version or entity, see the pinned scope decision), so
 * there is nothing narrower than a whole document for this field to ever
 * count.
 */
function semanticMaterializationView(workspaceId: string, reconciled: ReconcileSemanticProjectionResult, provider: ResolvedSemanticProvider, sourceSnapshotId: string): SemanticMaterializationStatusView {
  const semanticMaterializationId = semanticMaterializationIdentity({ workspace_id: workspaceId, generation: reconciled.generation, profile_id: provider.profile.embedding_profile_id });
  const pendingDocumentCount = reconciled.failed + reconciled.entity_failed;
  const materializationState = reconciled.marker_written ? "complete" : pendingDocumentCount > 0 ? "degraded" : "updating";
  const coverageStatus = reconciled.marker_written && pendingDocumentCount === 0
    && reconciled.skipped_oversized === 0 && reconciled.skipped_undecodable === 0 && reconciled.skipped_empty === 0
    && reconciled.entity_skipped_oversized === 0 && reconciled.entity_skipped_undecodable === 0 && reconciled.entity_skipped_empty === 0
    ? "complete" : "partial";
  return {
    semantic_materialization_id: semanticMaterializationId,
    embedding_profile_id: provider.profile.embedding_profile_id,
    source_snapshot_id: sourceSnapshotId,
    materialization_state: materializationState,
    coverage_status: coverageStatus,
    pending_document_count: pendingDocumentCount,
    pending_segment_count: 0,
  };
}

// Every error class a workspace scan can throw through (DaemonError,
// EngineError, StorageError, ...) exposes a stable string `code`; falls back
// to a generic code only for a genuinely unexpected throw (e.g. a raw
// non-Error value), so `WorkspaceRegistry#recordScanFailure` always gets
// something diagnosable to persist and later surface via `core:index_status`.
function scanFailureErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
  return "core:workspace_scan_failed";
}

// `"current"` must mean what it says: the workspace is queryable AND its
// latest scan attempt actually succeeded. A workspace re-pinned to
// `priorSnapshotId` after a failed scan (`scheduleWorkspaceScan`'s catch
// block, above) is still queryable -- `"ready"`/`"degraded"` -- but is
// serving a generation strictly older than reality, indefinitely, until
// whatever is wedging it gets fixed (the canonical case: the
// delete-then-restore-identical-content `publication_conflict` loop). Before
// this, `core:index_status` reported `"current"` for exactly that workspace,
// so a querying agent had no signal it was reading stale data.
function workspaceFreshnessStatus(workspace: RegisteredWorkspace): "current" | "stale" | "indexing" {
  if (workspace.status !== "ready" && workspace.status !== "degraded") return "indexing";
  return workspace.last_scan_error === undefined ? "current" : "stale";
}

const SOURCE_OPERATIONS = ["core:find_artifacts", "core:search_text", "core:get_source"] as const;
const STRUCTURAL_OPERATIONS = ["core:resolve_symbol", "core:get_outline", "core:find_references", "core:expand_relations", "core:analyze_impact", "core:build_context"] as const;
const STRUCTURAL_OPERATION_STAGE: Readonly<Record<string, number>> = {
  "core:get_outline": 1,
  "core:resolve_symbol": 2,
  "core:find_references": 2,
  "core:expand_relations": 2,
  "core:analyze_impact": 3,
  "core:build_context": 3,
};
const CAPABILITY_STAGE: Readonly<Record<string, number>> = {
  "core:syntax_structure": 1,
  "core:symbol_declarations": 1,
  "core:module_dependencies": 1,
  "core:symbol_resolution": 2,
  "core:call_relationships": 2,
  "core:inheritance_and_implementation": 2,
  "core:type_information": 3,
  "core:control_flow": 3,
  "core:data_flow": 3,
  "core:effects": 3,
  "core:test_relationships": 3,
  "core:semantic_preparation": 3,
};

function operationRequiredStructuralStage(payload: unknown): number {
  const request = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const expression = request["expression"] !== null && typeof request["expression"] === "object" && !Array.isArray(request["expression"]) ? request["expression"] as Record<string, unknown> : {};
  if (expression["expression_type"] === "operation") {
    const operation = String(expression["operation"]);
    if (SOURCE_OPERATIONS.includes(operation as typeof SOURCE_OPERATIONS[number])) return 0;
    return STRUCTURAL_OPERATION_STAGE[operation] ?? 3;
  }
  if (expression["expression_type"] === "recipe") {
    const recipe = recipeDefinitions.find((candidate) => candidate.recipe_id === expression["recipe_id"]);
    return recipe?.required_capabilities.reduce((highest, capability) => Math.max(highest, CAPABILITY_STAGE[capability] ?? 3), 0) ?? 3;
  }
  // Pipelines can compose arbitrary operations; require the final stage
  // unless a future planner proves a lower exact requirement.
  return 3;
}

interface WorkspaceReadiness {
  readonly source_ready: boolean;
  readonly structural_ready: boolean;
  readonly semantic_ready: boolean;
  readonly source_snapshot_id?: string;
  readonly structural_snapshot_id?: string;
  readonly structural_source_snapshot_id?: string;
  readonly source_availability: "available" | "unavailable";
  readonly source_completeness: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  readonly source_freshness: "equivalent" | "changes_pending" | "degraded";
  readonly source_build_state: "not_started" | "building" | "idle" | "failed" | "disabled";
  readonly structural_availability: "available" | "unavailable";
  readonly structural_completeness: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  readonly structural_freshness: "equivalent" | "changes_pending" | "degraded";
  readonly structural_build_state: "not_started" | "building" | "idle" | "failed" | "disabled";
  readonly structural_stage_id?: string;
  readonly structural_stage_ordinal?: number;
  readonly structural_stage_count?: number;
  readonly semantic_availability: "available" | "unavailable";
  readonly semantic_completeness: "complete" | "partial" | "unknown" | "unsupported" | "stale";
  readonly semantic_build_state: "not_started" | "building" | "idle" | "failed" | "disabled";
  readonly readiness_reason_codes: readonly string[];
  readonly retry_after_ms?: number;
}

/**
 * Derives v3 readiness from durable source state, the published structural
 * snapshot, and the asynchronous semantic marker. The booleans deliberately
 * have no independent storage representation: a source snapshot is useful
 * while plugin analysis is still running, and a structural snapshot is only
 * current when its published generation is at least the latest source
 * generation.
 */
async function workspaceReadiness(
  workspace: RegisteredWorkspace,
  storage: DurableStorage | undefined,
  semantic: ReadonlyMap<string, SemanticMaterializationStatusView>,
  scanRunning: boolean,
): Promise<WorkspaceReadiness> {
  let sourceState: Awaited<ReturnType<WorkspaceDatabase["sourceIndex"]["getState"]>>;
  let structuralGeneration: number | undefined;
  let structuralStageId: string | undefined;
  let structuralStageOrdinal: number | undefined;
  let structuralStageCount: number | undefined;
  try {
    if (storage === undefined) throw new Error("storage unavailable");
    const database = await storage.openWorkspace(workspace.workspace_id);
    try {
      sourceState = await database.sourceIndex.getState();
      if (workspace.current_snapshot_id !== undefined) {
        const snapshot = await database.repositories.snapshots.get(workspace.current_snapshot_id);
        structuralGeneration = snapshot?.generation;
        if (snapshot !== undefined) {
          structuralStageId = snapshot.publication_stage_id;
          structuralStageOrdinal = snapshot.publication_stage_ordinal;
          structuralStageCount = snapshot.publication_stage_count;
        }
      }
    } finally {
      await database.close().catch(() => undefined);
    }
  } catch {
    sourceState = undefined;
  }

  const source = sourceState;
  const sourceAvailable = source !== undefined;
  const sourceSnapshotId = sourceAvailable ? `source-snapshot:${source.current_generation}` : undefined;
  const sourceReady = sourceAvailable;
  const structuralUnsupported = (workspace.selected_plugin_ids ?? []).length === 0;
  const finalStructuralStage = structuralStageCount === undefined || structuralStageOrdinal === undefined || structuralStageOrdinal >= structuralStageCount;
  const structuralReady = workspace.current_snapshot_id !== undefined
    && sourceAvailable
    && structuralGeneration !== undefined
    && structuralGeneration >= source.current_generation
    && finalStructuralStage
    && workspace.status !== "indexing"
    && workspace.last_scan_error === undefined;
  const structuralStale = workspace.current_snapshot_id !== undefined && sourceAvailable && structuralGeneration !== undefined && source.current_generation > structuralGeneration;
  const semanticView = semantic.get(workspace.workspace_id);
  const semanticReady = structuralReady && semanticView?.materialization_state === "complete" && semanticView.source_snapshot_id === workspace.current_snapshot_id;
  const sourceReasonCodes = sourceAvailable ? [] : ["core:source_catalog_unavailable"];
  const structuralReasonCodes = structuralReady
    ? []
    : [structuralStale ? "core:source_snapshot_changed" : scanRunning ? "core:analysis_in_progress" : structuralUnsupported ? "core:plugin_unavailable" : "core:structural_snapshot_unavailable"];
  const semanticReasonCodes = semanticReady ? [] : [structuralUnsupported ? "core:plugin_unavailable" : structuralReady ? "core:semantic_indexing_in_progress" : "core:structural_required"];
  return {
    source_ready: sourceReady,
    structural_ready: structuralReady,
    semantic_ready: semanticReady,
    ...(sourceSnapshotId === undefined ? {} : { source_snapshot_id: sourceSnapshotId }),
    ...(workspace.current_snapshot_id === undefined ? {} : { structural_snapshot_id: workspace.current_snapshot_id, ...(sourceSnapshotId === undefined ? {} : { structural_source_snapshot_id: sourceSnapshotId }) }),
    source_availability: sourceAvailable ? "available" : "unavailable",
    source_completeness: sourceAvailable ? "complete" : "unknown",
    source_freshness: sourceAvailable ? "equivalent" : "degraded",
    source_build_state: sourceAvailable ? "idle" : workspace.status === "indexing" ? "building" : "not_started",
    structural_availability: structuralReady || structuralStageId !== undefined ? "available" : "unavailable",
    structural_completeness: structuralReady ? "complete" : structuralStageId !== undefined ? "partial" : structuralUnsupported ? "unsupported" : "unknown",
    structural_freshness: structuralReady ? "equivalent" : structuralStale ? "changes_pending" : "degraded",
    structural_build_state: structuralReady ? "idle" : structuralUnsupported ? "disabled" : scanRunning ? "building" : "not_started",
    ...(structuralStageId === undefined || structuralStageOrdinal === undefined || structuralStageCount === undefined ? {} : { structural_stage_id: structuralStageId, structural_stage_ordinal: structuralStageOrdinal, structural_stage_count: structuralStageCount }),
    semantic_availability: semanticReady ? "available" : "unavailable",
    semantic_completeness: semanticReady ? "complete" : structuralUnsupported ? "unsupported" : "unknown",
    semantic_build_state: semanticReady ? "idle" : structuralUnsupported ? "disabled" : structuralReady ? "building" : "not_started",
    readiness_reason_codes: [...sourceReasonCodes, ...structuralReasonCodes, ...semanticReasonCodes],
    ...(scanRunning && !structuralReady ? { retry_after_ms: 1000 } : {}),
  };
}

function readinessPayload(readiness: WorkspaceReadiness): Record<string, unknown> {
  const completedStage = readiness.structural_ready ? 3 : readiness.structural_stage_ordinal ?? 0;
  const available = [
    ...(readiness.source_ready ? SOURCE_OPERATIONS : []),
    ...STRUCTURAL_OPERATIONS.filter((operation) => completedStage >= (STRUCTURAL_OPERATION_STAGE[operation] ?? 3)),
  ];
  const blocked = STRUCTURAL_OPERATIONS.filter((operation) => !available.includes(operation));
  const structuralReasonCodes = readiness.structural_ready
    ? []
    : readiness.structural_freshness === "changes_pending"
      ? ["core:source_snapshot_changed"]
      : readiness.structural_completeness === "unsupported"
        ? ["core:plugin_unavailable"]
        : readiness.structural_completeness === "partial"
          ? ["core:structural_stage_in_progress"]
        : readiness.structural_build_state === "building"
          ? ["core:analysis_in_progress"]
          : ["core:structural_snapshot_unavailable"];
  const semanticReasonCodes = readiness.semantic_ready
    ? []
    : readiness.semantic_completeness === "unsupported"
      ? ["core:plugin_unavailable"]
      : readiness.structural_ready
        ? ["core:semantic_indexing_in_progress"]
        : ["core:structural_required"];
  const blockedReasonCode = structuralReasonCodes[0] ?? "core:analysis_in_progress";
  const blockedRetryable = readiness.structural_completeness !== "unsupported";
  return {
    ...readiness,
    ...(readiness.source_snapshot_id === undefined ? {} : { source_snapshot_id: readiness.source_snapshot_id }),
    readiness: {
      source: {
        availability: readiness.source_availability,
        completeness: readiness.source_completeness,
        freshness: readiness.source_freshness,
        build_state: readiness.source_build_state,
        ...(readiness.source_snapshot_id === undefined ? {} : { snapshot_id: readiness.source_snapshot_id }),
        reason_codes: readiness.source_ready ? [] : ["core:source_catalog_unavailable"],
      },
      structural: {
        availability: readiness.structural_availability,
        completeness: readiness.structural_completeness,
        freshness: readiness.structural_freshness,
        build_state: readiness.structural_build_state,
        ...(readiness.structural_source_snapshot_id === undefined ? {} : { based_on_source_snapshot_id: readiness.structural_source_snapshot_id }),
        reason_codes: structuralReasonCodes,
        ...(readiness.retry_after_ms === undefined ? {} : { retry_after_ms: readiness.retry_after_ms }),
      },
      semantic: {
        availability: readiness.semantic_availability,
        completeness: readiness.semantic_completeness,
        build_state: readiness.semantic_build_state,
        reason_codes: semanticReasonCodes,
      },
    },
    operation_availability: {
      available_now: available,
      blocked: blocked.map((operation) => ({ operation, required_layer: "structural", retryable: blockedRetryable, reason_code: blockedReasonCode, ...(readiness.retry_after_ms === undefined ? {} : { retry_after_ms: readiness.retry_after_ms }) })),
    },
    available_operations: available,
    blocked_operations: blocked,
  };
}

/**
 * Stamps a query response with a small, non-list staleness envelope sourced
 * from the workspace registry -- no extra database read, since everything
 * needed is already sitting on `RegisteredWorkspace` (part 3.2 of the
 * `publication_conflict` wedge fix: queries must not silently serve a
 * generation from a workspace whose latest scan failed without ANY signal in
 * the response itself). Reports `last_success_snapshot_id` rather than a raw
 * generation number: the registry only tracks the snapshot id, and fetching
 * the numeric generation would cost an extra per-query database read purely
 * for a diagnostic field -- the snapshot id already uniquely identifies
 * "which published state this response is serving" for a caller that wants
 * to correlate against `core:index_status`.
 */
function attachIndexFreshness<T extends QueryExecutionPage>(page: T, workspace: RegisteredWorkspace | undefined): T & { readonly index_freshness?: { readonly status: "current" | "stale" | "indexing"; readonly last_scan_error?: string; readonly last_success_snapshot_id?: string } } {
  if (workspace === undefined) return page;
  return {
    ...page,
    index_freshness: {
      status: workspaceFreshnessStatus(workspace),
      ...(workspace.last_scan_error === undefined ? {} : { last_scan_error: workspace.last_scan_error }),
      ...(workspace.current_snapshot_id === undefined ? {} : { last_success_snapshot_id: workspace.current_snapshot_id }),
    },
  };
}

function requestRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function workspaceRootFromRequest(payload: unknown): string | undefined {
  const record = requestRecord(payload);
  const args = Array.isArray(record["args"]) ? record["args"] : [];
  const values = requestRecord(record["values"]);
  const candidate = args[0] ?? values["path"] ?? values["workspace_root"];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function pluginCatalogFingerprint(catalog: readonly DaemonPluginCatalogEntry[]): string {
  return workspaceDigest(JSON.stringify([...catalog].sort((left, right) => left.plugin_id.localeCompare(right.plugin_id)).map(({ capability_declarations: _capabilities, ...entry }) => entry)));
}

/**
 * `core:query`/`core:query_continue` cursors are HMAC-signed by `CursorCache`
 * (`@urdira/engine`) using a secret generated once per `DaemonRuntime`
 * process instance (not persisted to the data root). This intentionally does
 * NOT fully satisfy `docs/decisions/10-daemon-mcp-packaging.md`'s "Ready
 * query executions ... remain continuable after restart" invariant -- see
 * the long comment on `acquireWorkspaceQueryEngine` below for why a
 * from-scratch secret is the *safer* minimum given this change's
 * `QueryManifestStore` choice, and what full cross-restart durability would
 * additionally require. Flagged in the final report as a known gap, not a
 * silent shortcut.
 */
function createCursorSigningSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Extracts the single-workspace target from a `QueryScope` in a `core:query`/`core:query_continue` request payload. Comparison scopes are not yet resolvable to one workspace database (see final report). */
function singleWorkspaceScopeId(payload: unknown): string | undefined {
  const scope = requestRecord(requestRecord(payload)["scope"]);
  return scope["scope_type"] === "single_workspace" && typeof scope["workspace_id"] === "string" && scope["workspace_id"].length > 0 ? scope["workspace_id"] : undefined;
}

function queryUsesSourceBinding(payload: unknown): boolean {
  const request = requestRecord(payload);
  if (request["api_version"] !== 2) return false;
  const scope = requestRecord(request["scope"]);
  return typeof scope["snapshot_id"] === "string" && scope["snapshot_id"].startsWith("source-snapshot:");
}

function queryRequiresStructural(payload: unknown): boolean {
  if (queryUsesSourceBinding(payload)) {
    const expression = requestRecord(requestRecord(payload)["expression"]);
    if (expression["expression_type"] === "operation" && ["core:find_artifacts", "core:search_text", "core:get_source"].includes(String(expression["operation"]))) return false;
  }
  return true;
}

/**
 * Resolves the target workspace (reusing `resolveIndexStatusRequest`, the
 * same readiness gating already used for `core:index_status`) and returns a
 * `QueryEngine` for it, opening and caching its `WorkspaceDatabase` and
 * `QueryEngine` the first time a given workspace is queried, then reusing
 * both for the runtime's lifetime (closed transitively by `indexingStorage`'s
 * own `close()`, which already tracks and closes every `WorkspaceDatabase`
 * it opened -- see `DurableStorage.close()` -- plus an explicit close on
 * `core:workspace_remove` below so a removed workspace does not keep an open
 * handle around).
 *
 * This is a cached-handle-per-workspace design, not open-then-close per
 * call, for one specific reason: the `QueryEngine`'s manifest store (which
 * `core:query_continue` cursors read from) is the default in-memory
 * `MemoryManifestStore`, scoped to one `QueryEngine` instance. Opening a
 * fresh `QueryEngine` per call would discard every manifest the instant its
 * call returned, breaking `core:query_continue` on the very next call within
 * the same process -- not just across a restart. Caching the engine per
 * workspace keeps `core:query_continue` correct for the runtime's lifetime
 * without extra bookkeeping: `SqliteCanonicalQuerySnapshotPort` re-reads
 * `workspace_current_state` on every call, so a long-lived handle still sees
 * newer published snapshots as they land.
 *
 * The alternative -- `DurableManifestStore` (`@urdira/engine`), backed by
 * `WorkspaceDatabase.lifecycle` -- would persist manifests in the workspace's
 * own SQLite database and survive a restart. It was tried first and reverted:
 * `WorkspaceLifecycleRepository.appendManifestSegment` requires a
 * `query_executions` row already created via `createExecution`, which in
 * turn requires a real, unexpired `retention_leases` row bound to a real
 * workspace snapshot id (`acquireLease`/`validateExecutionBindings` in
 * `packages/storage/src/lifecycle.ts`). Standing that up correctly (choosing
 * lease holder identity, idle/absolute TTLs, and reacting to lease
 * expiry/renewal) is a real, separate storage-retention integration, not a
 * one-line swap -- attempting a partial version risked violating that
 * system's actual invariants. It is flagged in the final report as the
 * concrete follow-up for full cross-restart `core:query_continue` durability,
 * rather than guessed at here.
 *
 * Given that choice, persisting the `CursorCache` signing secret across
 * restarts (as originally attempted) would have been actively misleading:
 * a cursor issued before a restart would still decode and verify (valid
 * HMAC), but its manifest data would already be gone, so
 * `core:query_continue` would silently return an empty page instead of a
 * clear error -- violating the "queries are exact and deterministic, never
 * hide truncation" invariant in `AGENTS.md`. A fresh in-process-only secret
 * instead makes every pre-restart cursor fail cursor authentication
 * cleanly after a restart, which is the safer of the two incomplete options
 * available without the full retention-lease integration above.
 */
interface CachedWorkspaceQueryEngine { readonly database: WorkspaceDatabase; readonly engine: QueryEngine; readonly data_port: CanonicalRecordQueryDataPort; readonly snapshot_port: SqliteCanonicalQuerySnapshotPort; }

const DEFAULT_WARM_RECORDS_BUDGET_MB = 3072;
const BYTES_PER_MEGABYTE = 1024 * 1024;

/** `DaemonRuntimeOptions.warm_records_budget_mb` resolution: default when omitted, and fallback-to-default for negative/non-finite overrides (a hand-constructed test option, since the composing app's own env parsing already filters those before they ever reach here -- see `apps/urdira/src/index.ts`'s `warmRecordsBudgetMbEnv`). `0` is left exactly as given: a valid, meaningful "disable warm caching" budget, distinct from "omitted". */
function warmRecordsBudgetBytes(configuredMb: number | undefined): number {
  const mb = configuredMb === undefined || !Number.isFinite(configuredMb) || configuredMb < 0 ? DEFAULT_WARM_RECORDS_BUDGET_MB : configuredMb;
  return mb * BYTES_PER_MEGABYTE;
}

/**
 * Tracks how recently each workspace's `CachedWorkspaceQueryEngine` was used
 * (`touchWarmLru`, below), for `enforceWarmRecordsBudget`'s LRU eviction.
 * `last_used` holds a monotonically increasing counter per workspace id --
 * not `Date.now()`, which is far coarser-resolution than the rate
 * `acquireWorkspaceQueryEngine` can legitimately be called at (two calls in
 * the same millisecond must still have a strict order) and is not guaranteed
 * monotonic across a system clock adjustment. One instance is created per
 * `DaemonRuntime` in `start()` and threaded through every call site that
 * acquires or warms a workspace's query engine.
 */
interface WarmRecordsLru { readonly last_used: Map<string, number>; counter: number; readonly budget_bytes: number; }

function touchWarmLru(lru: WarmRecordsLru, workspaceId: string): void {
  lru.counter += 1;
  lru.last_used.set(workspaceId, lru.counter);
}

/**
 * Enforces `lru.budget_bytes` over every `cache` entry's
 * `approxWarmBytes()`: while the sum exceeds budget, evicts
 * (`evictWarmRecords()` -- keeps the `queryEngines` entry and the open
 * database handle; only the decoded corpus is the RAM problem) the
 * least-recently-used workspace per `lru.last_used`, repeating until back
 * under budget or only the single most-recently-used workspace remains
 * cached. The MRU workspace is NEVER evicted by this function, even if it
 * alone still leaves the total over budget -- see
 * `DaemonRuntimeOptions.warm_records_budget_mb`'s own doc comment for why
 * that is an accepted degenerate case, including for `budget_bytes === 0`
 * (every OTHER cached workspace is still evicted; the just-used one is
 * spared until a different workspace becomes the new MRU).
 */
function enforceWarmRecordsBudget(cache: ReadonlyMap<string, CachedWorkspaceQueryEngine>, lru: WarmRecordsLru): void {
  if (cache.size <= 1) return; // nothing else to evict; the sole entry is by definition the MRU
  let total = 0;
  for (const entry of cache.values()) total += entry.snapshot_port.approxWarmBytes();
  if (total <= lru.budget_bytes) return;
  let mruWorkspaceId: string | undefined;
  let mruUsed = -Infinity;
  for (const workspaceId of cache.keys()) {
    const used = lru.last_used.get(workspaceId) ?? -1;
    if (used > mruUsed) { mruUsed = used; mruWorkspaceId = workspaceId; }
  }
  const evictionOrder = [...cache.keys()].filter((workspaceId) => workspaceId !== mruWorkspaceId).sort((left, right) => (lru.last_used.get(left) ?? -1) - (lru.last_used.get(right) ?? -1));
  for (const workspaceId of evictionOrder) {
    if (total <= lru.budget_bytes) break;
    const entry = cache.get(workspaceId);
    if (entry === undefined) continue;
    total -= entry.snapshot_port.approxWarmBytes();
    entry.snapshot_port.evictWarmRecords();
  }
}

async function acquireWorkspaceQueryEngine(workspaceId: string, registry: WorkspaceRegistry, storage: DurableStorage, cursorCache: CursorCache, cache: Map<string, CachedWorkspaceQueryEngine>, interner: RecordBodyInterner, lru: WarmRecordsLru, semanticProvider?: ResolvedSemanticProvider, allowSourceBinding = false): Promise<CachedWorkspaceQueryEngine> {
  const sourceWorkspace = allowSourceBinding ? registry.get(workspaceId) : undefined;
  const resolution = sourceWorkspace !== undefined && sourceWorkspace.status !== "removed"
    ? { workspace_id: workspaceId }
    : resolveIndexStatusRequest(registry, { api_version: 1, workspace_ids: [workspaceId] });
  if ("error" in resolution) throw new DaemonError(resolution.error.code, "The requested query workspace is unavailable.", resolution.error.details);
  const cached = cache.get(resolution.workspace_id);
  if (cached) { touchWarmLru(lru, resolution.workspace_id); return cached; }
  const database = await storage.openWorkspace(resolution.workspace_id);
  // `semanticProvider` (resolved once at `DaemonRuntime.start`, see
  // `DaemonRuntimeOptions.semantic_provider`'s doc comment) is threaded
  // through as the query port's `options.semantic` -- exactly the pair the
  // reconciler embeds and writes vectors under, so `core:search_semantic`/
  // `core:search_hybrid`'s `trySemanticSearch` (`canonical-query-data-port.ts`)
  // only ever compares a query vector against vectors sharing the same
  // profile+binding identity. `undefined` (semantic disabled) leaves the
  // constructor's own default (`{}`, no semantic lane) in effect.
  //
  // `interner` (one shared `RecordBodyInterner` instance per `DaemonRuntime`,
  // see `start()`) lets content-identical records decoded by DIFFERENT
  // workspaces' ports -- typically a forked workspace and its donor -- share
  // one decoded `body` object instead of each port holding its own
  // byte-for-byte duplicate.
  const snapshotPort = new SqliteCanonicalQuerySnapshotPort(database.database, storage.cas, interner);
  const dataPort = new CanonicalRecordQueryDataPort(snapshotPort, semanticProvider === undefined ? undefined : { semantic: semanticProvider });
  const engine = new QueryEngine({ data_port: dataPort, cursor_cache: cursorCache });
  const entry: CachedWorkspaceQueryEngine = { database, engine, data_port: dataPort, snapshot_port: snapshotPort };
  cache.set(resolution.workspace_id, entry);
  touchWarmLru(lru, resolution.workspace_id);
  return entry;
}

/**
 * Fire-and-forget pre-warm of one workspace's cached query engine (see
 * `acquireWorkspaceQueryEngine` above): forces the first `records()`/
 * `capability_states()` load (full reload or delta) and the `identityMaps`
 * memo to happen now, off the request path, so the first real `core:query`
 * against this workspace after a scan publication or a daemon start does
 * not pay that cost inline. Never throws -- failures are logged with the
 * `[urdira]` prefix used by neighboring best-effort code in this file and
 * must never affect the caller (a scan's success, or daemon startup).
 *
 * Also touches the LRU again after the warm settles (`acquireWorkspaceQueryEngine`
 * already touched it once, at acquire time, before the load) and enforces
 * `lru.budget_bytes` -- see `DaemonRuntimeOptions.warm_records_budget_mb`'s
 * own doc comment for the full eviction story, including why the STARTUP
 * prewarm loop additionally checks the budget BEFORE calling this for each
 * workspace (stopping the chain early) rather than relying solely on this
 * function's own post-warm enforcement.
 */
async function warmWorkspaceQueryEngine(workspaceId: string, registry: WorkspaceRegistry, storage: DurableStorage, cursorCache: CursorCache, cache: Map<string, CachedWorkspaceQueryEngine>, interner: RecordBodyInterner, lru: WarmRecordsLru, semanticProvider?: ResolvedSemanticProvider): Promise<void> {
  try {
    const cached = await acquireWorkspaceQueryEngine(workspaceId, registry, storage, cursorCache, cache, interner, lru, semanticProvider);
    await cached.data_port.warm({ scope_type: "single_workspace", workspace_id: workspaceId });
    touchWarmLru(lru, workspaceId);
    enforceWarmRecordsBudget(cache, lru);
  } catch (error) {
    console.error(`[urdira] query cache warm-up failed for ${workspaceId}:`, error);
  }
}

async function detectWorkspacePreview(root: string, catalog: readonly DaemonPluginCatalogEntry[]) {
  const files: Array<{ readonly path: string; readonly content?: string }> = [];
  const walk = async (directory: string, relativeRoot = ""): Promise<void> => {
    let entries: ReadonlyArray<import("node:fs").Dirent<string>>;
    try { entries = await readdir(directory, { encoding: "utf8", withFileTypes: true }) as ReadonlyArray<import("node:fs").Dirent<string>>; } catch { return; }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".urdira") continue;
      const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, relativePath);
      else if (entry.isFile()) {
        const manifest = /(?:package\.json|tsconfig\.json|jsconfig\.json|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml)$/u.test(entry.name);
        if (manifest) {
          const content = await readFile(path, "utf8").catch(() => undefined);
          files.push(content === undefined ? { path: relativePath } : { path: relativePath, content });
        } else files.push({ path: relativePath });
      }
    }
  };
  await walk(root);
  return detectWorkspaceTechnologies({
    provider_fingerprint: workspaceDigest(root),
    git_state_fingerprint: "git:unresolved",
    plugin_catalog_fingerprint: pluginCatalogFingerprint(catalog),
    plugin_catalog: catalog,
    files,
  });
}

async function startWorkspaceWatcher(manager: WorkspaceWatcherManager, workspace: RegisteredWorkspace): Promise<void> {
  try {
    const root = workspace.canonical_root;
    if (!(await stat(root)).isDirectory()) return;
    await manager.start({
      workspace_id: workspace.workspace_id,
      watcher: new ParcelWatcherAdapter({
        workspace_id: workspace.workspace_id,
        source_provider_binding_id: workspace.provider.source_provider_binding_id,
        source_provider: workspace.provider.source_provider,
        source_provider_version: workspace.provider.source_provider_version,
        ordering_domain: `workspace:${workspace.workspace_id}`,
        // `ParcelWatcherAdapter` already logs every watcher error loudly and
        // unconditionally on its own (see its doc comment) and re-arms a
        // fresh subscription; `on_error` here is this daemon's own hook for
        // REACTING to that, not merely observing it. There is no scan-worthy
        // action to take beyond what the adapter's own `provider_reset` hint
        // delivery already triggers (a full reconcile via `on_reconcile`,
        // below), so this is deliberately a plain diagnostic log with the
        // workspace's display root for operators grepping the daemon log --
        // the periodic reconciliation sweep (`DaemonRuntimeOptions.reconciliation_sweep_interval_ms`)
        // is the real backstop if re-arming itself keeps failing.
        root,
        case_sensitive: process.platform !== "win32",
      }, { on_error: (error: Error) => console.error(`[urdira] watcher error for workspace ${workspace.workspace_id} (${workspace.display_root}):`, error) }),
    });
  } catch {
    // A missing or temporarily unavailable root is reconciled on the next
    // daemon restart; registration itself remains durable.
  }
}

function pluginStatusForWorkspace(workspace: RegisteredWorkspace, catalog: readonly DaemonPluginCatalogEntry[], readiness?: WorkspaceReadiness): { readonly plugins: readonly unknown[]; readonly capabilities: readonly unknown[]; readonly structural_progress: readonly WorkspaceStructuralProgressView[] } {
  const active = catalog.filter((plugin) => (workspace.selected_plugin_ids ?? []).includes(plugin.plugin_id));
  return {
    plugins: active.map((plugin) => ({
      plugin_id: plugin.plugin_id,
      plugin_version: plugin.plugin_version,
      activation_status: "active",
      capability_declarations: plugin.capability_declarations,
    })),
    capabilities: active.flatMap((plugin) => plugin.capability_declarations.map((declaration) => ({
      capability: declaration.capability,
      capability_contract_version: declaration.capability_contract_version,
      provider_id: plugin.plugin_id,
      provider_version: plugin.plugin_version,
      status: readiness?.structural_ready ? "complete" : "unknown",
      reason_codes: readiness?.structural_ready ? [] : ["core:analysis_in_progress"],
      affected_artifact_count: 0,
      availability: readiness?.structural_ready ? "available" : "unavailable",
      completeness: readiness?.structural_ready ? "complete" : "unknown",
      build_state: readiness?.structural_ready ? "idle" : "building",
      languages: plugin.plugin_id === "urdira:javascript_typescript" ? ["javascript", "typescript"] : [],
      ...(declaration.publication_stage_id === undefined ? {} : { publication_stage_id: declaration.publication_stage_id }),
      ...(readiness?.retry_after_ms === undefined ? {} : { retry_after_ms: readiness.retry_after_ms }),
    }))),
    structural_progress: active.flatMap((plugin): WorkspaceStructuralProgressView[] => {
      const stages = plugin.structural_stage_definitions ?? [];
      if (stages.length === 0) return [];
      const ordinal = readiness?.structural_stage_ordinal ?? 0;
      const current = stages.find((stage) => stage.ordinal === ordinal);
      return [{ provider_id: plugin.plugin_id, provider_version: plugin.plugin_version, ...(readiness?.source_snapshot_id === undefined ? {} : { source_snapshot_id: readiness.source_snapshot_id }), ...(current === undefined ? {} : { current_stage_id: current.stage_id }), completed_stage_ordinal: Math.min(ordinal, stages.length), stage_count: stages.length, completeness: readiness?.structural_completeness ?? "unknown" }];
    }),
  };
}

/**
 * Opens a `WorkspaceDatabase` handle for one bounded administrative call
 * (`core:repair`, `core:garbage_collect`), registering the workspace in the
 * durable-storage catalog first -- mirroring `scheduleWorkspaceScan`'s own
 * registration step, since a workspace that was only ever `beginReconciliation`-flipped
 * without a completed scan may not have a catalog row yet -- and always
 * closes the handle afterward. This is deliberately an open-then-close-per-call
 * design, unlike `core:query`'s cached-handle-per-workspace design in
 * `acquireWorkspaceQueryEngine`: administrative calls are infrequent and
 * bounded, so there is no cross-call in-memory state (like `core:query_continue`'s
 * manifest store) that a fresh handle would lose. Opening a second handle to
 * a workspace already cached by `acquireWorkspaceQueryEngine` is safe:
 * `DurableStorage`'s workspace lease is keyed by `(workspace_id, owner_id)`
 * with one shared `owner_id` per `DurableStorage` instance, so a second open
 * from the same process increments a handle count instead of conflicting
 * (see `InstallationCatalog.acquireWorkspaceLease` in `packages/storage/src/storage.ts`).
 */
async function withWorkspaceDatabase<T>(workspace: RegisteredWorkspace, storage: DurableStorage, run: (database: WorkspaceDatabase) => Promise<T>): Promise<T> {
  await storage.catalog.registerWorkspace({
    workspace_id: workspace.workspace_id,
    canonical_root: workspace.canonical_root,
    display_root: workspace.display_root,
    source_provider_bindings: [workspace.provider],
    status: "registered",
    registered_at: workspace.registered_at,
  });
  const database = await storage.openWorkspace(workspace.workspace_id);
  try { return await run(database); }
  finally { await database.close().catch(() => undefined); }
}

function selectionHasCompatiblePlugin(technologies: readonly string[], plugins: readonly string[], catalog: readonly DaemonPluginCatalogEntry[]): boolean {
  return technologies.every((technology) => {
    const compatible = catalog.filter((plugin) => plugin.verified && plugin.language_ids.includes(technology));
    return compatible.length === 0 || compatible.some((plugin) => plugins.includes(plugin.plugin_id));
  });
}

export class DaemonRuntime {
  readonly paths: DaemonPaths;
  readonly endpoint: string;
  readonly scheduler: DaemonScheduler;
  readonly recovery: PersistentCursorRecovery;
  readonly recovered_checkpoint: import("./ownership.js").LastKnownGood | undefined;
  readonly recovered_cursor_ids: ReadonlyArray<string>;
  private readonly knownCursorIds: Set<string>;
  private state: DaemonStatus["state"] = "starting";
  private constructor(private readonly options: DaemonRuntimeOptions, paths: DaemonPaths, private readonly lock: ProcessLock, private readonly descriptor: EndpointDescriptorStore, private readonly checkpoint: LastKnownGoodStore, private readonly server: LocalIpcServer, scheduler: DaemonScheduler, recoveredCheckpoint: import("./ownership.js").LastKnownGood | undefined, recovery: PersistentCursorRecovery, recoveredCursorIds: ReadonlyArray<string>, private readonly pendingWarms: ReadonlySet<Promise<void>>, private readonly watcherManager?: WorkspaceWatcherManager, private readonly indexingStorage?: DurableStorage, private readonly queryEnginesForTest?: ReadonlyMap<string, CachedWorkspaceQueryEngine>, private readonly reconciliationSweepTimer?: NodeJS.Timeout, private readonly semanticHost?: NeuralSemanticProviderHost) {
    this.paths = paths; this.endpoint = paths.endpoint; this.scheduler = scheduler; this.recovery = recovery; this.recovered_checkpoint = recoveredCheckpoint; this.recovered_cursor_ids = recoveredCursorIds; this.knownCursorIds = new Set([...recoveredCursorIds, ...(options.known_cursors ?? [])]);
  }
  static async start(options: DaemonRuntimeOptions): Promise<DaemonRuntime> {
    const paths = await daemonPaths(options.data_root);
    const lock = await ProcessLock.acquire(paths.process_lock, { pid: process.pid, started_at: new Date().toISOString() });
    const descriptor = new EndpointDescriptorStore(paths);
    const checkpoint = new LastKnownGoodStore(paths);
    const recovery = new PersistentCursorRecovery(`${paths.data_root}/cursors.json`);
    let server: LocalIpcServer | undefined;
    let indexingStorage: DurableStorage | undefined;
    // Assigned once the `DaemonRuntime` instance exists, below; read by the
    // `core:daemon_stop`/`core:daemon_restart` handlers, which are defined
    // (as part of the IPC `handler` closure) before that instance exists.
    let runtimeHandle: DaemonRuntime | undefined;
    try {
      const previousDescriptor = await descriptor.read();
      if (previousDescriptor && (previousDescriptor.endpoint !== paths.endpoint || (process.platform !== "win32" && previousDescriptor.owner_uid !== (process.getuid?.() ?? 0)))) throw new DaemonError("core:daemon_recovery_failed", "Existing daemon endpoint descriptor is not owned by this user or root.");
      const recoveredCheckpoint = await checkpoint.verify({ engine_build_id: options.engine_build_id });
      const recoveredCursorIds: string[] = [];
      for (const cursorId of recoveredCheckpoint?.cursors ?? []) if (await recovery.load(cursorId)) recoveredCursorIds.push(cursorId);
      if (process.platform !== "win32") await unlink(paths.endpoint).catch(() => undefined);
      const scheduler = new DaemonScheduler(options.scheduler);
      const pluginCatalog = options.plugin_catalog ?? [];
      const runtimeCalls = options.calls ?? {};
      // `@urdira/storage`'s `WorkspaceDatabase` is the real SQLite-backed
      // index that `runFullWorkspaceScan` (`@urdira/engine`) reads and writes;
      // it is completely separate from `workspace_registry`'s lightweight
      // JSON metadata (root path, status, selected plugins). It is only
      // constructed when both a workspace registry and a plugin-provider
      // resolver are supplied, since without either one no workspace can
      // actually be scanned; callers that omit `resolve_plugin_provider`
      // (e.g. tests exercising only the registry/IPC surface) keep today's
      // registry-only, fire-and-forget `beginReconciliation` behavior.
      indexingStorage = options.workspace_registry && options.resolve_plugin_provider
        ? await createDurableStorage({ rootDir: options.data_root })
        : undefined;
      // `core:query`/`core:query_continue` reuse `indexingStorage` to open
      // (and cache, per `acquireWorkspaceQueryEngine` above) the target
      // workspace's `WorkspaceDatabase`, so they are gated on the same
      // condition; without indexed data there is nothing to query anyway.
      // The `CursorCache` signing secret and the per-workspace query-engine
      // cache are both created once here and reused for every query call for
      // the lifetime of this runtime instance (see `createCursorSigningSecret`
      // above for why the secret is process-local, not persisted).
      const cursorCache: CursorCache | undefined = indexingStorage ? new CursorCache({ signing_secret: createCursorSigningSecret() }) : undefined;
      const queryEngines = new Map<string, CachedWorkspaceQueryEngine>();
      // ONE interner and ONE LRU tracker per `DaemonRuntime`, shared by
      // every `SqliteCanonicalQuerySnapshotPort` this process constructs
      // (`acquireWorkspaceQueryEngine`) -- see `RecordBodyInterner`'s own
      // doc comment (cross-workspace decoded-body sharing) and
      // `DaemonRuntimeOptions.warm_records_budget_mb`'s (the LRU byte
      // budget these feed).
      const recordBodyInterner = new RecordBodyInterner();
      const warmRecordsLru: WarmRecordsLru = { last_used: new Map(), counter: 0, budget_bytes: warmRecordsBudgetBytes(options.warm_records_budget_mb) };
      // Real implementations by default; `options.semantic_runtime_hooks`
      // (test-only seam, see `DaemonRuntimeOptions`'s own doc comment)
      // overrides either independently, so a test can inject a hash-provider-
      // backed `build` without also having to fake `ensure`, or vice versa.
      const buildProvider = options.semantic_runtime_hooks?.build ?? buildSemanticProvider;
      const ensureAssets = options.semantic_runtime_hooks?.ensure ?? ensureSemanticAssets;
      const semanticDescriptor = options.semantic_descriptor;
      // Resolved (at most) ONCE per `DaemonRuntime` instance at start, then
      // possibly again exactly once more, later, by
      // `ensureAndActivateSemanticProvider` below -- see
      // `DaemonRuntimeOptions.semantic_provider`/`semantic_descriptor`'s own
      // doc comments for the full precedence and activation story. `let`,
      // not `const`: configure-time provisioning (USER DECISION,
      // 2026-08-13) means a workspace's very first `core:workspace_add` can
      // be the moment semantic search goes from unavailable to active
      // within this same process's lifetime, with no restart. Every
      // semantic-aware call site below (`submitSemanticMaintenance`, the
      // query port construction in `acquireWorkspaceQueryEngine`) reads this
      // variable directly at call time (never a value captured earlier), so
      // once it flips from `undefined` to a real provider, every call made
      // AFTER that point picks it up automatically; `queryEngines` entries
      // already cached from BEFORE that point do not (see
      // `ensureAndActivateSemanticProvider`'s own doc comment for why those
      // are explicitly invalidated on activation instead). `undefined` when
      // `semantic_index: false` (the kill switch) -- no provider is ever
      // constructed, and `ensureAndActivateSemanticProvider` never runs
      // either (there is no descriptor to remember in that case: see below).
      let semanticProvider: ResolvedSemanticProvider | undefined;
      let semanticHost: NeuralSemanticProviderHost | undefined;
      if (options.semantic_index === false) {
        semanticProvider = undefined;
      } else if (options.semantic_provider !== undefined) {
        semanticProvider = options.semantic_provider;
      } else if (semanticDescriptor !== undefined) {
        try {
          if (semanticDescriptor.kind === "neural" && options.semantic_process !== false && options.semantic_runtime_hooks === undefined) {
            semanticHost = await startNeuralSemanticProviderHost(semanticDescriptor);
            semanticProvider = semanticHost.provider;
          } else semanticProvider = await buildProvider(semanticDescriptor);
        } catch (error) {
          // NO download at start, ever -- see `buildSemanticProvider`'s own
          // doc comment (`./semantic-provider-runtime.js`): a `"neural"`
          // descriptor's model that is not yet present offline makes this
          // throw, not fetch it. The daemon starts anyway, semantic
          // effectively unavailable, naming the exact remedy an operator
          // needs to run to fix it -- `semanticDescriptor` itself stays
          // "remembered" (it is a `const`-captured closure variable read by
          // `ensureAndActivateSemanticProvider` below, not discarded here).
          console.warn(`[urdira] the configured local embedding model is not available offline yet -- semantic search stays unavailable until it is provisioned; run "urdira workspace add"/"urdira workspace configure" (or core:configuration_set) to provision it: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          semanticProvider = undefined;
        }
      } else {
        semanticProvider = createLocalHashProvider();
      }
      // Coalesces concurrent `ensureAndActivateSemanticProvider` calls (e.g.
      // two configure RPCs racing) into exactly ONE in-flight
      // ensure-then-maybe-activate attempt, so a `"neural"` descriptor's real
      // model download never runs twice in parallel. Called from each of the
      // three configure-time admin RPC handlers below, after that handler's
      // OWN request validation has already succeeded -- never from daemon
      // start (see the `semanticProvider` resolution above, which never
      // calls this) and never from a scan or a query.
      //
      // Return value (owner decision 2026-08-13, docs/decisions/18-semantic-model-pack.md
      // Outcome): the triggering RPC handler carries this back verbatim as
      // its own response's `semantic_model` field -- `undefined` (field
      // omitted entirely) when this call provisioned nothing (kill switch,
      // no descriptor, or a provider already active from an earlier
      // call/daemon-start success -- see the two early returns below), a
      // `SemanticModelProvisioningNotice` whenever `ensureAssets` actually
      // ran an attempt this call. Every one of this function's callers
      // `await`s it (none backgrounds the ensure), so `"downloading"` is
      // never a value this function itself produces -- by the time it
      // resolves, any download it triggered has already finished, one way
      // or the other; only a genuinely backgrounded future caller would ever
      // need that status.
      let semanticEnsureInFlight: Promise<SemanticModelProvisioningNotice | undefined> | undefined;
      const ensureAndActivateSemanticProvider = (): Promise<SemanticModelProvisioningNotice | undefined> => {
        if (semanticDescriptor === undefined) return Promise.resolve(undefined); // nothing configured to provision (kill switch, or no descriptor at all -- e.g. a bare in-process `semantic_provider` override)
        if (semanticProvider !== undefined) return Promise.resolve(undefined); // already active: an earlier activation, or `options.semantic_provider` already won at start
        if (semanticEnsureInFlight) return semanticEnsureInFlight;
        const run = (async (): Promise<SemanticModelProvisioningNotice | undefined> => {
          // `ensureAssets` (the real `ensureSemanticAssets`, or the test-only
          // `ensure` hook) never rejects -- see its own doc comment: a
          // provisioning failure is reported back as `{ status: "failed" }`
          // data, already `console.warn`ed at its own call site, not an
          // exception this function must catch. `undefined` means nothing to
          // provision (a `"hash"`/`"http"` descriptor); a defined result with
          // `status: "failed"` still returns from here as-is -- the RPC
          // response reports the failure, but structural work never blocks
          // on it (decision 06).
          const ensured = semanticDescriptor.kind === "neural" && options.semantic_runtime_hooks === undefined
            ? semanticHost !== undefined
              ? await semanticHost.ensure() as SemanticModelProvisioningNotice | undefined
              : await ensureSemanticAssetsInProcess(semanticDescriptor) as SemanticModelProvisioningNotice | undefined
            : await ensureAssets(semanticDescriptor);
          if (ensured === undefined || ensured.status === "failed") return ensured;
          if (semanticProvider !== undefined) return ensured; // raced: a concurrent activation already won -- still report what THIS call's own ensure found
          try {
            if (semanticDescriptor.kind === "neural" && options.semantic_process !== false && options.semantic_runtime_hooks === undefined) {
              semanticHost = await startNeuralSemanticProviderHost(semanticDescriptor);
              semanticProvider = semanticHost.provider;
            } else {
              semanticProvider = await buildProvider(semanticDescriptor);
            }
            // Every already-cached `CachedWorkspaceQueryEngine` captured
            // `{semantic: undefined}` (semantic search unavailable) at ITS
            // OWN construction time, inside `acquireWorkspaceQueryEngine`'s
            // `CanonicalRecordQueryDataPort` constructor call -- reassigning
            // the outer `semanticProvider` variable above does not, and
            // cannot, reach back into an already-built `CanonicalRecordQueryDataPort`
            // instance and change what it captured. Evicting every cached
            // entry (closing its handle, best-effort, exactly like
            // `core:workspace_remove`'s identical evict-and-close below)
            // forces the next `core:query`/warm-up for each workspace to
            // call `acquireWorkspaceQueryEngine` again, which reads the NOW-
            // active `semanticProvider` and builds a fresh data port with
            // `{semantic: semanticProvider}` -- so the very next query
            // against ANY workspace serves semantic search, in this same
            // daemon process, with no restart.
            for (const [workspaceId, cached] of queryEngines) {
              queryEngines.delete(workspaceId);
              void cached.database.close().catch(() => undefined);
            }
          } catch (error) {
            // The model asset is now provisioned, but constructing the
            // provider from it still failed (e.g. a corrupt cache entry) --
            // semantic search remains unavailable; a later configure call
            // retries both steps from scratch. The asset itself IS on disk
            // though, so the notice still reports `ensured`'s own
            // present/downloaded status, not "failed" -- this failure is
            // about activation, not provisioning.
            console.warn(`[urdira] the local embedding model is provisioned but constructing the semantic provider from it still failed -- semantic search remains unavailable: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          }
          return ensured;
        })();
        semanticEnsureInFlight = run.finally(() => { semanticEnsureInFlight = undefined; });
        return semanticEnsureInFlight;
      };
      // Tracks every fire-and-forget query-cache warm (scan-completion
      // prewarm and the startup prewarm chain, both below) so `stop()` can
      // await them before closing `indexingStorage`. Without this, a warm's
      // `storage.openWorkspace(...)` can still be in flight when
      // `DurableStorage.close()` iterates its already-opened-workspaces set
      // (see `packages/storage/src/storage.ts`'s `close()`): the workspace
      // opened by the warm resolves too late to be in that snapshot, so its
      // handle is never closed, leaking an open SQLite connection past
      // shutdown. "Fire-and-forget" here means callers of `scheduleWorkspaceScan`
      // and daemon startup never block on a warm, not that a graceful stop
      // may abandon one mid-flight.
      const pendingWarms = new Set<Promise<void>>();
      const trackWarm = (warm: Promise<void>): void => {
        let tracked!: Promise<void>;
        tracked = warm.finally(() => { pendingWarms.delete(tracked); });
        pendingWarms.add(tracked);
      };
      // `core:configuration_set` tracks each workspace's last-applied
      // configuration document in memory so `WorkspaceConfigurationCoordinator.applyConfigDocument`
      // (which classifies `configuration_impact` by diffing against the
      // previous document) has something to diff against. Like the
      // `CursorCache` signing secret above, this is process-local and not
      // persisted: it does not survive a daemon restart. That is a known,
      // narrow gap (a restart forgets the previously applied configuration
      // and treats the next `core:configuration_set` as a diff against an
      // empty document), flagged in the final report rather than silently
      // accepted.
      const workspaceConfigurations = new Map<string, Readonly<Record<string, unknown>>>();
      const configurationCoordinator = new WorkspaceConfigurationCoordinator();
      /**
       * Runs a real full workspace scan in the background and reconciles the
       * workspace registry's status once it settles. Submitted through the
       * scheduler's "structural" pool so the IPC handler that triggered it
       * (`core:workspace_add`, or the watcher's `on_reconcile`) can return
       * immediately with `status: "indexing"`; this function never throws
       * and never leaves the scheduled job's promise rejected, since nothing
       * awaits it.
       *
       * Failure semantics: `WorkspaceRegistry#markReady` (see
       * `packages/engine/src/workspaces.ts`) requires a non-empty snapshot id
       * for *both* `"ready"` and `"degraded"` -- there is no closed-union
       * status for "indexing failed, and there was never a prior snapshot".
       * So: on success, mark `"ready"` with the new snapshot. On failure
       * (scan threw, or no compatible plugin was resolved), if the workspace
       * already had a prior snapshot (this was a reconciliation of a
       * previously-ready workspace), fall back to `"degraded"` with that
       * prior snapshot so the workspace stays queryable and leaves
       * `"indexing"`. If there was never a prior snapshot (first-ever index
       * attempt), the workspace has no non-stuck state available under the
       * current `WorkspaceRegistry` API without inventing one, so it remains
       * `"indexing"` and a future reconciliation attempt is the only way out.
       * This is a known limitation flagged in this change's final report,
       * not a silent gap: it is strictly no worse than today's behavior
       * (where every scan attempt is permanently stuck), and every
       * newly-succeeding workspace now reaches `"ready"`.
       */
      // Guards against two scans of the SAME workspace running concurrently.
      // `scheduleWorkspaceScan` can be invoked multiple times in quick
      // succession for one workspace (e.g. two rapid watcher reconcile
      // events, or a watcher event racing an explicit `core:reindex`); with
      // `pool_concurrency.structural` now configurable above 1 (see
      // `URDIRA_STRUCTURAL_CONCURRENCY` in `apps/urdira`), the scheduler can
      // genuinely run two "structural" jobs at once, and nothing else in
      // `run` below prevents two such jobs for the same workspace id from
      // both passing the `workspace.status !== "indexing"` check and both
      // opening/writing the same `WorkspaceDatabase` at the same time --
      // which `runFullWorkspaceScan`/`CandidateIndexer` do not tolerate (two
      // concurrent candidate generations racing the same source index and
      // publication tables). This set is checked and updated synchronously
      // around `scheduler.submit`, so it closes the race even though the
      // scheduler may not start the job immediately. A request that arrives
      // while a scan is already in flight is simply dropped (not queued for
      // an immediate follow-up scan): the in-flight scan already reads
      // current on-disk state, and any change that lands after that read but
      // before this guard would have dropped the request anyway is picked up
      // by the next reconciliation trigger, consistent with the bounded
      // (not instant) freshness the rest of this file already accepts
      // elsewhere (e.g. crash recovery's full-rescan retry, above).
      const scanInFlight = new Set<string>();
      // Tracks the currently in-flight THREADED lexical maintenance run (if
      // any) per workspace -- `submitLexicalMaintenance` below adds an entry
      // right before starting a threaded run and removes it once that run's
      // `result` settles. `scheduleWorkspaceScan` aborts whatever entry
      // exists here the moment a fresh scan starts for the same workspace
      // (see below): a lexical worker's own write transactions are the only
      // other writer of `lexical_documents`/`lexical_trigrams`/`lexical_index_state`,
      // but they share the SAME on-disk workspace database file as the
      // scan's publish transaction, protected cross-thread only by SQLite's
      // WAL + `BEGIN IMMEDIATE` + `busy_timeout` (see `packages/storage/src/storage.ts`'s
      // `SerializedWriter` doc comment for why an in-process mutex cannot
      // help here) -- pre-empting a stale lexical build as soon as its
      // generation is about to become outdated anyway avoids it holding that
      // write lock against the scan's own publish. A no-op when
      // `lexical_thread` is off (the in-process path never populates this
      // map) or when nothing is currently running for this workspace.
      const lexicalThreadRuns = new Map<string, LexicalThreadRun>();
      // SEMANTIC sibling of `lexicalThreadRuns` immediately above -- same
      // doc comment, same reasoning, one layer over: tracks the currently
      // in-flight THREADED semantic maintenance run (if any) per workspace,
      // so `scheduleWorkspaceScan` can pre-empt it the moment a fresh scan
      // starts for the same workspace, before the scan's own publish
      // transaction has to contend with a semantic worker's write
      // transactions against the SAME on-disk `vector_projection_rows`/
      // `semantic_index_state` tables. A no-op when `semantic_thread` is
      // off, when the active provider resolved from an instance override or
      // test hooks (see `DaemonRuntimeOptions.semantic_thread`'s doc
      // comment -- the in-process path never populates this map either
      // way), or when nothing is currently running for this workspace.
      const semanticThreadRuns = new Map<string, SemanticProcessRun>();
      // Hints (Phase 5's changed-path plumbing, `WorkspaceWatcherManagerOptions.on_reconcile`,
      // `packages/engine/src/watchers.ts`) that arrived for a workspace while
      // its scan was already running: `full: true` means at least one of the
      // coalesced requests carried no hint (an unsafe/full-rescan reason, or
      // a caller that predates hinting) and the follow-up scan must not
      // narrow anything; otherwise `uris` is the union of every coalesced
      // request's changed URIs. Previously (Phase 4) a request that arrived
      // while a scan was in flight was simply dropped; now that `on_reconcile`
      // fires for every ordinary watch batch (not only the unsafe ones), a
      // dropped request could mean a real edit is never rescanned at all, so
      // it is coalesced into exactly one guaranteed follow-up scan instead.
      const pendingScans = new Map<string, { full: boolean; uris: Set<string> }>();
      const scheduleWorkspaceScan = (workspaceId: string, changedUris?: readonly string[]): void => {
        const registry = options.workspace_registry;
        const resolvePluginProvider = options.resolve_plugin_provider;
        const durableStorage = indexingStorage;
        if (!registry || !resolvePluginProvider || !durableStorage) return;
        if (scanInFlight.has(workspaceId)) {
          const pending = pendingScans.get(workspaceId) ?? { full: false, uris: new Set<string>() };
          if (changedUris === undefined) pending.full = true;
          else for (const uri of changedUris) pending.uris.add(uri);
          pendingScans.set(workspaceId, pending);
          return;
        }
        scanInFlight.add(workspaceId);
        // Pre-empt a stale in-flight threaded lexical build (see
        // `lexicalThreadRuns`'s doc comment above) as early as possible --
        // before this scan is even admitted to the scheduler -- rather than
        // waiting for it to actually start running.
        lexicalThreadRuns.get(workspaceId)?.abort();
        // Same pre-emption, same rationale, for a threaded semantic
        // maintenance run -- see `semanticThreadRuns`'s doc comment above.
        semanticThreadRuns.get(workspaceId)?.abort();
        try {
          scheduler.submit({
            job_id: `workspace-scan:${workspaceId}:${randomUUID()}`,
            client_id: "core:workspace_indexing",
            workspace_id: workspaceId,
            pool: "structural",
            run: async () => {
              try {
                const workspace = registry.get(workspaceId);
                if (!workspace || workspace.status !== "indexing") return undefined;
                const priorSnapshotId = workspace.current_snapshot_id;
                let database: WorkspaceDatabase | undefined;
                try {
                  await durableStorage.catalog.registerWorkspace({
                    workspace_id: workspace.workspace_id,
                    canonical_root: workspace.canonical_root,
                    display_root: workspace.display_root,
                    source_provider_bindings: [workspace.provider],
                    status: "registered",
                    registered_at: workspace.registered_at,
                  });
                  database = await durableStorage.openWorkspace(workspaceId);
                  const plugin = await resolvePluginProvider(workspace, database);
                  if (!plugin) {
                    // Generic source discovery is useful without a language
                    // plugin. Leave the registry in indexing state (there is
                    // intentionally no structural snapshot to mark ready),
                    // while the durable source catalog becomes queryable via
                    // API v2 source bindings.
                    await runSourceOnlyWorkspaceScan({
                      root: workspace.canonical_root,
                      database,
                      workspace_id: workspaceId,
                      inclusion_rules: { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", ".urdira/**"], allow_external_root: false },
                      ...(options.scan_budget === undefined ? {} : { scan_budget: options.scan_budget }),
                      ...(options.scan_io_concurrency === undefined ? {} : { io_concurrency: options.scan_io_concurrency }),
                    });
                    console.error(`[urdira] source catalog ready for ${workspaceId}; no compatible language plugin is active`);
                    return undefined;
                  }
                  // Workspace fork (docs/decisions/12-workspace-fork.md): on a
                  // genuine first-ever scan (no prior published snapshot) of a
                  // freshly added workspace, attempt to bootstrap it from a
                  // content-identical `ready` donor on the same installation
                  // instead of a full plugin-analysis scan. `attemptWorkspaceFork`
                  // never throws (every failure mode returns `{status:"skipped"}`)
                  // and only ever writes to `database` -- the workspace's own,
                  // otherwise-empty database, so a skipped/failed attempt leaves
                  // nothing behind that `runFullWorkspaceScan` below cannot
                  // safely build on top of (worst case: its own stage-1 source
                  // cataloging finds this attempt's work already durably
                  // cataloged, and republishes an equivalent generation).
                  // `URDIRA_WORKSPACE_FORK=0` (kill switch, default ON) disables
                  // this entirely -- see `DaemonRuntimeOptions.workspace_fork`.
                  if (priorSnapshotId === undefined && options.workspace_fork !== false) {
                    try {
                      const forkOutcome = await attemptWorkspaceFork({ workspace, database, storage: durableStorage, registry, plugin, ...(options.workspace_fork_verify === undefined ? {} : { verify_mode: options.workspace_fork_verify }) });
                      if (forkOutcome.status === "forked") {
                        registry.markReady(workspaceId, forkOutcome.snapshot_id, "ready");
                        submitLexicalMaintenance(workspaceId);
                        submitSemanticMaintenance(workspaceId);
                        return undefined;
                      }
                      console.error(`[urdira] workspace fork skipped for ${workspaceId}, falling back to a full scan: ${forkOutcome.reason}`);
                    } catch (error) {
                      console.error(`[urdira] workspace fork attempt for ${workspaceId} threw, falling back to a full scan:`, error);
                    }
                  }
                  const result = await runProgressiveWorkspaceScan({
                    root: workspace.canonical_root,
                    database,
                    workspace_id: workspaceId,
                    plugin,
                    inclusion_rules: { include: [], exclude: ["node_modules/**", ".git/**", "dist/**", ".urdira/**"], allow_external_root: false },
                    ...(options.scan_budget === undefined ? {} : { scan_budget: options.scan_budget }),
                    ...(options.scan_io_concurrency === undefined ? {} : { io_concurrency: options.scan_io_concurrency }),
                    on_stage_published: (stage, stageResult) => {
                      if (stage.ordinal < stage.stage_count) registry.markStructuralStagePublished(workspaceId, stageResult.snapshot_id);
                    },
                  });
                  registry.markReady(workspaceId, result.snapshot_id, "ready");
                  // Do not start the full query-corpus prewarm here. Source-
                  // safe requests (including benchmark artifact discovery)
                  // are allowed as soon as the source snapshot is published,
                  // and must not queue behind a records()/capability_states()
                  // load on the same SQLite worker. The startup prewarm chain
                  // below still warms already-ready workspaces sequentially;
                  // a later structural query can also populate this cache on
                  // demand. Keeping publication and first-query admission
                  // independent avoids a 30s IPC timeout during structural
                  // warm-up without weakening readiness or completeness.
                  // D5: submit the post-ready lexical maintenance job (own
                  // scheduler entry, own try/catch inside `submitLexicalMaintenance`)
                  // so `core:search_text` pushdown catches up with this scan's
                  // published generation. Never awaited here for the same
                  // reason as the query-cache warm above: it must not delay
                  // this scan's own success return, and its failure must never
                  // turn this scan into a failure.
                  submitLexicalMaintenance(workspaceId);
                  submitSemanticMaintenance(workspaceId);
                } catch (error) {
                  // A first-ever scan failure leaves the workspace "indexing" with
                  // no visible failure state, so the error must at least reach
                  // stderr or the failure is completely undiagnosable.
                  console.error(`[urdira] workspace scan failed for ${workspaceId}:`, error);
                  // Record the failure BEFORE re-pinning to "degraded" below:
                  // `markReady(..., "degraded")` preserves whatever
                  // `last_scan_error`/`last_scan_error_at` are already on the
                  // workspace (see its doc comment), so this order is what
                  // makes the failure survive the re-pin instead of being
                  // silently dropped. Without this, a workspace wedged by the
                  // delete-then-restore `publication_conflict` loop (or any
                  // other scan failure) would keep reporting
                  // `freshness_status: "current"` forever even though it is
                  // serving `priorSnapshotId` on repeat.
                  try { registry.recordScanFailure(workspaceId, scanFailureErrorCode(error)); } catch { /* superseded by a concurrent scan or lifecycle change */ }
                  if (priorSnapshotId !== undefined) {
                    try { registry.markReady(workspaceId, priorSnapshotId, "degraded"); } catch { /* superseded by a concurrent scan or lifecycle change */ }
                  }
                } finally {
                  if (database) await database.close().catch(() => undefined);
                }
                return undefined;
              } finally {
                scanInFlight.delete(workspaceId);
                // Run exactly one coalesced follow-up scan for every hint that
                // arrived while this scan was in flight, instead of dropping
                // them (see `pendingScans` above). The scan that just finished
                // already called `registry.markReady(...)` (success) or left
                // the workspace `"degraded"`/`"indexing"` (failure) above --
                // either way its status is no longer necessarily `"indexing"`,
                // which is exactly what the coalesced follow-up job's own
                // `workspace.status !== "indexing"` guard (top of this `run`)
                // requires to actually do anything. Re-open reconciliation
                // here, synchronously before resubmitting, so that guard sees
                // what it should: a rescan is still owed for whatever
                // arrived while this one was running.
                const pending = pendingScans.get(workspaceId);
                if (pending) {
                  pendingScans.delete(workspaceId);
                  try { registry.beginReconciliation(workspaceId); } catch { /* the workspace was removed while this scan ran */ }
                  scheduleWorkspaceScan(workspaceId, pending.full ? undefined : [...pending.uris]);
                }
              }
            },
          });
        } catch {
          // Scheduler admission failure (quota exhausted, or the daemon is
          // stopping): the workspace stays "indexing"; a future
          // reconciliation attempt (watcher event or `workspace add`) retries.
          scanInFlight.delete(workspaceId);
        }
      };
      // D5: post-ready lexical maintenance (`reconcileLexicalProjection`,
      // `@urdira/engine`'s `lexical-reconciler.ts`), submitted after every
      // successful scan (see `scheduleWorkspaceScan`'s `run`, above). Per-
      // workspace in-flight coalescing mirrors `pendingScans` above: a
      // maintenance request that arrives while one is already running for the
      // same workspace is not dropped, but coalesced into exactly one
      // guaranteed follow-up run afterward (which will see whatever generation
      // is current by then). `options.lexical_index === false` is the only
      // thing that disables this -- `undefined` (the field omitted) defaults
      // to ON, per `DaemonRuntimeOptions.lexical_index`'s doc comment.
      const lexicalMaintenanceInFlight = new Set<string>();
      const lexicalMaintenancePending = new Set<string>();
      const submitLexicalMaintenance = (workspaceId: string): void => {
        if (options.lexical_index === false) return;
        const durableStorage = indexingStorage;
        if (!durableStorage) return;
        if (lexicalMaintenanceInFlight.has(workspaceId)) { lexicalMaintenancePending.add(workspaceId); return; }
        lexicalMaintenanceInFlight.add(workspaceId);
        try {
          scheduler.submit({
            job_id: `lexical-maintenance:${workspaceId}:${randomUUID()}`,
            client_id: "core:lexical_maintenance",
            workspace_id: workspaceId,
            pool: "structural",
            run: async () => {
              let database: WorkspaceDatabase | undefined;
              try {
                // See `DaemonRuntimeOptions.lexical_thread`'s doc comment:
                // default ON, a kill switch. The threaded path never opens
                // `database` on this thread at all -- `runLexicalReconcileInThread`
                // opens its own narrowly-scoped `DurableStorage` inside the
                // worker (see `lexical-worker-thread.ts`) -- so `database`
                // stays `undefined` and the `finally` below's close is a
                // no-op for that path.
                if (options.lexical_thread !== false) {
                  const threadRun = runLexicalReconcileInThread({ data_root: options.data_root, workspace_id: workspaceId });
                  lexicalThreadRuns.set(workspaceId, threadRun);
                  try {
                    await threadRun.result;
                  } finally {
                    // Only delete this run's own entry: `scheduleWorkspaceScan`'s
                    // abort call and a coalesced re-submission below can race
                    // a NEWER threaded run into this same map slot before this
                    // `finally` runs.
                    if (lexicalThreadRuns.get(workspaceId) === threadRun) lexicalThreadRuns.delete(workspaceId);
                  }
                } else {
                  database = await durableStorage.openWorkspace(workspaceId);
                  await reconcileLexicalProjection({ database, workspace_id: workspaceId, content: durableStorage.cas });
                }
              } catch (error) {
                // Best-effort: a maintenance failure must never affect scan
                // success or leave the workspace un-queryable -- it only means
                // `core:search_text` pushdown stays unavailable for this
                // workspace until a later run (the next scan's own success, or
                // a coalesced retry below) succeeds.
                console.error(`[urdira] lexical maintenance failed for ${workspaceId}:`, error);
              } finally {
                if (database) await database.close().catch(() => undefined);
                lexicalMaintenanceInFlight.delete(workspaceId);
                if (lexicalMaintenancePending.delete(workspaceId)) submitLexicalMaintenance(workspaceId);
              }
              return undefined;
            },
          });
        } catch {
          // Scheduler admission failure (quota exhausted, or the daemon is
          // stopping): drop this attempt; the next successful scan retries.
          lexicalMaintenanceInFlight.delete(workspaceId);
        }
      };
      // D-slice: post-ready SEMANTIC maintenance (`reconcileSemanticProjection`,
      // `@urdira/engine`'s `semantic-reconciler.ts`), submitted from the same
      // three call sites as `submitLexicalMaintenance` above (post-fork,
      // post-scan, and the startup ready/degraded loop below) and mirroring
      // its per-workspace in-flight/pending coalescing exactly, down to the
      // scheduler-admission catch. `options.semantic_index === false` (via
      // `semanticProvider` being `undefined` -- see its own doc comment)
      // disables this entirely, same convention as `lexical_index`.
      //
      // SUPERSEDED (2026-08-13, this comment kept for history per
      // docs/decisions/16-semantic-search-wiring.md's own convention): this
      // used to say there was no dedicated `node:worker_threads` variant
      // here, reasoning that the bundled default provider's cheap,
      // allocation-light per-document CPU work (`createLocalHashProvider`'s
      // regex tokenize + two FNV-1a hashes + a 256-bucket accumulation) was
      // nowhere near the cost of a whole-project TypeScript build (the
      // reason `analysisThreadEnabled` exists) or lexical trigram extraction
      // (the reason `lexical_thread` exists). That reasoning held only for
      // the hash provider; the shipped default is now a real ONNX model
      // (`@urdira/embedding-local`'s `createLocalNeuralProvider`, reached
      // through a `"neural"` `semantic_descriptor`), and a real installation
      // measured 5-20s of `core:query` latency against OTHER workspaces
      // while one workspace fleet-embedded in-process -- ONNX tensor
      // preparation and inference on the main thread, not yielding between
      // documents the way pure-JS work does. `submitSemanticMaintenance`
      // now takes the threaded path (`runSemanticReconcileInThread`,
      // `./semantic-thread.js`) whenever `semanticThreadEligible` below is
      // true -- see `DaemonRuntimeOptions.semantic_thread`'s doc comment for
      // the full routing rule (instance overrides and injected test hooks
      // always stay in-process; only a plain `semantic_descriptor`
      // resolution can run on a thread, since only that path has something
      // fully serializable to hand across the worker boundary).
      const semanticThreadEligible = (options.semantic_process ?? options.semantic_thread ?? true) !== false && semanticDescriptor !== undefined && options.semantic_provider === undefined && options.semantic_runtime_hooks === undefined;
      const semanticMaintenanceInFlight = new Set<string>();
      const semanticMaintenancePending = new Set<string>();
      // Served verbatim by `core:index_status`'s `semantic_materializations`
      // field below -- updated after EVERY `reconcileSemanticProjection`
      // completion, including its own already-complete fast path (see
      // `semanticMaterializationView`'s doc comment above for why that still
      // produces a meaningful view). Process-local, like `workspaceConfigurations`
      // above: does not survive a daemon restart, which simply means the view
      // is absent (an empty array, per the `:783` short `core:index_status`
      // path and this map's own `.get(...)` miss) until the startup semantic
      // maintenance pass (below) re-populates it -- itself typically a fast-
      // path hit costing two point lookups, not a real re-embed.
      const semanticMaterializations = new Map<string, SemanticMaterializationStatusView>();
      const submitSemanticMaintenance = (workspaceId: string): void => {
        // Snapshot the currently-active provider into a `const` local: `semanticProvider`
        // is a `let` that `ensureAndActivateSemanticProvider` may reassign
        // concurrently (see its own doc comment), so TypeScript cannot narrow
        // the outer variable itself across the `async` closure below --
        // capturing it here also means this ONE maintenance pass embeds
        // under a single, fixed provider identity for its entire run, even
        // if activation happens to land mid-pass, which is the correct
        // behavior regardless of the type-narrowing reason for doing it.
        const provider = semanticProvider;
        if (provider === undefined) return;
        const durableStorage = indexingStorage;
        if (!durableStorage) return;
        if (semanticMaintenanceInFlight.has(workspaceId)) { semanticMaintenancePending.add(workspaceId); return; }
        semanticMaintenanceInFlight.add(workspaceId);
        try {
          scheduler.submit({
            job_id: `semantic-maintenance:${workspaceId}:${randomUUID()}`,
            client_id: "core:semantic_maintenance",
            workspace_id: workspaceId,
            pool: "semantic",
            run: async () => {
              let database: WorkspaceDatabase | undefined;
              try {
                // `semanticThreadEligible` (see its own doc comment above)
                // is computed once from `options` at runtime construction,
                // so it never changes across calls -- when true, this pass
                // ALWAYS runs threaded, and the in-process branch below is
                // dead for this runtime instance; when false (an instance
                // override or test hooks are in play), it ALWAYS runs
                // in-process. `database` stays `undefined` on the threaded
                // branch -- `runSemanticReconcileInThread` opens its own
                // narrowly-scoped `DurableStorage` inside the worker (see
                // `semantic-worker-thread.ts`) -- so the `finally` below's
                // close is a no-op there, exactly like `submitLexicalMaintenance`'s
                // identical `lexical_thread` branch.
                let reconciled: ReconcileSemanticProjectionResult;
                if (semanticThreadEligible) {
                  const threadRun = runSemanticReconcileInProcess({ data_root: options.data_root, workspace_id: workspaceId, descriptor: semanticDescriptor!, ...(options.semantic_embed_batch_size === undefined ? {} : { embed_batch_size: options.semantic_embed_batch_size }) });
                  semanticThreadRuns.set(workspaceId, threadRun);
                  try {
                    reconciled = await threadRun.result;
                  } finally {
                    // Only delete this run's own entry: `scheduleWorkspaceScan`'s
                    // abort call and a coalesced re-submission below can race
                    // a NEWER threaded run into this same map slot before this
                    // `finally` runs.
                    if (semanticThreadRuns.get(workspaceId) === threadRun) semanticThreadRuns.delete(workspaceId);
                  }
                } else {
                  database = await durableStorage.openWorkspace(workspaceId);
                  const waitForQueryDrain = async (): Promise<void> => {
                    while (scheduler.hasQueryPressure()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
                  };
                  reconciled = await reconcileSemanticProjection({ database, workspace_id: workspaceId, content: durableStorage.cas, provider, wait_for_query_drain: waitForQueryDrain, ...(options.semantic_embed_batch_size === undefined ? {} : { embed_batch_size: options.semantic_embed_batch_size }) });
                }
                const workspace = options.workspace_registry?.get(workspaceId);
                semanticMaterializations.set(workspaceId, semanticMaterializationView(workspaceId, reconciled, provider, workspace?.current_snapshot_id ?? ""));
              } catch (error) {
                // Best-effort: same reasoning as `submitLexicalMaintenance`'s
                // identical catch -- a maintenance failure must never affect
                // scan success or leave the workspace un-queryable; it only
                // means `core:search_semantic`/`core:search_hybrid` stay
                // unavailable (or `"degraded"`) for this workspace until a
                // later run (the next scan's own success, or a coalesced
                // retry below) succeeds.
                console.error(`[urdira] semantic maintenance failed for ${workspaceId}:`, error);
              } finally {
                if (database) await database.close().catch(() => undefined);
                semanticMaintenanceInFlight.delete(workspaceId);
                if (semanticMaintenancePending.delete(workspaceId)) submitSemanticMaintenance(workspaceId);
              }
              return undefined;
            },
          });
        } catch {
          // Scheduler admission failure (quota exhausted, or the daemon is
          // stopping): drop this attempt; the next successful scan/fork/
          // startup pass retries.
          semanticMaintenanceInFlight.delete(workspaceId);
        }
      };
      // Crash recovery: a workspace left `"indexing"` by a prior process life
      // (killed, crashed, `kill -9`'d, etc.) is otherwise permanently stuck --
      // nothing else ever retries it, since `scheduleWorkspaceScan` is only
      // ever invoked by an explicit client action (watcher reconciliation,
      // `core:workspace_add`, `core:configuration_set`, `core:reindex`).
      // Retry every such workspace once storage and the scan scheduler are
      // ready. This is a full-rescan retry, not partial-progress resumption:
      // `runFullWorkspaceScan`/`CandidateIndexer` (`packages/engine/src/workspace-indexing-session.ts`,
      // not modified by this change) do not currently expose recovery
      // semantics for resuming a partially completed scan, so a fresh full
      // scan is the simplest correct retry. Flagged as a known limitation in
      // the final report, not a silent shortcut: a very large workspace pays
      // for a full rescan after every crash instead of resuming near where
      // it left off.
      for (const workspace of options.workspace_registry?.list() ?? []) {
        if (workspace.status === "indexing") scheduleWorkspaceScan(workspace.workspace_id);
      }
      // Startup prewarm: every already-queryable workspace ("ready" or
      // "degraded") left over from a prior process life still has an empty
      // in-memory records cache in this fresh process, so its first
      // `core:query` would otherwise pay the full reload cost inline. Warm
      // them in the background, one at a time (not `Promise.all`) so a
      // daemon restart with many indexed workspaces does not launch a
      // thundering herd of full corpus loads competing for the same SQLite
      // connections and CPU; each is independently best-effort via
      // `warmWorkspaceQueryEngine`'s own try/catch, so one failing workspace
      // does not stop the rest of the chain. Silently does nothing if the
      // registry/storage/cursor-cache options this needs were never
      // supplied (mirrors `scheduleWorkspaceScan`'s own guard).
      //
      // Stops warming FURTHER workspaces once `warmRecordsLru.budget_bytes`
      // is already reached (checked BEFORE each iteration, so the loop still
      // warms at least one workspace even at a very small budget) --
      // workspaces beyond that point stay cold and load on first query (the
      // existing, already-accepted cold path) rather than paying a warm-up
      // that `warmWorkspaceQueryEngine`'s own post-warm `enforceWarmRecordsBudget`
      // call would just immediately evict again. A workspace scanned or
      // fork-completed while this chain is still running is intentionally
      // left cold so its first source-safe request cannot queue behind a
      // full corpus load on the same SQLite worker.
      if (options.workspace_registry && indexingStorage && cursorCache) {
        const registry = options.workspace_registry;
        const storage = indexingStorage;
        const cache = cursorCache;
        const warmableWorkspaceIds = registry.list().filter((workspace) => workspace.status === "ready" || workspace.status === "degraded").map((workspace) => workspace.workspace_id);
        trackWarm((async () => {
          for (const workspaceId of warmableWorkspaceIds) {
            if (queryEngines.size > 0) {
              let warmTotal = 0;
              for (const entry of queryEngines.values()) warmTotal += entry.snapshot_port.approxWarmBytes();
              if (warmTotal >= warmRecordsLru.budget_bytes) break;
            }
            await warmWorkspaceQueryEngine(workspaceId, registry, storage, cache, queryEngines, recordBodyInterner, warmRecordsLru, semanticProvider);
          }
        })());
        // Startup lexical maintenance: `submitLexicalMaintenance` otherwise
        // only ever fires from a scan's own success path, so a workspace
        // indexed in a prior process life (or one whose maintenance run was
        // cut off by a daemon stop before its completion marker landed) would
        // stay on the `core:search_text` corpus-scan fallback until its next
        // rescan -- which a stable, unedited repository may never trigger.
        // `reconcileLexicalProjection` early-returns when its completion
        // marker already matches the current generation, so re-submitting for
        // every ready workspace on startup costs two point lookups per
        // workspace in the common already-complete case.
        for (const workspaceId of warmableWorkspaceIds) submitLexicalMaintenance(workspaceId);
        // Startup semantic maintenance: same rationale as the lexical
        // maintenance loop immediately above, one layer over --
        // `reconcileSemanticProjection` has the identical already-complete
        // fast path (`semanticIndexState()` matching generation AND provider
        // identity), so re-submitting for every ready workspace on startup is
        // cheap in the common case and only does real work when a prior
        // process life left this workspace's vectors genuinely behind.
        for (const workspaceId of warmableWorkspaceIds) submitSemanticMaintenance(workspaceId);
      }
      const watcherManager = options.workspace_registry ? new WorkspaceWatcherManager({
        on_reconcile: async (workspaceId, changedUris) => {
          try { options.workspace_registry?.beginReconciliation(workspaceId); scheduleWorkspaceScan(workspaceId, changedUris); } catch { /* removed workspaces are ignored */ }
        },
      }) : undefined;
      server = new LocalIpcServer({ endpoint: paths.endpoint, ...(options.max_frame_bytes === undefined ? {} : { max_frame_bytes: options.max_frame_bytes }), handler: async (request, context) => {
        if (request.call === "core:status") return { state: "ready", pid: process.pid, engine_build_id: options.engine_build_id, endpoint: paths.endpoint, active_jobs: scheduler.activeCount, restart_leases: scheduler.restartLeaseCount } satisfies DaemonStatus;
        if (request.call === "core:index_status" && options.workspace_status) return options.workspace_status(request, context);
        if (request.call === "core:index_status" && options.workspace_registry) {
          const payload = request.payload !== null && typeof request.payload === "object" ? request.payload as { readonly api_version?: unknown; readonly workspace_ids?: unknown; readonly workspace_root?: unknown } : {};
          const apiVersion = typeof payload.api_version === "number" ? payload.api_version : 1;
          const workspaceIds = Array.isArray(payload.workspace_ids) ? payload.workspace_ids.filter((value): value is string => typeof value === "string") : [];
          if (apiVersion === 1 && workspaceIds.length === 0) return { workspaces: options.workspace_registry.list().map((workspace) => ({ workspace_id: workspace.workspace_id, display_root: basename(workspace.display_root), workspace_status: workspace.status, freshness_status: workspaceFreshnessStatus(workspace), ...(workspace.last_scan_error === undefined ? {} : { last_scan_error_code: workspace.last_scan_error }), ...(workspace.last_scan_error_at === undefined ? {} : { last_scan_error_at: workspace.last_scan_error_at }), configuration_issues: [] })) };
          const buildStatusView = async (workspace: RegisteredWorkspace) => {
            const readiness = await workspaceReadiness(workspace, indexingStorage, semanticMaterializations, scanInFlight.has(workspace.workspace_id));
            const pluginStatus = pluginStatusForWorkspace(workspace, pluginCatalog, readiness);
            return { workspace_id: workspace.workspace_id, display_root: basename(workspace.display_root), workspace_status: workspace.status, startup_phase: workspace.status === "registering" ? "reconciling_sources" : readiness.source_ready && !readiness.structural_ready ? "publishing_structural" : "ready", ...(workspace.current_snapshot_id === undefined ? {} : { current_snapshot_id: workspace.current_snapshot_id }), freshness_status: workspaceFreshnessStatus(workspace), ...(workspace.last_scan_error === undefined ? {} : { last_scan_error_code: workspace.last_scan_error }), ...(workspace.last_scan_error_at === undefined ? {} : { last_scan_error_at: workspace.last_scan_error_at }), plugins: pluginStatus.plugins, capabilities: pluginStatus.capabilities, structural_progress: pluginStatus.structural_progress, semantic_materializations: semanticMaterializations.get(workspace.workspace_id) === undefined ? [] : [semanticMaterializations.get(workspace.workspace_id)!], configuration_issues: [], ...readinessPayload(readiness) };
          };
          if (apiVersion === 3 && workspaceIds.length === 0 && payload.workspace_root === undefined) return { workspaces: await Promise.all(options.workspace_registry.list().map(buildStatusView)) };
          const resolution = resolveIndexStatusRequest(options.workspace_registry, { api_version: apiVersion, workspace_ids: workspaceIds, ...(typeof payload.workspace_root === "string" ? { workspace_root: payload.workspace_root } : {}) });
          if ("error" in resolution) throw new DaemonError(resolution.error.code, "Workspace index status is unavailable.", resolution.error.details);
          const workspace = options.workspace_registry.get(resolution.workspace_id);
          if (workspace === undefined) return { workspaces: [] };
          return { workspaces: [await buildStatusView(workspace)] };
        }
        const queryStorage = indexingStorage;
        if ((request.call === "core:query" || request.call === "core:query_continue") && options.workspace_registry && queryStorage && cursorCache) {
          const registry = options.workspace_registry;
          const storage = queryStorage;
          const cache = cursorCache;
          const workspaceId = singleWorkspaceScopeId(request.payload);
          if (workspaceId === undefined) throw new DaemonError("core:ipc_request_invalid", `${request.call} requires an explicit single_workspace scope.`);
          const queryJob = scheduler.submit({
            job_id: `query:${workspaceId}:${randomUUID()}`,
            client_id: "core:query",
            workspace_id: workspaceId,
            pool: "query",
            run: async () => {
          const requiredStructuralStage = request.call === "core:query" ? operationRequiredStructuralStage(request.payload) : 0;
          if (request.call === "core:query" && requiredStructuralStage > 0) {
            const registered = registry.get(workspaceId);
            if (registered !== undefined) {
              const readiness = await workspaceReadiness(registered, storage, semanticMaterializations, scanInFlight.has(workspaceId));
              // Retained pre-source-first workspaces may have a valid
              // structural snapshot but no durable source-index state yet.
              // API v1/v2 must keep their historical structural-snapshot
              // behavior; v3 readiness remains honest and reports that the
              // source layer is unavailable until a source reconciliation
              // publishes its catalog.
              const legacyStructuralSnapshotAvailable = request.payload !== null
                && typeof request.payload === "object"
                && (request.payload as { readonly api_version?: unknown }).api_version !== 3
                && registered.current_snapshot_id !== undefined
                && (registered.status === "ready" || registered.status === "degraded")
                && registered.last_scan_error === undefined;
              const completedStage = readiness.structural_ready ? 3 : readiness.structural_stage_ordinal ?? 0;
              if (completedStage < requiredStructuralStage && !legacyStructuralSnapshotAvailable) {
                const unsupported = readiness.structural_completeness === "unsupported";
                throw new DaemonError(unsupported ? "core:required_capability_unsupported" : "core:coverage_incomplete", unsupported
                  ? `Structural capabilities for workspace ${workspaceId} are unsupported.`
                  : `Structural stage ${requiredStructuralStage} for workspace ${workspaceId} is not ready.`, {
                  workspace_id: workspaceId,
                  required_layer: "structural",
                  capabilities: Object.entries(CAPABILITY_STAGE).filter(([, stage]) => stage <= requiredStructuralStage).map(([capability]) => capability),
                  reason_codes: readiness.readiness_reason_codes,
                  retry_after_ms: readiness.retry_after_ms ?? 1000,
                  retryable: !unsupported,
                  source_safe_fallback_operations: [...SOURCE_OPERATIONS],
                });
              }
            }
          }
          const engine = (await acquireWorkspaceQueryEngine(workspaceId, registry, storage, cache, queryEngines, recordBodyInterner, warmRecordsLru, semanticProvider, queryUsesSourceBinding(request.payload))).engine;
          // A cold `core:query`/`core:query_continue` can itself trigger a
          // full `records()` load (see `acquireWorkspaceQueryEngine`'s own
          // doc comment) exactly like an explicit warm -- re-checking the
          // budget after `execute()`/`continue()` settles catches that case
          // too, not just the explicit `warmWorkspaceQueryEngine` call
          // sites, per `DaemonRuntimeOptions.warm_records_budget_mb`'s "after
          // any load/warm completes" rule.
          if (request.call === "core:query") {
            const queryRequest = request.payload as QueryRequest;
            // `freshness: "wait_for_current"` is validated and hashed into
            // the plan (`query-plan.ts`) but nothing downstream actually
            // waits for anything -- historically a silent no-op that served
            // whatever generation happened to be current, even a generation
            // frozen by a repeatedly-failing scan (the delete-then-restore
            // `publication_conflict` wedge this fix targets). Full wiring to
            // `FreshnessBarrier`/`ReconciliationCoordinator`
            // (`reconciliation.ts`) needs a source-provider watermark port
            // this query path does not have; the minimum acceptable fix --
            // fail fast with the freshness subsystem's own timeout code
            // instead of silently lying -- is what's implemented here: a
            // workspace whose latest scan failed, or one with a scan
            // currently in flight (so "current" is about to change under
            // the caller anyway), cannot honor a current-or-fail request.
            if (queryRequest.options?.freshness === "wait_for_current") {
              const registered = registry.get(workspaceId);
              const scanFailed = registered?.last_scan_error !== undefined;
              const scanRunning = scanInFlight.has(workspaceId);
              if (scanFailed || scanRunning) {
                throw new DaemonError("core:freshness_wait_timeout", scanFailed
                  ? `Workspace ${workspaceId}'s latest scan attempt failed (${registered?.last_scan_error}); there is no current generation to wait for until it is fixed.`
                  : `Workspace ${workspaceId} has a scan in flight; freshness waiting is not wired to block on it, so the request fails fast instead of serving a stale generation.`,
                  { workspace_id: workspaceId, ...(registered?.last_scan_error === undefined ? {} : { last_scan_error: registered.last_scan_error }) });
              }
            }
            try { return attachIndexFreshness(await engine.execute(queryRequest), registry.get(workspaceId)); } finally { enforceWarmRecordsBudget(queryEngines, warmRecordsLru); }
          }
          const payload = requestRecord(request.payload);
          const cursor = payload["cursor"];
          const budget = requestRecord(payload["response_budget"]);
          if (typeof cursor !== "string" || cursor.length === 0 || typeof budget["max_items"] !== "number" || typeof budget["max_characters"] !== "number") {
            throw new DaemonError("core:ipc_request_invalid", "core:query_continue requires a cursor and a response budget.");
          }
          try {
            return attachIndexFreshness(await engine.continue({ cursor, response_budget: { max_items: budget["max_items"] as number, max_characters: budget["max_characters"] as number } }), registry.get(workspaceId));
          } finally {
            enforceWarmRecordsBudget(queryEngines, warmRecordsLru);
          }
            },
          });
          return await queryJob.promise;
        }
        if (request.call === "core:workspace_preview") {
          const root = workspaceRootFromRequest(request.payload);
          if (root === undefined) throw new DaemonError("core:ipc_request_invalid", "workspace preview requires a workspace path.");
          const proposal = await detectWorkspacePreview(root, pluginCatalog);
          return { proposal_id: `proposal:${proposal.proposal_fingerprint.slice("sha256:".length)}`, ...proposal, confirmation_required: true };
        }
        if (options.workspace_registry && request.call === "core:workspace_add") {
          const root = workspaceRootFromRequest(request.payload);
          if (root === undefined) throw new DaemonError("core:ipc_request_invalid", "workspace add requires a workspace path.");
          const existing = options.workspace_registry.findByCanonicalRoot(root);
          const confirmed = requestRecord(request.payload)["confirmed"] === true;
          if (existing) {
            const existingPayload = requestRecord(request.payload);
            const selectedTechnologyIds = Array.isArray(existingPayload["selected_technology_ids"])
              ? existingPayload["selected_technology_ids"].filter((value: unknown): value is string => typeof value === "string").sort() : existing.selected_technology_ids ?? [];
            const selectedPluginIds = Array.isArray(existingPayload["selected_plugin_ids"])
              ? existingPayload["selected_plugin_ids"].filter((value: unknown): value is string => typeof value === "string").sort() : existing.selected_plugin_ids ?? [];
            if (confirmed && !selectionHasCompatiblePlugin(selectedTechnologyIds, selectedPluginIds, pluginCatalog)) {
              throw new DaemonError("core:plugin_unavailable", "A detected technology was confirmed without one of its compatible verified plugins.");
            }
            if (confirmed && (Array.isArray(existingPayload["selected_technology_ids"]) || Array.isArray(existingPayload["selected_plugin_ids"]))) {
              options.workspace_registry.updateSelection(existing.workspace_id, selectedTechnologyIds, selectedPluginIds);
            }
            // Configure-time model provisioning (USER DECISION, 2026-08-13):
            // `core:workspace_add` is one of the three admin RPCs that provisions
            // the configured local embedding model, after this call's own
            // validation above has already succeeded. A provisioning failure
            // warns and this call continues normally -- see
            // `ensureAndActivateSemanticProvider`'s own doc comment. Its
            // return value (`undefined` when nothing was provisioned this
            // call) becomes this response's own `semantic_model` field below,
            // so a caller-triggered download is never silent (docs/decisions/18).
            const semanticModel = await ensureAndActivateSemanticProvider();
            if (confirmed && existing.status !== "indexing" && existing.status !== "ready" && existing.status !== "degraded") { options.workspace_registry.beginReconciliation(existing.workspace_id); scheduleWorkspaceScan(existing.workspace_id); }
            const current = options.workspace_registry.get(existing.workspace_id) ?? existing;
            if (watcherManager && confirmed) await startWorkspaceWatcher(watcherManager, current);
            return { workspace_id: current.workspace_id, status: current.status, registered: false, observation_started: current.status === "indexing" || current.status === "ready" || current.status === "degraded", ...(semanticModel === undefined ? {} : { semantic_model: semanticModel }) };
          }
          const identity = workspaceDigest(root);
          const requestPayload = requestRecord(request.payload);
          const selectedTechnologies = requestPayload["selected_technology_ids"];
          const selectedPlugins = requestPayload["selected_plugin_ids"];
          const selectedTechnologyIds: string[] = Array.isArray(selectedTechnologies)
            ? selectedTechnologies.filter((value: unknown): value is string => typeof value === "string").sort()
            : [];
          const selectedPluginIds: string[] = Array.isArray(selectedPlugins)
            ? selectedPlugins.filter((value: unknown): value is string => typeof value === "string").sort()
            : [];
          if (confirmed && !selectionHasCompatiblePlugin(selectedTechnologyIds, selectedPluginIds, pluginCatalog)) {
            throw new DaemonError("core:plugin_unavailable", "A detected technology was confirmed without one of its compatible verified plugins.");
          }
          // Same configure-time provisioning as the existing-workspace branch
          // above -- see its comment.
          const semanticModel = await ensureAndActivateSemanticProvider();
          const workspace = options.workspace_registry.register({
            display_root: root,
            provider: {
              source_provider_binding_id: `binding:${identity.slice("sha256:".length)}`,
              source_provider: "core:directory_source_provider",
              source_provider_version: "1",
              provider_role: "primary",
              binding_identity: identity,
              configuration_digest: workspaceDigest(JSON.stringify({ root, technologies: selectedTechnologyIds, plugins: selectedPluginIds, catalog: pluginCatalogFingerprint(pluginCatalog) })),
            },
            description: {
              provider_kind: "core:directory_source_provider",
              immutable_binding_identity: identity,
              features: JSON.stringify({ supports_watch: true, supports_complete_enumeration: true, supports_stable_reconciliation: true, read_only: false }),
              source_state_fingerprint: workspaceDigest(root),
            },
            selected_technology_ids: selectedTechnologyIds,
            selected_plugin_ids: selectedPluginIds,
          });
          const active = confirmed ? options.workspace_registry.beginReconciliation(workspace.workspace_id).workspace : workspace;
          if (confirmed) scheduleWorkspaceScan(active.workspace_id);
          if (watcherManager && confirmed) await startWorkspaceWatcher(watcherManager, active);
          return { workspace_id: active.workspace_id, status: active.status, registered: true, observation_started: confirmed, ...(confirmed ? {} : { confirmation_required: true }), ...(semanticModel === undefined ? {} : { semantic_model: semanticModel }) };
        }
        if (options.workspace_registry && request.call === "core:workspace_remove") {
          const rootOrId = workspaceRootFromRequest(request.payload);
          const workspace = rootOrId === undefined ? undefined : options.workspace_registry.get(rootOrId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          const removed = options.workspace_registry.remove(workspace.workspace_id);
          await watcherManager?.stop(removed.workspace_id);
          await indexingStorage?.catalog.markWorkspaceRemoved({ ...removed, source_provider_bindings: [removed.provider] });
          // Evict and close any cached `core:query` handle so a removed
          // workspace does not keep an open `WorkspaceDatabase` around for
          // the rest of this runtime's lifetime (see `acquireWorkspaceQueryEngine`).
          const cachedQueryEngine = queryEngines.get(removed.workspace_id);
          if (cachedQueryEngine) { queryEngines.delete(removed.workspace_id); await cachedQueryEngine.database.close().catch(() => undefined); }
          // Mirror the query-engine eviction above for any pooled per-workspace
          // analysis worker (see `analysis_worker_pool_evict`'s doc comment): a
          // removed workspace must not keep a live worker thread (and its Go
          // analysis server child process) pinned in the pool indefinitely.
          await options.analysis_worker_pool_evict?.(removed.workspace_id);
          return { workspace_id: removed.workspace_id, status: removed.status, purge_after: new Date(Date.parse(removed.removed_at ?? new Date().toISOString()) + 24 * 60 * 60 * 1000).toISOString() };
        }
        if (options.workspace_registry && request.call === "core:workspace_purge") {
          const rootOrId = workspaceRootFromRequest(request.payload);
          const workspace = rootOrId === undefined ? undefined : options.workspace_registry.get(rootOrId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          if (workspace.status !== "removed") throw new DaemonError("core:workspace_lifecycle", "Workspace must be removed before it can be purged.");
          const storage = indexingStorage;
          if (!storage) throw new DaemonError("core:storage_unavailable", "Workspace purge requires durable storage.");
          await watcherManager?.stop(workspace.workspace_id);
          const cachedQueryEngine = queryEngines.get(workspace.workspace_id);
          if (cachedQueryEngine) { queryEngines.delete(workspace.workspace_id); await cachedQueryEngine.database.close().catch(() => undefined); }
          await options.analysis_worker_pool_evict?.(workspace.workspace_id);
          const payload = requestRecord(request.payload);
          const body = requestRecord(payload["payload"]);
          const force = body["force"] === true;
          const now = typeof body["now"] === "string" ? body["now"] : new Date().toISOString();
          const purged = await storage.catalog.purgeWorkspace(workspace.workspace_id, now, force);
          // Storage is the authoritative destructive step. Only after the
          // database and catalog tombstone are gone do we remove the small
          // in-memory/persisted registry tombstone as well.
          options.workspace_registry.purge(workspace.workspace_id);
          let collection: unknown;
          const survivors = await storage.catalog.listWorkspaces();
          const survivor = survivors[0];
          if (survivor) {
            const database = await storage.openWorkspace(survivor.workspace_id);
            try { collection = await database.maintenance.collect({ now, batch_size: 1_000 }); }
            finally { await database.close().catch(() => undefined); }
          }
          return { ...purged, collection_pending: survivor === undefined, ...(collection === undefined ? {} : { collection }) };
        }
        if (options.workspace_registry && request.call === "core:workspace_configure") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof payload["workspace_id"] === "string" ? payload["workspace_id"] : undefined;
          if (workspaceId === undefined || options.workspace_registry.get(workspaceId) === undefined) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          // Configure-time model provisioning (USER DECISION, 2026-08-13):
          // same as `core:workspace_add` above -- see
          // `ensureAndActivateSemanticProvider`'s own doc comment.
          const semanticModel = await ensureAndActivateSemanticProvider();
          const impact = payload["configuration_impact"];
          const indexing = impact === "query_only" ? undefined : options.workspace_registry.beginReconciliation(workspaceId);
          return { workspace_id: workspaceId, configuration_applied: true, reindex_required: indexing !== undefined, observation_preserved: true, ...(indexing === undefined ? {} : { reconciliation_operation_id: indexing.operation_id, workspace_status: indexing.workspace.status }), ...(semanticModel === undefined ? {} : { semantic_model: semanticModel }) };
        }
        if (options.workspace_registry && request.call === "core:reindex") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const values = requestRecord(payload["values"]);
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof values["workspace"] === "string" ? values["workspace"] : undefined;
          const workspace = workspaceId === undefined ? undefined : options.workspace_registry.get(workspaceId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          // Force a new candidate generation even for an already "ready" or
          // "degraded" workspace: `beginReconciliation` (`packages/engine/src/workspaces.ts`)
          // already early-returns the existing reconciliation operation
          // harmlessly when a workspace is already "indexing" (reusing its
          // `reconciliation_operation_id`), so it is safe to call
          // unconditionally here rather than requiring the caller to know the
          // current status. Only skip re-submitting a scan job when one is
          // already in flight (status was already "indexing" before this
          // call), so `core:reindex` never races two concurrent scans against
          // the same `WorkspaceDatabase`; the caller can tell the two cases
          // apart via `reindex_started`. This deliberately leaves the
          // separate `core:workspace_add` existing-workspace guard
          // (`existing.status !== "indexing" && ... !== "ready" && ... !== "degraded"`)
          // untouched: that guard governs implicit re-add reconciliation, and
          // `core:reindex` is now the explicit forced-retry path instead of
          // relaxing it (see final report).
          const alreadyIndexing = workspace.status === "indexing";
          const operation = options.workspace_registry.beginReconciliation(workspace.workspace_id);
          if (!alreadyIndexing) scheduleWorkspaceScan(workspace.workspace_id);
          return { workspace_id: workspace.workspace_id, status: operation.workspace.status, reconciliation_operation_id: operation.operation_id, reindex_started: !alreadyIndexing };
        }
        if (options.workspace_registry && indexingStorage && request.call === "core:repair") {
          const storage = indexingStorage;
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const values = requestRecord(payload["values"]);
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof values["workspace"] === "string" ? values["workspace"] : undefined;
          const workspace = workspaceId === undefined ? undefined : options.workspace_registry.get(workspaceId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          const body = requestRecord(payload["payload"]);
          if (typeof body["component_kind"] !== "string" || typeof body["component_id"] !== "string") {
            throw new DaemonError("core:ipc_request_invalid", "core:repair requires a payload with component_kind and component_id.");
          }
          const repairRequest: RepairRequest = {
            component_kind: body["component_kind"] as RepairComponentKind,
            component_id: body["component_id"],
            ...(typeof body["backup_directory"] === "string" ? { backup_directory: body["backup_directory"] } : {}),
            ...(Array.isArray(body["rebuild_entries"]) ? { rebuild_entries: body["rebuild_entries"] } : {}),
            ...(typeof body["acknowledge_historical_loss"] === "boolean" ? { acknowledge_historical_loss: body["acknowledge_historical_loss"] } : {}),
          };
          return await withWorkspaceDatabase(workspace, storage, (database) => database.maintenance.repair(repairRequest));
        }
        if (options.workspace_registry && indexingStorage && request.call === "core:garbage_collect") {
          const storage = indexingStorage;
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const values = requestRecord(payload["values"]);
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof values["workspace"] === "string" ? values["workspace"] : undefined;
          const workspace = workspaceId === undefined ? undefined : options.workspace_registry.get(workspaceId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          const body = requestRecord(payload["payload"]);
          const collectionOptions: CollectionOptions = {
            now: typeof body["now"] === "string" ? body["now"] : new Date().toISOString(),
            batch_size: typeof body["batch_size"] === "number" ? body["batch_size"] : 1_000,
            ...(typeof body["epoch_id"] === "string" ? { epoch_id: body["epoch_id"] } : {}),
          };
          return await withWorkspaceDatabase(workspace, storage, (database) => database.maintenance.collect(collectionOptions));
        }
        if (options.workspace_registry && request.call === "core:configuration_set") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const values = requestRecord(payload["values"]);
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof values["workspace"] === "string" ? values["workspace"] : undefined;
          const workspace = workspaceId === undefined ? undefined : options.workspace_registry.get(workspaceId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          // Accepts the raw configuration document either as a `--value`
          // string (CLI's `values.value`) or as the parsed `--payload` JSON
          // object (re-stringified, since `WorkspaceConfigurationCoordinator.applyConfigDocument`
          // takes the document as text and parses it itself -- see
          // `tests/phase15-workspace-control.test.ts`'s reference call shape).
          const document = typeof values["value"] === "string" ? values["value"] : "payload" in payload ? JSON.stringify(payload["payload"]) : undefined;
          if (document === undefined) throw new DaemonError("core:ipc_request_invalid", "core:configuration_set requires a configuration document via --value or --payload.");
          const active = workspaceConfigurations.get(workspace.workspace_id) ?? {};
          const applied = configurationCoordinator.applyConfigDocument(workspace.workspace_id, document, active);
          if (!applied.applied) {
            return { workspace_id: workspace.workspace_id, configuration_applied: false, configuration_impact: applied.attempt.impact, reindex_required: false, observation_preserved: true, issues: applied.attempt.issues };
          }
          // Configure-time model provisioning (USER DECISION, 2026-08-13):
          // same as `core:workspace_add`/`core:workspace_configure` above --
          // only reached once `applied.applied` is true, i.e. this call's own
          // document validation already succeeded. See
          // `ensureAndActivateSemanticProvider`'s own doc comment.
          const semanticModel = await ensureAndActivateSemanticProvider();
          workspaceConfigurations.set(workspace.workspace_id, applied.configuration);
          const impact = applied.attempt.impact;
          // Mirrors `core:workspace_configure`'s existing reindex-on-non-query_only-impact
          // pattern above, but additionally calls `scheduleWorkspaceScan` (which
          // `core:workspace_configure` does not) so the reconciliation this
          // triggers is a real scan, not just a status flip to "indexing" --
          // consistent with the rest of this change making indexing actually
          // complete.
          const indexing = impact === "query_only" ? undefined : options.workspace_registry.beginReconciliation(workspace.workspace_id);
          if (indexing) scheduleWorkspaceScan(workspace.workspace_id);
          return { workspace_id: workspace.workspace_id, configuration_applied: true, configuration_impact: impact, reindex_required: indexing !== undefined, observation_preserved: true, ...(indexing === undefined ? {} : { reconciliation_operation_id: indexing.operation_id, workspace_status: indexing.workspace.status }), ...(semanticModel === undefined ? {} : { semantic_model: semanticModel }) };
        }
        // `core:daemon_start`/`core:daemon_stop`/`core:daemon_restart`: the
        // daemon handling this IPC call is definitionally already running,
        // so these are lifecycle-transition acknowledgements rather than
        // process spawns. See `docs/decisions/10-daemon-mcp-packaging.md`
        // ("The daemon is normally started on demand by the first `urdira
        // mcp` or CLI request and may optionally be registered as a per-user
        // background service") and the final report for the exact judgment
        // call this makes: `core:daemon_start` is an idempotent
        // already-running acknowledgement; `core:daemon_stop` schedules a
        // graceful `DaemonRuntime.stop()` after this response is written
        // (via `setImmediate`, not awaited inline, so the response for this
        // very request is not lost to the socket/server teardown `stop()`
        // performs); `core:daemon_restart` does the same stop but reports
        // `"restarting"` -- respawning a fresh process is intentionally left
        // to the caller (`urdira mcp`'s existing `resolveDaemon` on-demand
        // start behavior, in `apps/urdira`, not part of `@urdira/daemon`).
        if (request.call === "core:daemon_start") {
          return { state: "already_running", pid: process.pid, engine_build_id: options.engine_build_id, endpoint: paths.endpoint };
        }
        if (request.call === "core:daemon_stop") {
          const handle = runtimeHandle;
          setImmediate(() => { void handle?.stop().catch(() => undefined); });
          return { state: "stopping", pid: process.pid, engine_build_id: options.engine_build_id, endpoint: paths.endpoint };
        }
        if (request.call === "core:daemon_restart") {
          const handle = runtimeHandle;
          setImmediate(() => { void handle?.stop().catch(() => undefined); });
          return { state: "restarting", pid: process.pid, engine_build_id: options.engine_build_id, endpoint: paths.endpoint };
        }
        const handler = runtimeCalls[request.call];
        if (!handler) throw new DaemonError("core:unknown_call", `Call ${request.call} is not registered.`);
        return handler(request, context);
      } });
      await server.listen();
      if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
      await descriptor.write({ protocol_version: 1, endpoint: paths.endpoint, pid: process.pid, owner_uid: process.getuid?.() ?? 0, engine_build_id: options.engine_build_id, started_at: new Date().toISOString() });
      if (watcherManager && options.workspace_registry) {
        await Promise.all(options.workspace_registry.list().filter((workspace) => workspace.status !== "registering").map((workspace) => startWorkspaceWatcher(watcherManager, workspace)));
      }
      // Background reconciliation sweep (see `DaemonRuntimeOptions.reconciliation_sweep_interval_ms`'s
      // doc comment for the full incident this defends against): periodically
      // re-triggers the exact same `beginReconciliation` + `scheduleWorkspaceScan`
      // path a watcher event would have, for every currently `ready`/`degraded`
      // workspace, independent of whether the watcher (or a prior scan) is
      // actually still making progress. `scheduleWorkspaceScan` itself is a
      // no-op for a workspace that is not `"indexing"` when its scheduled job
      // actually runs (see its own body), and `beginReconciliation` is
      // idempotent against a workspace already `"indexing"` (returns the
      // existing operation instead of re-flipping) -- so a sweep tick can
      // never pile up concurrent scans of the same workspace, or interfere
      // with one a watcher event already started.
      const reconciliationSweepIntervalMs = options.reconciliation_sweep_interval_ms ?? 300_000;
      let reconciliationSweepTimer: NodeJS.Timeout | undefined;
      if (options.workspace_registry && reconciliationSweepIntervalMs > 0) {
        const registry = options.workspace_registry;
        reconciliationSweepTimer = setInterval(() => {
          for (const workspace of registry.list()) {
            if (workspace.status !== "ready" && workspace.status !== "degraded") continue;
            try {
              registry.beginReconciliation(workspace.workspace_id);
              scheduleWorkspaceScan(workspace.workspace_id);
            } catch (error) {
              // A removed/suspended workspace racing this tick, or any other
              // transient registry error, must not take down the sweep
              // itself -- the NEXT tick, and every other workspace THIS
              // tick, must still run.
              console.error(`[urdira] reconciliation sweep failed to schedule ${workspace.workspace_id}:`, error);
            }
          }
        }, reconciliationSweepIntervalMs);
        reconciliationSweepTimer.unref?.();
      }
      const runtime = new DaemonRuntime(options, paths, lock, descriptor, checkpoint, server!, scheduler, recoveredCheckpoint, recovery, recoveredCursorIds, pendingWarms, watcherManager, indexingStorage, queryEngines, reconciliationSweepTimer, semanticHost);
      runtime.state = "ready";
      runtimeHandle = runtime;
      return runtime;
    } catch (error) { await server?.close().catch(() => undefined); await indexingStorage?.close().catch(() => undefined); if (process.platform !== "win32") await unlink(paths.endpoint).catch(() => undefined); await lock.release(); throw error; }
  }
  status(): DaemonStatus { return { state: this.state, pid: process.pid, engine_build_id: this.options.engine_build_id, endpoint: this.endpoint, active_jobs: this.scheduler.activeCount, restart_leases: this.scheduler.restartLeaseCount }; }
  async stop(options: { readonly force?: boolean } = {}): Promise<void> {
    if (this.state === "stopping") return;
    this.state = "stopping";
    clearInterval(this.reconciliationSweepTimer);
    await this.server.close();
    await this.watcherManager?.stopAll();
    await this.scheduler.stop(options);
    await this.semanticHost?.close().catch(() => undefined);
    // No scan can still be mid-flight past this point (the scheduler is
    // stopped), so it is now safe to close every pooled analysis worker --
    // see `analysis_worker_pool_close_all`'s doc comment.
    await this.options.analysis_worker_pool_close_all?.();
    // Wait for every still-in-flight query-cache warm (see `trackWarm` in
    // `start()`) before closing storage: a warm's `openWorkspace()` call
    // that is still pending here would otherwise resolve after
    // `DurableStorage.close()` has already iterated its opened-workspaces
    // set, leaking an open SQLite handle past shutdown. `warmWorkspaceQueryEngine`
    // never rejects (it catches its own failures), so this cannot make
    // `stop()` itself fail.
    await Promise.all([...this.pendingWarms]);
    await this.indexingStorage?.close();
    await this.checkpoint.write({ engine_build_id: this.options.engine_build_id, checkpoint_id: `checkpoint-${Date.now()}`, workspaces: this.recovered_checkpoint?.workspaces ?? [], cursors: [...this.knownCursorIds], written_at: new Date().toISOString() });
    await this.descriptor.remove();
    if (process.platform !== "win32") await unlink(this.paths.endpoint).catch(() => undefined);
    await this.lock.release();
  }
  async rememberCursor(executionId: string, state: PersistedCursorState): Promise<void> { await this.recovery.save(executionId, state); this.knownCursorIds.add(executionId); }
  async recoverCursor(executionId: string): Promise<PersistedCursorState | undefined> { return this.recovery.load(executionId); }

  /**
   * Test-only introspection seam (never read by any production IPC handler
   * or internal call site -- only by tests asserting `URDIRA_WARM_RECORDS_BUDGET_MB`
   * eviction end to end): waits for every currently tracked background
   * query-cache warm (`trackWarm` in `start()` -- the startup prewarm chain,
   * and any scan/fork-completion warm) to settle, so a test can deterministically
   * observe the warm-up/eviction state that chain produces without a
   * fixed-delay `sleep`. Reuses the exact same `pendingWarms` set `stop()`
   * itself awaits.
   */
  async debugFlushPendingWarms(): Promise<void> { await Promise.all([...this.pendingWarms]); }

  /**
   * Test-only introspection seam (see `debugFlushPendingWarms` above):
   * whether `workspaceId`'s cached query engine, if any, currently has a
   * warm `recordsCache` entry for its current generation -- i.e. whether
   * `evictWarmRecords()` (LRU budget eviction) has dropped it since the last
   * load. `undefined` means this workspace has no cached query engine at
   * all in this process (never queried or warmed). There is no production
   * IPC surface for this today (`has_warm_records` only ever informs
   * `CanonicalRecordQueryDataPort.execute`'s own pushdown-vs-in-memory
   * choice internally); this exists solely so a test can assert the LRU
   * eviction feature actually evicted the workspace it expected, per the
   * pinned spec's own allowance ("`has_warm_records` via whatever status
   * surface exists, or direct port inspection through a test seam").
   */
  async debugHasWarmRecords(workspaceId: string): Promise<boolean | undefined> {
    const cached = this.queryEnginesForTest?.get(workspaceId);
    if (cached === undefined) return undefined;
    return cached.snapshot_port.has_warm_records({ scope_type: "single_workspace", workspace_id: workspaceId });
  }
}

export class DaemonClient {
  private readonly client: LocalIpcClient;
  constructor(endpoint: string, options: Omit<LocalIpcClientOptions, "endpoint"> = {}) { this.client = new LocalIpcClient({ ...options, endpoint }); }
  async call(call: string, payload: unknown, options: LocalIpcRequestOptions = {}): Promise<UceResponse> { return this.client.request(call, payload, options); }
}
