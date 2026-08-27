import { chmod, readdir, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DaemonError } from "./errors.js";
import { basename, dirname, resolve } from "node:path";
import { administrativeState, DEFAULT_WORKSPACE_INCLUSION, ISOMORPHIC_GIT_OBJECT_PORT, attemptIndexPackImport, attemptWorkspaceFork, buildQueryAdmissionPlan, CanonicalRecordQueryDataPort, createLocalHashProvider, CursorCache, QueryEngine, reconcileSemanticProjection, RecordBodyInterner, semanticMaterializationIdentity, SqliteCanonicalQuerySnapshotPort, WorkspaceConfigurationCoordinator, detectWorkspaceTechnologies, ParcelWatcherAdapter, watcherOptionsForSourceProvider, reconcileLexicalProjection, resolveIndexStatusRequest, runProgressiveWorkspaceScan, runSourceOnlyWorkspaceScan, WorkspaceWatcherManager, type QueryExecutionPage, type ReconcileSemanticProjectionResult, type RegisteredWorkspace, type ResolvedSemanticProvider, type WorkspacePluginCatalogEntry, type WorkspaceRegistry, type WorkspaceScanBudget, type WorkspaceScanPluginProvider, type QueryAdmissionPlan, type QueryFrontier } from "@urdira/engine";
import { operationRegistry, recipeDefinitions, type PluginCapabilityDeclaration, type QueryRequest, type SemanticMaterializationStatusView, type WorkspaceStructuralProgressView } from "@urdira/contracts";
import { createDurableStorage, type CollectionOptions, type DurableStorage, type RepairComponentKind, type RepairRequest, type WorkspaceDatabase } from "@urdira/storage";
import { runIndexPackExportInThread } from "./index-pack-export-thread.js";
import { runLexicalReconcileInThread, type LexicalThreadRun } from "./lexical-thread.js";
import { EndpointDescriptorStore, LastKnownGoodStore, ProcessLock, daemonPaths, type DaemonPaths } from "./ownership.js";
import { buildSemanticProvider, ensureSemanticAssets, type SemanticModelProvisioningNotice, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
import { ensureSemanticAssetsInProcess, runSemanticReconcileInProcess, startNeuralSemanticProviderHost, type NeuralSemanticProviderHost, type SemanticProcessRun } from "./semantic-process.js";
import { LocalIpcClient, LocalIpcServer, type LocalIpcClientOptions, type LocalIpcRequestOptions, type IpcProgress, type IpcResponse, type IpcRequestHandler } from "./protocol.js";
import { DaemonScheduler, PersistentCursorRecovery, type PersistedCursorState, type SchedulerOptions } from "./scheduler.js";
import { DAEMON_PRIVATE_INTERFACE_VERSION, daemonRpcCapabilities } from "./compatibility.js";

export interface DaemonPluginCatalogEntry extends WorkspacePluginCatalogEntry {
  readonly capability_declarations: readonly PluginCapabilityDeclaration[];
}

export type DaemonStartupPhase = "locking" | "catalog_verification" | "workspace_recovery" | "provider_reconciliation" | "ready";

export interface DaemonRuntimeOptions {
  /** Private composition hook used by human CLI startup progress rendering. */
  readonly on_startup_progress?: (phase: DaemonStartupPhase) => void;
  readonly data_root: string;
  readonly engine_build_id: string;
  readonly scheduler: SchedulerOptions;
  readonly calls?: Readonly<Record<string, IpcRequestHandler>>;
  readonly max_frame_bytes?: number;
  readonly known_cursors?: ReadonlyArray<string>;
  readonly workspace_registry?: WorkspaceRegistry;
  readonly workspace_status?: IpcRequestHandler;
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
  /** Maximum concurrent CAS writes during source ingestion (default 16). */
  readonly cas_put_concurrency?: number;
  /**
   * SQLite busy-wait ceiling for `indexingStorage`'s connections (default
   * 5000, see `DurableStorageOptions.busyTimeoutMs`). Test-only seam: lets a
   * regression test shrink the window `workspaceReadiness`'s `openWorkspace`
   * call blocks on SQLITE_BUSY against a concurrent long-running write
   * transaction, so the test observes the flap without waiting out a real
   * 5s default. Not read from any environment variable by the composing
   * application today.
   */
  readonly busy_timeout_ms?: number;
  /**
   * Whether a successful workspace scan submits a post-ready lexical
   * maintenance job (see `scheduleWorkspaceScan`'s `submitLexicalMaintenance`
   * below, and `reconcileLexicalProjection`, `@urdira/engine`'s
   * `lexical-reconciler.ts`) that brings `lexical_documents`/`lexical_fts`
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
   * own synchronous normalization/FTS5 insertion still runs on the daemon's main
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
   * Index pack import (docs/decisions/23-index-pack.md): the cross-machine
   * sibling of `workspace_fork` above. On a genuine first-ever scan, if
   * `core:workspace_add` registered a pending pack path for this workspace
   * (its `values["index-pack"]`/`--index-pack <path>`) and a local fork was
   * not attempted or did not match, `attemptIndexPackImport` tries to import
   * that pack before falling back to a full scan. A kill switch (`false`
   * only when explicitly disabled via `URDIRA_INDEX_PACK=0`); defaults to ON.
   * Even when ON, nothing happens unless a pack path was actually registered
   * for that workspace -- the path argument itself is the real opt-in.
   */
  readonly index_pack?: boolean;
  /** Mirrors `workspace_fork_verify` for `attemptIndexPackImport`'s own `verify_mode`; injected from `URDIRA_INDEX_PACK_VERIFY`. */
  readonly index_pack_verify?: "fast" | "full";
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
export interface DaemonStatus {
  readonly state: "starting" | "ready" | "stopping";
  readonly pid: number;
  readonly engine_build_id: string;
  readonly private_interface_version: number;
  readonly rpc_capabilities: readonly string[];
  readonly endpoint: string;
  readonly active_jobs: number;
  readonly restart_leases: number;
}

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
  if (error && typeof error === "object" && "provider_error" in error) {
    const providerError = (error as { provider_error?: unknown }).provider_error;
    if (providerError && typeof providerError === "object" && "error_code" in providerError && typeof (providerError as { error_code: unknown }).error_code === "string") return (providerError as { error_code: string }).error_code;
  }
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

function queryRequiredFrontier(payload: unknown): "source" | "syntax" | "structural" | "semantic" {
  const request = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const options = request["options"] !== null && typeof request["options"] === "object" && !Array.isArray(request["options"]) ? request["options"] as Record<string, unknown> : {};
  const explicit = options["required_frontier"];
  if (explicit === "source" || explicit === "syntax" || explicit === "structural" || explicit === "semantic") return explicit;
  return "structural";
}

function frontierReady(readiness: WorkspaceReadiness, frontier: "source" | "syntax" | "structural" | "semantic"): boolean {
  return frontier === "source" ? readiness.source_ready : frontier === "syntax" ? readiness.structural_stage_1_ready : frontier === "structural" ? readiness.structural_ready : readiness.semantic_ready;
}

function queryFreshnessWait(payload: unknown): { readonly requested: boolean; readonly timeoutMs: number } {
  const request = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const options = request["options"] !== null && typeof request["options"] === "object" && !Array.isArray(request["options"]) ? request["options"] as Record<string, unknown> : {};
  const freshness = options["freshness"];
  const requested = freshness === "wait_for_current" || (freshness !== null && typeof freshness === "object" && !Array.isArray(freshness) && (freshness as Record<string, unknown>)["mode"] === "wait");
  const rawTimeout = options["wait_timeout_ms"];
  return { requested, timeoutMs: typeof rawTimeout === "number" && Number.isSafeInteger(rawTimeout) && rawTimeout >= 0 ? rawTimeout : 0 };
}

/**
 * Reads a query workspace from the registry with a short, bounded grace
 * window. Registry replacements are synchronous, but workspace registration
 * and query admission can arrive on adjacent IPC turns while a caller is
 * copying the opaque id returned by `core:index_status`. In that interval a
 * brand-new id may not yet be visible to the query turn even though the
 * durable catalog and the next status turn already expose it. Removed
 * tombstones fail immediately; only an id with no tombstone is treated as a
 * possible registration race.
 */
async function findQueryWorkspace(workspaceId: string, registry: WorkspaceRegistry, signal?: AbortSignal): Promise<RegisteredWorkspace | undefined> {
  const retryDelaysMs = [0, 10, 25, 50, 100] as const;
  for (const delayMs of retryDelaysMs) {
    const workspace = registry.get(workspaceId);
    if (workspace !== undefined) return workspace;
    if (registry.listIncludingRemoved().some((candidate) => candidate.workspace_id === workspaceId)) return undefined;
    if (delayMs === 0) continue;
    if (signal?.aborted) return undefined;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  return registry.get(workspaceId);
}

function frontierForStructuralStage(stage: number): "source" | "syntax" | "structural" {
  return stage <= 0 ? "source" : stage === 1 ? "syntax" : "structural";
}

/**
 * Waits on the same durable readiness state exposed by `core:index_status`.
 * The old query path converted `wait_for_current` into a fail-fast check,
 * which made an agent poll status and retry while a scan was already making
 * progress. Polling uses bounded exponential backoff (250ms initially, up
 * to one read per second) and is cancellation-aware; it does not rerun a query or alter the
 * published snapshot.  A timeout is a typed, closed error carrying the
 * pending workspace count required by the public error contract.
 */
async function waitForQueryFrontier(
  workspaceId: string,
  frontier: "source" | "syntax" | "structural" | "semantic",
  timeoutMs: number,
  registry: WorkspaceRegistry,
  storage: DurableStorage,
  semantic: ReadonlyMap<string, SemanticMaterializationStatusView>,
  scanInFlight: ReadonlySet<string>,
  signal: AbortSignal,
  absoluteDeadlineMs?: number,
): Promise<WorkspaceReadiness> {
  const started = Date.now();
  const deadline = Math.min(started + timeoutMs, absoluteDeadlineMs ?? Number.POSITIVE_INFINITY);
  let latest: WorkspaceReadiness | undefined;
  let pollAttempt = 0;
  while (true) {
    if (signal.aborted) throw new DaemonError("core:operation_cancelled", "Freshness wait was cancelled.", { workspace_id: workspaceId, frontier });
    const workspace = await findQueryWorkspace(workspaceId, registry, signal);
    if (workspace === undefined) throw new DaemonError("core:workspace_not_found", `Workspace ${workspaceId} is not registered. Call urdira_index_status with the exact workspace_root and copy its query_scope.workspace_id byte-for-byte; never synthesize or shorten a workspace id.`, { workspace_id: workspaceId });
    latest = await workspaceReadiness(workspace, storage, semantic, scanInFlight.has(workspaceId));
    const scanRunning = scanInFlight.has(workspaceId);
    if (!scanRunning && frontierReady(latest, frontier) && workspace.last_scan_error === undefined) return latest;
    const frontierBuildState = frontier === "source" ? latest.source_build_state : frontier === "semantic" ? latest.semantic_build_state : latest.structural_build_state;
    if (!scanRunning && frontierBuildState !== "building") {
      throw new DaemonError("core:coverage_incomplete", `Required ${frontier} frontier for workspace ${workspaceId} has no scheduled work.`, {
        workspace_ids: [workspaceId],
        required_frontier: frontier,
        blocking_stage: frontier,
        blocking_operation: "unknown",
        waited_ms: Math.max(0, Date.now() - started),
        retryable: false,
      });
    }
    const now = Date.now();
    if (now >= deadline) {
      throw new DaemonError("core:freshness_wait_timeout", `Required ${frontier} frontier for workspace ${workspaceId} did not become current within ${Math.max(0, now - started)} ms.`, {
        workspace_ids: [workspaceId],
        waited_ms: Math.max(0, now - started),
        pending_observation_counts: [scanRunning ? 1 : 0],
        ...(latest.retry_after_ms === undefined ? {} : { retry_after_ms: latest.retry_after_ms }),
      });
    }
    await new Promise<void>((resolve, reject) => {
      const pollDelayMs = Math.min(1_000, 250 * 2 ** Math.min(pollAttempt, 2));
      pollAttempt += 1;
      const remaining = Math.max(1, Math.min(pollDelayMs, deadline - Date.now()));
      let settled = false;
      const timer = setTimeout(() => { settled = true; signal.removeEventListener("abort", cancel); resolve(); }, remaining);
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        reject(new DaemonError("core:operation_cancelled", "Freshness wait was cancelled.", { workspace_id: workspaceId, frontier }));
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

interface WorkspaceReadiness {
  readonly source_ready: boolean;
  readonly syntax_ready: boolean;
  readonly structural_stage_1_ready: boolean;
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

// Rate-limits the warning below to at most one line per workspace per
// `READINESS_WARN_INTERVAL_MS`: `workspaceReadiness` is polled roughly every
// 500ms per workspace (`core:index_status`, query admission), so logging
// every DB failure unratelimited would spam stderr for the full duration of
// any transient condition -- the canonical case being SQLITE_BUSY from
// `openWorkspace`'s own writes (schema/identity bookkeeping, lease
// acquisition) colliding with a concurrent long-running publish write
// transaction.
const READINESS_WARN_INTERVAL_MS = 10_000;
const lastReadinessWarnAt = new Map<string, number>();
function warnReadinessDbFailure(workspaceId: string, error: unknown, servingLastKnown: boolean): void {
  const now = Date.now();
  const last = lastReadinessWarnAt.get(workspaceId);
  if (last !== undefined && now - last < READINESS_WARN_INTERVAL_MS) return;
  lastReadinessWarnAt.set(workspaceId, now);
  const outcome = servingLastKnown
    ? "serving the last-known readiness snapshot until the next successful poll"
    : "reporting source_ready=false until the next successful poll";
  console.warn(`[urdira] workspaceReadiness could not read source state for workspace ${workspaceId} (code=${scanFailureErrorCode(error)}) -- ${outcome}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
}

/**
 * Last-known-good readiness inputs, keyed by workspace id: updated on every
 * successful `workspaceReadiness` DB read, consulted only from the catch
 * branch below for any failure that is NOT `storage:workspace_not_found`
 * (see that branch's comment). Module-level like `lastReadinessWarnAt`
 * above -- `workspaceReadiness` is a free function shared by every
 * `DaemonRuntime` instance in this process, so there is no natural
 * per-instance home for it without threading a cache handle through every
 * call site. Evicted alongside `lastReadinessWarnAt` on `core:workspace_remove`
 * (see that handler) so a removed workspace cannot keep serving a stale
 * snapshot forever.
 */
interface LastKnownSourceState {
  readonly sourceState: Awaited<ReturnType<WorkspaceDatabase["sourceIndex"]["getState"]>>;
  readonly structuralGeneration: number | undefined;
  readonly structuralStageId: string | undefined;
  readonly structuralStageOrdinal: number | undefined;
  readonly structuralStageCount: number | undefined;
}
const lastKnownSourceState = new Map<string, LastKnownSourceState>();

// Local, minimal counterpart to `@urdira/storage`'s `debug-timing.ts`
// (checked via the same `URDIRA_STORAGE_DEBUG_TIMING=1` flag, but not
// imported from it -- `debug-timing.ts` is not part of `@urdira/storage`'s
// `exports` map, only `.` is, so there is no clean import path into it from
// here). Exists purely so a later VS Code timing run can see readiness-poll
// DB-section latency (`workspaceReadiness`'s `openWorkspace`...`close` span)
// alongside storage's own timing lines; reports a running total every
// `READINESS_TIMING_REPORT_INTERVAL` polls instead of per-poll, to stay
// near-zero overhead when enabled and silent (no line at all) otherwise.
function readinessTimingEnabled(): boolean {
  return process.env["URDIRA_STORAGE_DEBUG_TIMING"] === "1";
}
const READINESS_TIMING_REPORT_INTERVAL = 100;
let readinessPollCount = 0;
let readinessPollMsTotal = 0;
function recordReadinessPollMs(ms: number): void {
  readinessPollCount += 1;
  readinessPollMsTotal += ms;
  if (readinessPollCount % READINESS_TIMING_REPORT_INTERVAL === 0) {
    console.error(`[urdira] readiness_poll db_section_ms_total=${Math.round(readinessPollMsTotal)} count=${readinessPollCount} avg_ms=${(readinessPollMsTotal / readinessPollCount).toFixed(1)}`);
  }
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
    const dbSectionStartedAt = readinessTimingEnabled() ? performance.now() : undefined;
    // Read-only: never contends with a held publish write transaction on
    // this workspace's own database (see `openWorkspaceReadOnly`'s doc
    // comment). This used to be `storage.openWorkspace`, whose own writes
    // (schema/identity bookkeeping, lease acquisition) queue behind a
    // long-running publish transaction and hit SQLITE_BUSY past the busy
    // timeout -- that was "the flap": `source_ready` flipping false for the
    // whole duration of every publish transaction.
    const database = await storage.openWorkspaceReadOnly(workspace.workspace_id);
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
      if (dbSectionStartedAt !== undefined) recordReadinessPollMs(performance.now() - dbSectionStartedAt);
    }
    // Remember this successful read: the catch branch below falls back to
    // it for any transient failure that is not a genuine "workspace
    // unregistered/missing" (see that branch's comment).
    lastKnownSourceState.set(workspace.workspace_id, { sourceState, structuralGeneration, structuralStageId, structuralStageOrdinal, structuralStageCount });
  } catch (error) {
    if (scanFailureErrorCode(error) === "storage:workspace_not_found") {
      // Genuinely unregistered, or its database file is missing (crash
      // mid-registration): there is no last-known reading that means
      // anything here, and nothing to protect against flapping -- report
      // unavailable, exactly as before.
      sourceState = undefined;
      structuralGeneration = undefined;
      structuralStageId = undefined;
      structuralStageOrdinal = undefined;
      structuralStageCount = undefined;
      warnReadinessDbFailure(workspace.workspace_id, error, false);
    } else {
      // Any other failure (SQLITE_BUSY, a transient SQL error against a
      // database mid-registration, a worker hiccup, ...) is presumed
      // transient: serve the last successfully computed readiness instead
      // of flapping `source_ready` false underneath every in-flight
      // query/status poll -- monotone availability, once a workspace has
      // been seen ready a single failed poll must not make it regress.
      const lastKnown = lastKnownSourceState.get(workspace.workspace_id);
      if (lastKnown) {
        sourceState = lastKnown.sourceState;
        structuralGeneration = lastKnown.structuralGeneration;
        structuralStageId = lastKnown.structuralStageId;
        structuralStageOrdinal = lastKnown.structuralStageOrdinal;
        structuralStageCount = lastKnown.structuralStageCount;
      } else {
        sourceState = undefined;
        structuralGeneration = undefined;
        structuralStageId = undefined;
        structuralStageOrdinal = undefined;
        structuralStageCount = undefined;
      }
      warnReadinessDbFailure(workspace.workspace_id, error, lastKnown !== undefined);
    }
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
  // Stage 1 publishes parser/syntax facts before the later structural closure;
  // expose it as its own frontier so callers need not wait for semantic work.
  const syntaxReady = sourceReady && (structuralReady || (structuralStageOrdinal !== undefined && structuralStageOrdinal >= 1));
  const semanticView = semantic.get(workspace.workspace_id);
  const semanticReady = structuralReady && semanticView?.materialization_state === "complete" && semanticView.source_snapshot_id === workspace.current_snapshot_id;
  const sourceReasonCodes = sourceAvailable ? [] : ["core:source_catalog_unavailable"];
  const structuralReasonCodes = structuralReady
    ? []
    : [structuralStale ? "core:source_snapshot_changed" : scanRunning ? "core:analysis_in_progress" : structuralUnsupported ? "core:plugin_unavailable" : "core:structural_snapshot_unavailable"];
  const semanticReasonCodes = semanticReady ? [] : [structuralUnsupported ? "core:plugin_unavailable" : structuralReady ? "core:semantic_indexing_in_progress" : "core:structural_required"];
  // `sourceIndex.getState()` returns a row from the workspace's FIRST
  // catalog fragment onward, not only after the completion fragment: every
  // batch (partial or complete) writes/updates the `source_index_state` row
  // (`stateCommands` in `source-index.ts`), it just leaves `current_generation`
  // pinned to the prior value until the completion fragment (see the comment
  // above `committedGeneration` in `source-indexer.ts`) advances it. So
  // `sourceAvailable` alone does not mean "the catalog scan finished" -- a
  // scan can be running for a long time (a large repo's `176s` catalog, in
  // the trace that motivated this) while `sourceAvailable` has already been
  // true since its first fragment landed (`41s` in that same trace). Label
  // that window honestly instead of claiming "complete"/"equivalent".
  const sourceCatalogSettling = sourceAvailable && scanRunning && !structuralReady;
  return {
    source_ready: sourceReady,
    syntax_ready: syntaxReady,
    structural_stage_1_ready: syntaxReady,
    structural_ready: structuralReady,
    semantic_ready: semanticReady,
    ...(sourceSnapshotId === undefined ? {} : { source_snapshot_id: sourceSnapshotId }),
    ...(workspace.current_snapshot_id === undefined ? {} : { structural_snapshot_id: workspace.current_snapshot_id, ...(sourceSnapshotId === undefined ? {} : { structural_source_snapshot_id: sourceSnapshotId }) }),
    source_availability: sourceAvailable ? "available" : "unavailable",
    source_completeness: sourceAvailable ? (sourceCatalogSettling ? "partial" : "complete") : "unknown",
    source_freshness: sourceAvailable ? (sourceCatalogSettling ? "changes_pending" : "equivalent") : "degraded",
    source_build_state: sourceAvailable ? (sourceCatalogSettling ? "building" : "idle") : workspace.status === "indexing" ? "building" : "not_started",
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
  const operationReady = (operation: (typeof operationRegistry)[number]): boolean => {
    if (operation.required_frontier === "source") return readiness.source_ready;
    if (operation.required_frontier === "syntax") return readiness.structural_stage_1_ready;
    if (operation.required_frontier === "semantic") return readiness.semantic_ready;
    return completedStage >= operation.required_stage;
  };
  const queryOperations = operationRegistry.filter((operation) => operation.operation_id !== "core:index_status" && operation.lifecycle_state === "active");
  const available = queryOperations.filter(operationReady).map((operation) => operation.operation_id);
  const blocked = queryOperations.filter((operation) => !available.includes(operation.operation_id)).map((operation) => operation.operation_id);
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
      syntax: {
        availability: readiness.structural_stage_1_ready ? "available" : "unavailable",
        completeness: readiness.structural_stage_1_ready ? "complete" : "unknown",
        freshness: readiness.structural_stage_1_ready ? "equivalent" : "degraded",
        build_state: readiness.structural_stage_1_ready ? "idle" : readiness.structural_build_state === "building" ? "building" : "not_started",
        ...(readiness.source_snapshot_id === undefined ? {} : { based_on_source_snapshot_id: readiness.source_snapshot_id }),
        reason_codes: readiness.structural_stage_1_ready ? [] : ["core:syntax_indexing_in_progress"],
        ...(readiness.retry_after_ms === undefined ? {} : { retry_after_ms: readiness.retry_after_ms }),
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
      blocked: blocked.map((operation) => {
        const definition = queryOperations.find((candidate) => candidate.operation_id === operation)!;
        const retryable = definition.required_frontier === "source"
          ? readiness.source_build_state === "building"
          : definition.required_frontier === "semantic"
            ? readiness.semantic_build_state === "building"
            : readiness.structural_build_state === "building";
        return { operation, required_layer: definition.required_frontier, retryable, reason_code: blockedReasonCode, ...(retryable && readiness.retry_after_ms !== undefined ? { retry_after_ms: readiness.retry_after_ms } : {}) };
      }),
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

function parsedVcsState(serialized: string | undefined): Record<string, unknown> | undefined {
  if (serialized === undefined) return undefined;
  try { return requestRecord(JSON.parse(serialized)); } catch { return undefined; }
}

function normalizedVcsState(serialized: string | undefined): Record<string, unknown> | undefined {
  const vcs = parsedVcsState(serialized);
  if (vcs === undefined) return undefined;
  const rawRef = typeof vcs["ref_name"] === "string" ? vcs["ref_name"] : undefined;
  const branch = rawRef?.replace(/^refs\/heads\//u, "");
  const revision = typeof vcs["head_revision"] === "string" ? vcs["head_revision"] : undefined;
  const capturedAt = typeof vcs["captured_at"] === "string" ? vcs["captured_at"] : undefined;
  return {
    ...vcs,
    ...(rawRef === undefined ? {} : { ref_name: branch }),
    ...(branch === undefined ? {} : { branch }),
    ...(revision === undefined ? {} : { short_commit: revision.slice(0, 8) }),
    ...(capturedAt === undefined || !Number.isFinite(Date.parse(capturedAt)) ? {} : { observation_age_ms: Math.max(0, Date.now() - Date.parse(capturedAt)) }),
  };
}

function projectNameForGitRoot(root: string, administration: Awaited<ReturnType<typeof administrativeState>> | undefined): string {
  return administration === undefined ? basename(resolve(root)) : basename(dirname(administration.common_directory));
}

type WorkspaceIndexingActivity = "checking_for_updates" | "indexing";

function workspaceAdministrativeView(registry: WorkspaceRegistry, workspace: RegisteredWorkspace, indexingActivity?: WorkspaceIndexingActivity): Readonly<Record<string, unknown>> {
  const vcs = normalizedVcsState(workspace.vcs_state);
  const codebase = workspace.codebase_id === undefined ? undefined : registry.getCodebase(workspace.codebase_id);
  const branch = typeof vcs?.["branch"] === "string" ? vcs["branch"] : undefined;
  const detached = vcs?.["detached"] === true;
  const shortCommit = typeof vcs?.["short_commit"] === "string" ? vcs["short_commit"] : undefined;
  const workspaceLabel = branch ?? (detached && shortCommit !== undefined ? `detached@${shortCommit}` : basename(workspace.canonical_root));
  return {
    ...workspace,
    project_name: codebase?.display_name ?? workspace.project_name ?? basename(workspace.canonical_root),
    workspace_label: workspaceLabel,
    workspace_kind: vcs === undefined ? "directory" : "worktree",
    directory_name: basename(workspace.canonical_root),
    ...(workspace.status !== "indexing" || indexingActivity === undefined ? {} : { indexing_activity: indexingActivity }),
    ...(vcs === undefined ? {} : { vcs_state: vcs }),
  };
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
  if (request["api_version"] !== 3) return false;
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
  const registeredWorkspace = await findQueryWorkspace(workspaceId, registry);
  const sourceWorkspace = allowSourceBinding ? registeredWorkspace : undefined;
  const resolution = registeredWorkspace !== undefined && registeredWorkspace.status !== "removed"
    ? { workspace_id: workspaceId }
    : { error: { code: "core:workspace_not_found" as const, details: { workspace_id: workspaceId } } };
  if ("error" in resolution) throw new DaemonError(resolution.error.code, `The requested query workspace ${workspaceId} is unavailable. Call urdira_index_status with the exact workspace_root and copy query_scope.workspace_id byte-for-byte; never synthesize or shorten a workspace id.`, resolution.error.details);
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
 * `acquireWorkspaceQueryEngine` above): primes only the metadata path
 * (connection/schema, current generation, and capability state). It never
 * loads the record corpus or builds an identity map. Never throws -- failures
 * are logged with the `[urdira]` prefix used by neighboring best-effort code
 * in this file and must never affect the caller (a scan's success, or daemon
 * startup).
 *
 * The record LRU is intentionally untouched: it is populated only by a
 * bounded query that actually needs record hydration.
 */
async function warmWorkspaceQueryEngine(workspaceId: string, registry: WorkspaceRegistry, storage: DurableStorage, cursorCache: CursorCache, cache: Map<string, CachedWorkspaceQueryEngine>, interner: RecordBodyInterner, lru: WarmRecordsLru, semanticProvider?: ResolvedSemanticProvider): Promise<void> {
  try {
    const cached = await acquireWorkspaceQueryEngine(workspaceId, registry, storage, cursorCache, cache, interner, lru, semanticProvider);
    await cached.data_port.warm({ scope_type: "single_workspace", workspace_id: workspaceId });
  } catch (error) {
    console.error(`[urdira] query cache warm-up failed for ${workspaceId}:`, error);
  }
}

async function detectWorkspacePreview(root: string, catalog: readonly DaemonPluginCatalogEntry[], reportProgress?: (progress: IpcProgress["progress"]) => void) {
  const files: Array<{ readonly path: string; readonly content?: string }> = [];
  reportProgress?.({ phase: "workspace_discovery", completed: 0, message: `scanning ${root}` });
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
        if (files.length % 250 === 0) reportProgress?.({ phase: "workspace_discovery", completed: files.length, message: `inspected ${files.length} workspace files` });
      }
    }
  };
  await walk(root);
  reportProgress?.({ phase: "workspace_discovery", completed: files.length, total: files.length, message: `workspace discovery complete (${files.length} files inspected)` });
  const detection = detectWorkspaceTechnologies({
    provider_fingerprint: workspaceDigest(root),
    git_state_fingerprint: "git:unresolved",
    plugin_catalog_fingerprint: pluginCatalogFingerprint(catalog),
    plugin_catalog: catalog,
    files,
  });
  const vcsState = await administrativeState(root, ISOMORPHIC_GIT_OBJECT_PORT, () => new Date().toISOString()).then((state) => state.vcs_state as unknown as Readonly<Record<string, unknown>>).catch(() => undefined);
  return { ...detection, ...(vcsState === undefined ? {} : { vcs_state: vcsState, suggested_codebase_vcs_identity: vcsState["common_repository_id"] }) };
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
        authoritative_delete_events: true,
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
      }, { watcher_options: watcherOptionsForSourceProvider(workspace.provider.source_provider), on_error: (error: Error) => console.error(`[urdira] watcher error for workspace ${workspace.workspace_id} (${workspace.display_root}):`, error) }),
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
 * Makes the durable workspace registration visible before an indexing
 * operation is exposed through the in-memory registry. `core:workspace_add`
 * publishes `indexing` immediately and the readiness poll starts as soon as
 * that response is received; leaving catalog/database creation to the first
 * background scan therefore creates a real `storage:workspace_not_found`
 * window between those two events.
 */
async function ensureWorkspaceCatalogRegistration(workspace: RegisteredWorkspace, storage: DurableStorage): Promise<void> {
  await storage.catalog.registerWorkspace({
    workspace_id: workspace.workspace_id,
    canonical_root: workspace.canonical_root,
    display_root: workspace.display_root,
    source_provider_bindings: [workspace.provider],
    status: "registered",
    registered_at: workspace.registered_at,
  });
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
  await ensureWorkspaceCatalogRegistration(workspace, storage);
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

function hasPotentialWorkspaceForkDonor(workspace: RegisteredWorkspace, registry: WorkspaceRegistry): boolean {
  const selection = [...(workspace.selected_plugin_ids ?? [])].sort();
  return registry.list().some((candidate) => {
    if (candidate.workspace_id === workspace.workspace_id || candidate.status !== "ready") return false;
    const candidateSelection = [...(candidate.selected_plugin_ids ?? [])].sort();
    return candidateSelection.length === selection.length && candidateSelection.every((pluginId, index) => pluginId === selection[index]);
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
    const rpcCapabilities = daemonRpcCapabilities(options.workspace_registry !== undefined);
    options.on_startup_progress?.("locking");
    const paths = await daemonPaths(options.data_root);
    const lock = await ProcessLock.acquire(paths.process_lock, { pid: process.pid, started_at: new Date().toISOString() });
    options.on_startup_progress?.("catalog_verification");
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
      options.on_startup_progress?.("workspace_recovery");
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
        ? await createDurableStorage({ rootDir: options.data_root, ...(options.cas_put_concurrency === undefined ? {} : { cas_put_concurrency: options.cas_put_concurrency }), ...(options.busy_timeout_ms === undefined ? {} : { busyTimeoutMs: options.busy_timeout_ms }) })
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
      // succession for one workspace (e.g. several watcher batches for one
      // edit, or a watcher event racing an explicit `core:reindex`); with
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
      // scheduler may not start the job immediately. Requests arriving while
      // a scan is running are coalesced below and run once after it settles.
      // They deliberately do not abort the active scan: on macOS kqueue can
      // report one directory edit as several path events, and aborting at
      // every event can tear down a TypeScript worker during publication.
      const scanInFlight = new Set<string>();
      // Local administrative presentation only. Public query/MCP responses
      // retain the existing workspace lifecycle contract; the web interface
      // uses this transient detail to distinguish a periodic equivalence
      // check from a scan triggered by a real change or explicit reindex.
      const scanActivities = new Map<string, WorkspaceIndexingActivity>();
      const scanGenerations = new Map<string, number>();
      // Tracks the currently in-flight THREADED lexical maintenance run (if
      // any) per workspace -- `submitLexicalMaintenance` below adds an entry
      // right before starting a threaded run and removes it once that run's
      // `result` settles. `scheduleWorkspaceScan` aborts whatever entry
      // exists here the moment a fresh scan starts for the same workspace
      // (see below): a lexical worker's own write transactions are the only
      // other writer of `lexical_documents`/`lexical_fts`/`lexical_index_state`,
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
      // request's changed URIs. Authoritative absences have a second queue
      // for successor presences so a delete/create (rename) publishes the
      // tombstone generation before the replacement is captured. Previously
      // (Phase 4) a request that arrived
      // while a scan was in flight was simply dropped; now that `on_reconcile`
      // fires for every ordinary watch batch (not only the unsafe ones), a
      // dropped request could mean a real edit is never rescanned at all, so
      // it is coalesced into exactly one guaranteed follow-up scan instead.
      // Index pack import (docs/decisions/23-index-pack.md): a workspace_id
      // -> pack path side channel, set by `core:workspace_add` when its
      // request carried `values["index-pack"]`, consumed exactly once by
      // `scheduleWorkspaceScan`'s first-ever-scan branch below (deleted on
      // that first read regardless of outcome, so a later `core:reindex`
      // never re-attempts an import against an already-populated workspace).
      const pendingIndexPackPaths = new Map<string, string>();
      const activeAuthoritativeDeletePhases = new Map<string, Set<string>>();
      const pendingScans = new Map<string, {
        full: boolean;
        uris: Set<string>;
        authoritativeDeletes: Map<string, import("@urdira/engine").WatcherHint>;
        presencesAfterDeletes: Set<string>;
        activity: WorkspaceIndexingActivity;
      }>();
      const scheduleWorkspaceScan = (workspaceId: string, changedUris?: readonly string[], authoritativeDeletes: readonly import("@urdira/engine").WatcherHint[] = [], activity: WorkspaceIndexingActivity = "indexing"): void => {
        const registry = options.workspace_registry;
        const resolvePluginProvider = options.resolve_plugin_provider;
        const durableStorage = indexingStorage;
        if (!registry || !resolvePluginProvider || !durableStorage) return;
        // A concrete filesystem event or explicit scan always upgrades a
        // periodic check that happened to be in flight; a later sweep must
        // never downgrade visible real indexing to a passive check.
        scanActivities.set(workspaceId, scanActivities.get(workspaceId) === "indexing" || activity === "indexing" ? "indexing" : "checking_for_updates");
        if (scanInFlight.has(workspaceId)) {
          const pending = pendingScans.get(workspaceId) ?? {
            full: false,
            uris: new Set<string>(),
            authoritativeDeletes: new Map<string, import("@urdira/engine").WatcherHint>(),
            presencesAfterDeletes: new Set<string>(),
            activity,
          };
          if (activity === "indexing") pending.activity = "indexing";
          if (changedUris === undefined) {
            // Unsafe/lost coverage supersedes narrower work and does not
            // carry a delete hint into the full reconciliation.
            pending.full = true;
            pending.uris.clear();
            pending.authoritativeDeletes.clear();
            pending.presencesAfterDeletes.clear();
          } else if (pending.authoritativeDeletes.size > 0 || authoritativeDeletes.length > 0 || activeAuthoritativeDeletePhases.has(workspaceId)) {
            for (const uri of changedUris) pending.presencesAfterDeletes.add(uri);
          } else {
            for (const uri of changedUris) pending.uris.add(uri);
          }
          for (const event of authoritativeDeletes) pending.authoritativeDeletes.set(event.normalized_uri, event);
          pendingScans.set(workspaceId, pending);
          // All pending changes are coalesced into a follow-up scan. The
          // active scan is never aborted: kqueue can report one edit as
          // several path events, and tearing down the active worker for each
          // event can fail during stage publication.
          // Do not abort the active scan here. macOS kqueue can report one
          // directory edit as several path events; aborting at every event
          // tears down TypeScript workers while they publish stage 1 and can
          // produce `spawn EBADF` plus SQLite generation-check failures.
          // The pending request is already coalesced above and will run once
          // after this scan settles.
          return;
        }
        scanInFlight.add(workspaceId);
        const scanController = new AbortController();
        const scanGeneration = (scanGenerations.get(workspaceId) ?? 0) + 1;
        scanGenerations.set(workspaceId, scanGeneration);
        const requestedUris = changedUris === undefined ? undefined : [...new Set(changedUris)];
        if (authoritativeDeletes.length > 0) activeAuthoritativeDeletePhases.set(workspaceId, new Set(authoritativeDeletes.map((event) => event.normalized_uri)));
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
                // Do not run `administrativeState` here. It verifies the
                // complete Git worktree by reading and hashing every tracked
                // file, which is disproportionate on a large repository and
                // needlessly delays the first source scan. The source
                // provider performs the authoritative before/after
                // administrative checks around the actual capture; this
                // pre-scan presentation refresh is not part of correctness.
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
                    // API v3 source bindings.
                    await runSourceOnlyWorkspaceScan({
                      root: workspace.canonical_root,
                      database,
                      workspace_id: workspaceId,
                      inclusion_rules: DEFAULT_WORKSPACE_INCLUSION,
                      ...(options.scan_budget === undefined ? {} : { scan_budget: options.scan_budget }),
                      ...(options.scan_io_concurrency === undefined ? {} : { io_concurrency: options.scan_io_concurrency }),
                      ...(requestedUris === undefined ? {} : { changed_uris: requestedUris }),
                      ...(authoritativeDeletes.length === 0 ? {} : { authoritative_delete_events: authoritativeDeletes }),
                      signal: scanController.signal,
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
                  if (priorSnapshotId === undefined && options.workspace_fork !== false && hasPotentialWorkspaceForkDonor(workspace, registry)) {
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
                  // Index pack import (docs/decisions/23-index-pack.md): the
                  // cross-machine sibling of the local fork attempt above,
                  // tried second (a local donor, when one exists, is always
                  // cheaper and needs no untrusted-content recompute pass).
                  // Only fires when `core:workspace_add` registered a pack
                  // path for THIS workspace id (`pendingIndexPackPaths`,
                  // above) -- the registered path is the real opt-in;
                  // `options.index_pack !== false` is only a kill switch.
                  // `attemptIndexPackImport` never throws either, same
                  // contract as `attemptWorkspaceFork`.
                  if (priorSnapshotId === undefined) {
                    const pendingPackPath = pendingIndexPackPaths.get(workspaceId);
                    if (pendingPackPath !== undefined) {
                      pendingIndexPackPaths.delete(workspaceId);
                      if (options.index_pack !== false) {
                        try {
                          const importOutcome = await attemptIndexPackImport({ workspace, database, storage: durableStorage, registry, plugin, pack_path: pendingPackPath, ...(options.index_pack_verify === undefined ? {} : { verify_mode: options.index_pack_verify }) });
                          if (importOutcome.status === "imported") {
                            registry.markReady(workspaceId, importOutcome.snapshot_id, "ready");
                            submitLexicalMaintenance(workspaceId);
                            submitSemanticMaintenance(workspaceId);
                            return undefined;
                          }
                          console.error(`[urdira] index pack import skipped for ${workspaceId}, falling back to a full scan: ${importOutcome.reason}`);
                        } catch (error) {
                          console.error(`[urdira] index pack import attempt for ${workspaceId} threw, falling back to a full scan:`, error);
                        }
                      }
                    }
                  }
                  const result = await runProgressiveWorkspaceScan({
                    root: workspace.canonical_root,
                    database,
                    workspace_id: workspaceId,
                    plugin,
                      inclusion_rules: DEFAULT_WORKSPACE_INCLUSION,
                    ...(options.scan_budget === undefined ? {} : { scan_budget: options.scan_budget }),
                    ...(options.scan_io_concurrency === undefined ? {} : { io_concurrency: options.scan_io_concurrency }),
                    ...(requestedUris === undefined ? {} : { changed_uris: requestedUris }),
                    ...(authoritativeDeletes.length === 0 ? {} : { authoritative_delete_events: authoritativeDeletes }),
                    signal: scanController.signal,
                    on_stage_published: (stage, stageResult) => {
                      // A periodic equivalence check has now discovered and
                      // published real work. Upgrade the local presentation
                      // before exposing the new stage; equivalent checks
                      // never enter this callback and stay labeled checking.
                      scanActivities.set(workspaceId, "indexing");
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
                  const cancelled = scanFailureErrorCode(error) === "core:operation_cancelled" || scanController.signal.aborted;
                  if (cancelled) {
                    console.error(`[urdira] workspace scan superseded for ${workspaceId}`);
                    return undefined;
                  }
                  const failureCode = scanFailureErrorCode(error);
                  // A watcher can legitimately deliver an edit while the
                  // source provider is streaming the same file. The provider
                  // rejects that mixed generation with a retryable
                  // `core:source_changed`; this is not an indexing failure and
                  // must not pin the workspace to a stale degraded snapshot.
                  // Queue one full successor after the current scan settles so
                  // the next capture observes a stable occurrence. The normal
                  // pending-scan coalescer guarantees that several edits still
                  // become one follow-up scan.
                  if (failureCode === "core:source_changed") {
                    console.warn(`[urdira] workspace scan deferred for ${workspaceId}: source changed during capture; retrying`);
                    pendingScans.set(workspaceId, {
                      full: true,
                      uris: new Set(),
                      authoritativeDeletes: new Map(),
                      presencesAfterDeletes: new Set(),
                      activity: "indexing",
                    });
                    return undefined;
                  }
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
                activeAuthoritativeDeletePhases.delete(workspaceId);
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
                  if (pending.full) {
                    scheduleWorkspaceScan(workspaceId, undefined, [], pending.activity);
                  } else if (pending.authoritativeDeletes.size > 0) {
                    // Preserve a second generation for rename/recreate
                    // batches even when both callbacks arrived while the
                    // first scan was still running.
                    if (pending.presencesAfterDeletes.size > 0) {
                      pendingScans.set(workspaceId, {
                        full: false,
                        uris: new Set(pending.presencesAfterDeletes),
                        authoritativeDeletes: new Map(),
                        presencesAfterDeletes: new Set(),
                        activity: pending.activity,
                      });
                    }
                    scheduleWorkspaceScan(workspaceId, [], [...pending.authoritativeDeletes.values()], pending.activity);
                  } else {
                    scheduleWorkspaceScan(workspaceId, [...pending.uris], [], pending.activity);
                  }
                } else scanActivities.delete(workspaceId);
              }
            },
          });
        } catch {
          // Scheduler admission failure (quota exhausted, or the daemon is
          // stopping): the workspace stays "indexing"; a future
          // reconciliation attempt (watcher event or `workspace add`) retries.
          scanInFlight.delete(workspaceId);
          activeAuthoritativeDeletePhases.delete(workspaceId);
          scanActivities.delete(workspaceId);
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
      // reason `analysisThreadEnabled` exists) or lexical FTS5 maintenance
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
      // Startup metadata warm-up: open the workspace, prepare its SQLite
      // path, resolve the current generation, and read capabilities. This is
      // deliberately sequential and never materializes the source corpus.
      if (options.workspace_registry && indexingStorage && cursorCache) {
        const registry = options.workspace_registry;
        const storage = indexingStorage;
        const cache = cursorCache;
        const warmableWorkspaceIds = registry.list().filter((workspace) => workspace.status === "ready" || workspace.status === "degraded").map((workspace) => workspace.workspace_id);
        trackWarm((async () => {
          for (const workspaceId of warmableWorkspaceIds) await warmWorkspaceQueryEngine(workspaceId, registry, storage, cache, queryEngines, recordBodyInterner, warmRecordsLru, semanticProvider);
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
        on_reconcile: async (workspaceId, changedUris, _reason, authoritativeDeletes = []) => {
          try { options.workspace_registry?.beginReconciliation(workspaceId); scheduleWorkspaceScan(workspaceId, changedUris, authoritativeDeletes); } catch { /* removed workspaces are ignored */ }
        },
      }) : undefined;
      server = new LocalIpcServer({ endpoint: paths.endpoint, ...(options.max_frame_bytes === undefined ? {} : { max_frame_bytes: options.max_frame_bytes }), handler: async (request, context) => {
        if (request.call === "core:status") return { state: "ready", pid: process.pid, engine_build_id: options.engine_build_id, private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION, rpc_capabilities: rpcCapabilities, endpoint: paths.endpoint, active_jobs: scheduler.activeCount, restart_leases: scheduler.restartLeaseCount } satisfies DaemonStatus;
        if (request.call === "core:index_status" && options.workspace_status) return options.workspace_status(request, context);
        if (request.call === "core:index_status" && options.workspace_registry) {
          const payload = request.payload !== null && typeof request.payload === "object" ? request.payload as { readonly api_version?: unknown; readonly workspace_ids?: unknown; readonly workspace_root?: unknown } : {};
          const apiVersion = typeof payload.api_version === "number" ? payload.api_version : 3;
          const workspaceIds = Array.isArray(payload.workspace_ids) ? payload.workspace_ids.filter((value): value is string => typeof value === "string") : [];
          if (apiVersion !== 3) throw new DaemonError("core:api_version_unsupported", "Only API version 3 is supported.", { requested_version: apiVersion, supported_versions: [3] });
          const buildStatusView = async (workspace: RegisteredWorkspace) => {
            const readiness = await workspaceReadiness(workspace, indexingStorage, semanticMaterializations, scanInFlight.has(workspace.workspace_id));
            const pluginStatus = pluginStatusForWorkspace(workspace, pluginCatalog, readiness);
            const administrative = workspaceAdministrativeView(options.workspace_registry!, workspace);
            return { workspace_id: workspace.workspace_id, codebase_id: workspace.codebase_id, project_name: administrative["project_name"], workspace_label: administrative["workspace_label"], workspace_kind: administrative["workspace_kind"], display_root: basename(workspace.display_root), ...(administrative["vcs_state"] === undefined ? {} : { vcs_state: administrative["vcs_state"] }), workspace_status: workspace.status, startup_phase: workspace.status === "registering" ? "reconciling_sources" : readiness.source_ready && !readiness.structural_ready ? "publishing_structural" : "ready", ...(workspace.current_snapshot_id === undefined ? {} : { current_snapshot_id: workspace.current_snapshot_id }), freshness_status: workspaceFreshnessStatus(workspace), ...(workspace.last_scan_error === undefined ? {} : { last_scan_error_code: workspace.last_scan_error }), ...(workspace.last_scan_error_at === undefined ? {} : { last_scan_error_at: workspace.last_scan_error_at }), plugins: pluginStatus.plugins, capabilities: pluginStatus.capabilities, structural_progress: pluginStatus.structural_progress, semantic_materializations: semanticMaterializations.get(workspace.workspace_id) === undefined ? [] : [semanticMaterializations.get(workspace.workspace_id)!], configuration_issues: [], ...readinessPayload(readiness) };
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
          // Admission is deliberately completed before scheduler submission,
          // readiness waits, engine acquisition, or any query IPC fan-out.
          // The normalized plan is then the only source of frontier/stage
          // requirements below.
          const admission: QueryAdmissionPlan | undefined = request.call === "core:query"
            ? buildQueryAdmissionPlan(request.payload as QueryRequest)
            : undefined;
          const submittedAt = Date.now();
          const queryJob = scheduler.submit({
            job_id: `query:${workspaceId}:${randomUUID()}`,
            client_id: "core:query",
            workspace_id: workspaceId,
            pool: "query",
          run: async (_jobSignal, reportProgress) => {
          const executionStartedAt = Date.now();
          const emitTiming = (phase: string, message: string): void => { const event = { phase, completed: 1, total: 1, message }; reportProgress(event); context.reportProgress(event); };
          emitTiming("queue", `queue_ms=${Math.max(0, executionStartedAt - submittedAt)}`);
          const requiredStructuralStage = admission?.required_structural_stage ?? 0;
          if (request.call === "core:query") {
            const freshness = queryFreshnessWait(request.payload);
            if (freshness.requested) {
              const freshnessStartedAt = Date.now();
              const frontier = admission?.required_frontier ?? "source";
              await waitForQueryFrontier(workspaceId, frontier, freshness.timeoutMs, registry, storage, semanticMaterializations, scanInFlight, context.signal, Date.parse(context.deadline_at));
              emitTiming("freshness", `freshness_ms=${Math.max(0, Date.now() - freshnessStartedAt)}`);
            }
          }
          if (request.call === "core:query" && requiredStructuralStage > 0) {
            const registered = registry.get(workspaceId);
            if (registered !== undefined) {
              const readiness = await workspaceReadiness(registered, storage, semanticMaterializations, scanInFlight.has(workspaceId));
              const completedStage = readiness.structural_ready ? 3 : readiness.structural_stage_ordinal ?? 0;
              if (completedStage < requiredStructuralStage) {
                const unsupported = readiness.structural_completeness === "unsupported";
                throw new DaemonError(unsupported ? "core:required_capability_unsupported" : "core:coverage_incomplete", unsupported
                  ? `Structural capabilities for workspace ${workspaceId} are unsupported.`
                  : `Structural stage ${requiredStructuralStage} for workspace ${workspaceId} is not ready.`, {
                  workspace_id: workspaceId,
                  required_frontier: admission?.required_frontier ?? "source",
                  blocking_stage: admission?.blocking_stages.find((stage) => stage.required_structural_stage === requiredStructuralStage)?.stage_id ?? String(requiredStructuralStage),
                  blocking_operation: admission?.blocking_stages.find((stage) => stage.required_structural_stage === requiredStructuralStage)?.operation ?? "unknown",
                  capabilities: Object.entries(CAPABILITY_STAGE).filter(([, stage]) => stage <= requiredStructuralStage).map(([capability]) => capability),
                  reason_codes: readiness.readiness_reason_codes,
                  retry_after_ms: readiness.retry_after_ms ?? 1000,
                  retryable: !unsupported && readiness.structural_build_state === "building",
                  source_safe_fallback_operations: [...SOURCE_OPERATIONS],
                });
              }
            }
          }
          if (request.call === "core:query") {
            const registered = registry.get(workspaceId);
            const requiredFrontier = admission?.required_frontier ?? "source";
            if (registered !== undefined && requiredFrontier !== "structural") {
              const readiness = await workspaceReadiness(registered, storage, semanticMaterializations, scanInFlight.has(workspaceId));
              if (!frontierReady(readiness, requiredFrontier)) {
                const blocking = admission?.blocking_stages[0];
                throw new DaemonError("core:coverage_incomplete", `Required ${requiredFrontier} frontier for workspace ${workspaceId} is not ready.`, { required_frontier: requiredFrontier, blocking_stage: blocking?.stage_id ?? requiredFrontier, blocking_operation: blocking?.operation ?? "unknown", statuses: readiness.readiness_reason_codes, waited_ms: 0, retry_after_ms: readiness.retry_after_ms ?? 1000, retryable: readiness.source_build_state === "building" || readiness.structural_build_state === "building" });
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
            const hydrationStartedAt = Date.now();
            try {
              const page = attachIndexFreshness(await engine.execute(queryRequest, context.signal), registry.get(workspaceId));
              emitTiming("hydration", `hydration_ms=${Math.max(0, Date.now() - hydrationStartedAt)}`);
              emitTiming("execution", `execution_ms=${Math.max(0, Date.now() - executionStartedAt)}`);
              return page;
            } finally { enforceWarmRecordsBudget(queryEngines, warmRecordsLru); }
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
          const cancelJob = (): void => queryJob.cancel();
          if (context.signal.aborted) cancelJob();
          else context.signal.addEventListener("abort", cancelJob, { once: true });
          try { return await queryJob.promise; }
          finally { context.signal.removeEventListener("abort", cancelJob); }
        }
        if (request.call === "core:workspace_preview") {
          const root = workspaceRootFromRequest(request.payload);
          if (root === undefined) throw new DaemonError("core:ipc_request_invalid", "workspace preview requires a workspace path.");
          const proposal = await detectWorkspacePreview(root, pluginCatalog, context.reportProgress);
          return { proposal_id: `proposal:${proposal.proposal_fingerprint.slice("sha256:".length)}`, ...proposal, confirmation_required: true };
        }
        if (options.workspace_registry && request.call === "core:workspace_admin_list") {
          return { api_version: 1, workspaces: options.workspace_registry.listIncludingRemoved().map((workspace) => workspaceAdministrativeView(options.workspace_registry!, workspace, scanActivities.get(workspace.workspace_id))) };
        }
        if (options.workspace_registry && request.call === "core:workspace_admin_show") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const workspaceId = typeof args[0] === "string" ? args[0] : typeof requestRecord(payload["values"])["workspace"] === "string" ? requestRecord(payload["values"])["workspace"] as string : undefined;
          const workspace = workspaceId === undefined ? undefined : options.workspace_registry.get(workspaceId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          return { api_version: 1, workspace: workspaceAdministrativeView(options.workspace_registry, workspace, scanActivities.get(workspace.workspace_id)) };
        }
        if (options.workspace_registry && request.call === "core:codebase_list") {
          return { api_version: 1, codebases: options.workspace_registry.listCodebases().map((codebase) => ({ ...codebase, project_name: codebase.display_name, workspace_count: options.workspace_registry!.members(codebase.codebase_id).length })), workspaces: options.workspace_registry.list().map((workspace) => workspaceAdministrativeView(options.workspace_registry!, workspace, scanActivities.get(workspace.workspace_id))) };
        }
        if (options.workspace_registry && request.call === "core:codebase_create") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const displayName = typeof args[0] === "string" ? args[0] : undefined;
          if (displayName === undefined) throw new DaemonError("core:ipc_request_invalid", "codebase create requires a display name.");
          const vcsIdentity = typeof requestRecord(payload["values"])["vcs-identity"] === "string" ? requestRecord(payload["values"])["vcs-identity"] as string : undefined;
          return { api_version: 1, codebase: options.workspace_registry.createCodebase(displayName, vcsIdentity) };
        }
        if (options.workspace_registry && request.call === "core:codebase_rename") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          if (typeof args[0] !== "string" || typeof args[1] !== "string") throw new DaemonError("core:ipc_request_invalid", "codebase rename requires an identifier and display name.");
          return { api_version: 1, codebase: options.workspace_registry.renameCodebase(args[0], args[1]) };
        }
        if (options.workspace_registry && (request.call === "core:codebase_assign" || request.call === "core:codebase_unassign")) {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const workspaceId = typeof args[0] === "string" ? args[0] : undefined;
          const codebaseId = request.call === "core:codebase_assign" && typeof args[1] === "string" ? args[1] : undefined;
          if (workspaceId === undefined || (request.call === "core:codebase_assign" && codebaseId === undefined)) throw new DaemonError("core:ipc_request_invalid", "codebase assignment requires explicit identifiers.");
          return { api_version: 1, workspace: options.workspace_registry.assignCodebase(workspaceId, codebaseId) };
        }
        if (options.workspace_registry && request.call === "core:codebase_remove") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const codebaseId = typeof args[0] === "string" ? args[0] : undefined;
          if (codebaseId === undefined) throw new DaemonError("core:ipc_request_invalid", "codebase remove requires an explicit identifier.");
          return { api_version: 1, codebase: options.workspace_registry.removeCodebase(codebaseId) };
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
            // The readiness poll can start immediately after this response is
            // sent. Ensure the durable catalog/database exists before making
            // the in-memory workspace observable as an active indexing
            // operation; otherwise `workspaceReadiness` can legitimately see
            // `storage:workspace_not_found` while the background scan is still
            // performing this same registration.
            if (confirmed && indexingStorage !== undefined) await ensureWorkspaceCatalogRegistration(existing, indexingStorage);
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
            // Workspace registration must stay O(1) with respect to the
            // repository contents. `administrativeState` performs a full
            // tracked-file byte comparison and belongs to explicit
            // administrative inspection, not the first-index admission path.
            project_name: projectNameForGitRoot(root, undefined),
          });
          // Index pack import (docs/decisions/23-index-pack.md): registered
          // BEFORE `scheduleWorkspaceScan` below so the scan hook's
          // first-ever-scan branch can see it regardless of how quickly the
          // scan job actually starts. `requestPayload["values"]` is the same
          // CLI `--index-pack <path>` / RPC `values["index-pack"]` field
          // every other free-form workspace-add option flows through.
          const indexPackPath = typeof requestRecord(requestPayload["values"])["index-pack"] === "string" ? requestRecord(requestPayload["values"])["index-pack"] as string : undefined;
          if (indexPackPath !== undefined) pendingIndexPackPaths.set(workspace.workspace_id, indexPackPath);
          // Complete the durable registration before exposing the confirmed
          // workspace to readiness polling and before scheduling its first
          // scan. The scan repeats this idempotently as a recovery guard, but
          // it must not be the first point at which the catalog becomes
          // visible.
          if (confirmed && indexingStorage !== undefined) await ensureWorkspaceCatalogRegistration(workspace, indexingStorage);
          const active = confirmed ? options.workspace_registry.beginReconciliation(workspace.workspace_id).workspace : workspace;
          if (confirmed) scheduleWorkspaceScan(active.workspace_id);
          if (watcherManager && confirmed) await startWorkspaceWatcher(watcherManager, active);
          return { workspace_id: active.workspace_id, status: active.status, registered: true, observation_started: confirmed, ...(confirmed ? {} : { confirmation_required: true }), ...(semanticModel === undefined ? {} : { semantic_model: semanticModel }) };
        }
        // Index pack export (docs/decisions/23-index-pack.md): read-only on
        // the workspace's own index (never mutates `workspace_registry` or
        // any published generation) -- its only side effect is writing a
        // pack file to local disk. `workspace` accepts either the workspace
        // id or its canonical root, mirroring every other admin RPC's
        // `workspaceRootFromRequest`-style lookup; `out` is the destination
        // path (`--out <path>` on the CLI).
        if (options.workspace_registry && indexingStorage && request.call === "core:index_pack_export") {
          const payload = requestRecord(request.payload);
          const args = Array.isArray(payload["args"]) ? payload["args"] : [];
          const values = requestRecord(payload["values"]);
          const workspaceRef = typeof args[0] === "string" ? args[0] : typeof values["workspace"] === "string" ? values["workspace"] : undefined;
          const outPath = typeof args[1] === "string" ? args[1] : typeof values["out"] === "string" ? values["out"] : undefined;
          if (workspaceRef === undefined) throw new DaemonError("core:ipc_request_invalid", "index pack export requires a workspace id or root.");
          if (outPath === undefined) throw new DaemonError("core:ipc_request_invalid", "index pack export requires an output path (--out).");
          const workspace = options.workspace_registry.get(workspaceRef) ?? options.workspace_registry.findByCanonicalRoot(workspaceRef);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          if (workspace.status !== "ready") throw new DaemonError("core:workspace_lifecycle", "Workspace must be ready before it can be exported as an index pack.");
          const requireGitClean = values["require-git-clean"] === "true";
          // The export runs in its own worker thread with its own storage
          // handle: its bulk row reads are synchronous by design (see
          // `exportIndexPack`'s `rawDatabase` comment), so running it here
          // would stall this runtime's event loop for the whole export.
          const result = await runIndexPackExportInThread({
            data_root: options.data_root,
            workspace_id: workspace.workspace_id,
            out_path: outPath,
            ...(requireGitClean ? { require_git_clean: true, canonical_root: workspace.canonical_root } : {}),
          });
          return { workspace_id: workspace.workspace_id, out_path: result.out_path, pack_id: result.manifest.pack_id, manifest_digest: result.manifest.manifest_digest, row_counts: result.manifest.row_counts };
        }
        if (options.workspace_registry && request.call === "core:workspace_remove") {
          const rootOrId = workspaceRootFromRequest(request.payload);
          const workspace = rootOrId === undefined ? undefined : options.workspace_registry.get(rootOrId);
          if (!workspace) throw new DaemonError("core:workspace_not_found", "Workspace is not registered.");
          const removed = options.workspace_registry.remove(workspace.workspace_id);
          await watcherManager?.stop(removed.workspace_id);
          await indexingStorage?.catalog.markWorkspaceRemoved({ ...removed, source_provider_bindings: [removed.provider] });
          // Evict `workspaceReadiness`'s module-level caches (rate-limit
          // timestamp, last-known-good snapshot) so a removed workspace id
          // cannot keep serving a stale readiness snapshot forever, and a
          // later re-add of the SAME id (a fresh registration can mint an
          // identical id if the caller controls `create_id`) starts cold
          // instead of inheriting a dead workspace's last reading.
          lastReadinessWarnAt.delete(removed.workspace_id);
          lastKnownSourceState.delete(removed.workspace_id);
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
      await descriptor.write({ protocol_version: 1, private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION, rpc_capabilities: rpcCapabilities, endpoint: paths.endpoint, pid: process.pid, owner_uid: process.getuid?.() ?? 0, engine_build_id: options.engine_build_id, started_at: new Date().toISOString() });
      options.on_startup_progress?.("provider_reconciliation");
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
              scheduleWorkspaceScan(workspace.workspace_id, undefined, [], workspace.status === "ready" ? "checking_for_updates" : "indexing");
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
      options.on_startup_progress?.("ready");
      return runtime;
    } catch (error) { await server?.close().catch(() => undefined); await indexingStorage?.close().catch(() => undefined); if (process.platform !== "win32") await unlink(paths.endpoint).catch(() => undefined); await lock.release(); throw error; }
  }
  status(): DaemonStatus { return { state: this.state, pid: process.pid, engine_build_id: this.options.engine_build_id, private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION, rpc_capabilities: daemonRpcCapabilities(this.options.workspace_registry !== undefined), endpoint: this.endpoint, active_jobs: this.scheduler.activeCount, restart_leases: this.scheduler.restartLeaseCount }; }
  byteTelemetrySnapshot(): Readonly<Record<string, unknown>> {
    return this.indexingStorage?.byteTelemetry.snapshot() ?? {};
  }
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
  async call(call: string, payload: unknown, options: LocalIpcRequestOptions = {}): Promise<IpcResponse> { return this.client.request(call, payload, options); }
}
