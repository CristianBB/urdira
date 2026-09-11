import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DaemonError } from "./errors.js";
import { basename, dirname, join, resolve } from "node:path";
import { administrativeState, DEFAULT_WORKSPACE_INCLUSION, ISOMORPHIC_GIT_OBJECT_PORT, attemptIndexPackImport, attemptWorkspaceFork, buildQueryAdmissionPlan, CanonicalRecordQueryDataPort, createLocalHashProvider, CursorCache, ensureV4Workspace, importV4IndexPack, NativeCanonicalQuerySnapshotPort, onRustWorkspaceUpgradeCompleted, QueryEngine, QueryOperationTelemetry, reconcileSemanticProjection, RecordBodyInterner, runRustWorkspaceScan, semanticMaterializationIdentity, sidecarDatabasePathFor, sidecarScanDirFor, SqliteCanonicalQuerySnapshotPort, structuralStoreDirFor, WorkspaceConfigurationCoordinator, detectWorkspaceTechnologies, summarizeWorkspaceTechnologyProposal, ParcelWatcherAdapter, watcherOptionsForSourceProvider, countFilesUpToBudget, KQUEUE_FILE_WATCH_BUDGET, reconcileLexicalProjection, resolveIndexStatusRequest, runProgressiveWorkspaceScan, runSourceOnlyWorkspaceScan, WorkspaceWatcherManager, type CanonicalQuerySnapshotPort, type ChangedPath, type QueryExecutionPage, type QueryOperationTelemetrySummary, type ReconcileSemanticProjectionResult, type ReconcileSummary, type RegisteredWorkspace, type ResolvedSemanticProvider, type RustWorkspaceScanTransport, type ScanScope, type ScanTimings, type WorkspacePluginCatalogEntry, type WorkspaceRegistry, type WorkspaceScanBudget, type WorkspaceScanPluginProvider, type QueryAdmissionPlan, type QueryFrontier, type RustIndexingCoreGenerationPort, type V4WorkspacePaths, type WorkspaceScanUpgradeCompleted } from "@urdira/engine";
import { operationRegistry, recipeDefinitions, type PluginCapabilityDeclaration, type QueryRequest, type SemanticMaterializationStatusView, type WorkspaceStructuralProgressView } from "@urdira/contracts";
import { createDurableStorage, isOutdatedWorkspaceError, isWorkspaceDatabaseFileOpen, readStructuralStore, recreateOutdatedWorkspaceDatabase, removeWorkspaceFootprint, workspaceFootprintEntries, workspaceSafeId, WorkspaceProjectionRepository, WORKSPACE_WRITER_BUSY_CODE, type CollectionOptions, type DurableStorage, type RepairComponentKind, type RepairRequest, type WorkspaceDatabase, type WorkspaceFootprintEntry } from "@urdira/storage";
import { sweepWorkspaceDataDir, type OrphanReport } from "./orphan-sweep.js";
import { existsSync } from "node:fs";
import { runIndexPackExportInThread } from "./index-pack-export-thread.js";
import { runIndexPackExportV4InThread } from "./index-pack-export-v4-thread.js";
import { runLexicalReconcileInThread, type LexicalThreadRun } from "./lexical-thread.js";
import { EndpointDescriptorStore, LastKnownGoodStore, ProcessLock, daemonPaths, type DaemonPaths } from "./ownership.js";
import { buildSemanticProvider, ensureSemanticAssets, type SemanticModelProvisioningNotice, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
import { ensureSemanticAssetsInProcess, runSemanticReconcileSharded, startNeuralSemanticProviderHost, type NeuralSemanticProviderHost, type SemanticProcessRun } from "./semantic-process.js";
import { resolveV4SemanticEntitySource } from "./semantic-v4-wiring.js";
import { IPC_DEFAULT_MAX_FRAME_BYTES, LocalIpcClient, LocalIpcServer, type LocalIpcClientOptions, type LocalIpcRequestOptions, type IpcProgress, type IpcResponse, type IpcRequestHandler } from "./protocol.js";
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
  /** Resolves the persistent Rust source writer for generic scans without a language plugin. */
  readonly resolve_source_indexing_core?: (workspace: RegisteredWorkspace, database: WorkspaceDatabase) => Promise<RustIndexingCoreGenerationPort | undefined>;
  /**
   * v4 (plan §9, P2-7): resolves the persistent `RustWorkspaceScanTransport`
   * (`@urdira/engine`'s `rust-workspace-scan.ts`) a v4 workspace's
   * `WorkspaceScan` commands are sent through. A v4 workspace never calls
   * `resolve_plugin_provider` above at all (there is no language-plugin
   * facts lane in v4 -- the composition worker does catalog, parse, and
   * materialize in one Rust-owned pass), so this is a SEPARATE resolver, not
   * a field on that one's return value. The composing application
   * (`apps/urdira/src/index.ts`) is expected to cache one transport per
   * workspace id (mirroring `resolve_plugin_provider`'s own
   * `indexingCoreSessions` map) and return the SAME instance on every call
   * for a given workspace, so the worker process backing it is spawned once
   * and reused across scans -- never spawned fresh per scan (see
   * `scheduleWorkspaceScan`'s v4 branch, which never terminates whatever
   * this returns). Returning `undefined` fails the scan with a diagnosable
   * error rather than silently falling back to any other route.
   */
  readonly resolve_workspace_scan_transport?: (workspace: RegisteredWorkspace) => Promise<RustWorkspaceScanTransport | undefined>;
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
  /** Rust composition-worker generations reconcile lexical projections
   * post-publication. When enabled, the daemon does not enqueue a duplicate
   * TypeScript lexical writer for ordinary structural scans. */
  readonly lexical_owned_by_rust?: boolean;
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
   * Frente S-H (`generic-waddling-hartmanis.md` §4, Part 1, fixing Bug 4 of
   * `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`): fires
   * once per genuine (`scheduler.submit` admitted, i.e. not coalesced into
   * `semanticMaintenancePending`) semantic-maintenance run, right as that
   * run starts -- BEFORE `runSemanticReconcileSharded`/`runSemanticReconcileInProcess`
   * is called. Test-only instrumentation (a plain counter in the test, not a
   * behavioral hook: nothing in production reads this) proving that a
   * no-change periodic reconciliation sweep no longer restarts an in-flight
   * semantic maintenance pass -- see `preemptMaintenanceForPublish`'s own
   * doc comment in `DaemonRuntime.start` for the fix this counts.
   */
  readonly on_semantic_maintenance_started?: (workspace_id: string) => void;
  /**
   * Burst-aggregation window (in ms) for watcher-triggered edit scans (see
   * `scheduleWorkspaceScan`'s `scanAggregationBuffers`/`flushScanAggregation`
   * below, `packages/daemon/src/runtime.ts`). Measured problem: when no scan
   * is currently in flight for a workspace, the FIRST watcher event of a
   * burst of N almost-simultaneous edits (an agent's multi-file write, or one
   * disk edit reported as several path events by the OS watcher) used to
   * start a scan immediately, so events 2..N -- arriving microseconds to a
   * few hundred ms later -- always missed that scan's `changed_uris` and had
   * to be coalesced into a SECOND, separate follow-up scan
   * (`pendingScans`) once the first one settled: one burst, two scans, ~2x
   * the scan floor. With this window set, the first genuine edit event
   * (`activity === "indexing"`, and only from the real filesystem watcher --
   * see `scheduleWorkspaceScan`'s `aggregatable` parameter) instead buffers
   * for up to this many ms, DEBOUNCED (reset) by every further event that
   * arrives inside the window, before the single resulting scan actually
   * starts with the union of every buffered URI/delete. Defaults to `200`
   * when omitted; `0` disables aggregation entirely (byte-for-byte today's
   * immediate-start behavior). Never applied to a passive
   * `checking_for_updates` sweep, to `core:workspace_add`/`core:reindex`'s
   * own first scan, to the post-scan `pendingScans` follow-up, or to any
   * other non-watcher call site -- none of those are watcher edit bursts, and
   * none of them should gain latency they do not have today. See
   * `scan_aggregation_max_ms` for the debounce's hard cap, and `core:query`'s
   * handler (`flushScanAggregation`) for the one thing that can force an
   * early flush.
   */
  readonly scan_aggregation_window_ms?: number;
  /**
   * Hard cap (in ms), measured from the FIRST buffered event, on how long
   * `scan_aggregation_window_ms`'s debounce can keep resetting before the
   * buffered scan is forced to start regardless. Without this cap, an agent
   * that edits in a near-continuous stream (each edit landing just inside the
   * rolling window) could postpone indexing indefinitely. Defaults to
   * `1_000` when omitted; only consulted while `scan_aggregation_window_ms`
   * is non-zero.
   */
  readonly scan_aggregation_max_ms?: number;
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
   * Frente S-D (2026-09-07, Lever 2): how many concurrent semantic
   * reconciler child processes `submitSemanticMaintenance` runs via
   * `runSemanticReconcileSharded` (`./semantic-process.js`) -- injected by
   * the composing application (`apps/urdira`) from the
   * `URDIRA_SEMANTIC_WORKERS` environment variable. Omitted (or `<= 1`)
   * degrades to exactly the pre-Lever-2 single-process path
   * (`runSemanticReconcileInProcess`) with ZERO behavior change -- see
   * `resolveSemanticShardCount`'s own doc comment for the default (2,
   * capped at `cpuCount / 4`) applied when this is omitted but the caller
   * still wants sharding (`apps/urdira` always resolves and passes a
   * concrete value; a test harness that omits this field entirely gets the
   * single-process path, matching every pre-Lever-2 test's own expectation).
   * Only takes effect on the THREADED/process-isolated branch
   * (`semanticThreadEligible`) -- the in-process fallback branch (a
   * `semantic_provider`/`semantic_runtime_hooks` override, or
   * `semantic_process: false`) always runs unsharded, single-process,
   * regardless of this field, since sharding is fundamentally a
   * multi-CHILD-PROCESS mechanism.
   */
  readonly semantic_shard_count?: number;
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
  /** P3-5 (plan §6.1's daemon-latency item): epoch ms this daemon process's `runtime.ts` module loaded at -- see its own doc comment (`DAEMON_START_EPOCH_MS`) for what an external caller uses this for. */
  readonly daemon_epoch_ms_offset: number;
  /**
   * v4 (plan §6, Frente H): the most recently computed orphan sweep's
   * summary (`OrphanReport.orphans`, see `orphan-sweep.ts`) -- refreshed at
   * startup and by every `core:workspace_orphans_list`/
   * `core:workspace_orphans_purge` call, never recomputed on every
   * `core:status` call (a live re-sweep is cheap but not free, and
   * `core:status` is polled far more often than either of those). Absent
   * when this daemon has no workspace registry/durable storage configured
   * at all (the same condition `orphaned_workspace_data`-producing RPCs
   * below are gated on).
   */
  readonly orphaned_workspace_data?: { readonly count: number; readonly bytes: number };
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

// Readiness transitions are process-local scheduling events; durable state
// remains authoritative and is re-read after every wake. The one-second timer
// is only a recovery backstop for transitions produced outside this runtime.
const readinessWaiters = new Map<string, Set<() => void>>();
function notifyReadinessChanged(workspaceId: string): void {
  const waiters = readinessWaiters.get(workspaceId);
  if (waiters === undefined) return;
  readinessWaiters.delete(workspaceId);
  for (const wake of waiters) wake();
}

function waitForReadinessChanged(workspaceId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      const waiters = readinessWaiters.get(workspaceId);
      waiters?.delete(finish);
      if (waiters?.size === 0) readinessWaiters.delete(workspaceId);
      resolve();
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = readinessWaiters.get(workspaceId);
      waiters?.delete(finish);
      if (waiters?.size === 0) readinessWaiters.delete(workspaceId);
      reject(new DaemonError("core:operation_cancelled", "Freshness wait was cancelled.", { workspace_id: workspaceId }));
    };
    const timer = setTimeout(finish, timeoutMs);
    const waiters = readinessWaiters.get(workspaceId) ?? new Set<() => void>();
    waiters.add(finish);
    readinessWaiters.set(workspaceId, waiters);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** `core:index_pack_export` (Frente P-1 fix, 2026-09-06): the bound on how
 * long the handler waits for `scanInFlight` to clear -- both for the initial
 * gate (a scan that has already called `registry.markReady` but not yet run
 * its own `scanInFlight.delete`) and between retries of an actual export
 * race. Generous relative to the measured live window (2-15ms) so it easily
 * absorbs a genuinely busy but SHORT scan tail too, while still bounded well
 * under a typical request timeout so a truly long-running concurrent scan
 * (a real edit-triggered reconcile) surfaces the ordinary lifecycle error
 * instead of hanging the RPC. Always additionally capped at the request's
 * own `deadline_at`. */
const INDEX_PACK_EXPORT_SCAN_SETTLE_WAIT_MS = 10_000;
/** `core:index_pack_export`: how many times to retry the whole export from
 * scratch after `exportV4IndexPack` reports `IndexPackExportRaceError` (its
 * own end-of-walk generation check found a concurrent scan published mid-
 * export) before giving up and surfacing the race to the caller. */
const INDEX_PACK_EXPORT_MAX_ATTEMPTS = 3;

/**
 * Waits, bounded by `deadlineMs`, for `scanInFlight` to stop containing
 * `workspaceId` -- used by `core:index_pack_export` (Frente P-1 fix,
 * 2026-09-06) so a request that lands in the brief window between
 * `workspace.status` flipping to `"ready"` (`registry.markReady`, inside
 * `runV4WorkspaceScan`) and that SAME scan's `scanInFlight.delete` a little
 * later (the scan job's own cleanup -- e.g. closing its now-unused
 * `WorkspaceDatabase` handle -- is a real, awaited disk operation, not free)
 * does not fail outright for a scan that has, in truth, already published
 * its final generation. Also doubles as the wait between export attempts
 * when a GENUINE concurrent scan republished mid-walk
 * (`IndexPackExportRaceError`): the same bounded polling loop, reused rather
 * than duplicated, covers both cases. Returns `true` once no scan is in
 * flight, `false` if the deadline (or the caller's abort signal) was hit
 * first while a scan was still running.
 */
/**
 * Best-effort, recursive directory size for `core:index_pack_export`'s own
 * progress denominator ONLY (2026-09-08 P0 fix) -- never awaited on the
 * export's own critical path in a way that could fail it: every I/O error
 * (a vanished file mid-walk, a permission error) is swallowed and simply
 * excluded from the running total, exactly like `orphan-sweep.ts`'s own
 * `directorySizeBytes` (not reused directly: that one is module-private and
 * this call site does not need its orphan-sweep-specific framing).
 */
async function directorySizeBytesForProgressEstimate(directoryPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) { total += await directorySizeBytesForProgressEstimate(fullPath); continue; }
    try { total += (await stat(fullPath)).size; } catch { /* vanished mid-walk: best-effort, never fatal. */ }
  }
  return total;
}

async function waitForScanSettled(workspaceId: string, scanInFlight: ReadonlySet<string>, signal: AbortSignal, deadlineMs: number): Promise<boolean> {
  while (scanInFlight.has(workspaceId)) {
    if (signal.aborted) return false;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return false;
    await waitForReadinessChanged(workspaceId, Math.max(1, Math.min(500, remainingMs)), signal);
  }
  return true;
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
    await waitForReadinessChanged(workspaceId, Math.max(1, Math.min(1_000, deadline - Date.now())), signal);
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
  // v4 (plan §9, P2-7): populated only by `v4WorkspaceReadinessFrom` (a v3
  // workspace's `WorkspaceReadiness` never sets these -- there is no
  // `Queryable`/`ScanCompleted` generation pair for a plugin-driven,
  // multi-stage v3 scan to report). Surfaced by `readinessPayload` as
  // `readiness.structural.queryable_generation`/`durable_generation` and
  // `readiness.lexical.completed_generation`/`readiness.semantic.completed_generation`.
  readonly structural_queryable_generation?: number;
  readonly structural_durable_generation?: number;
  readonly lexical_completed_generation?: number;
  readonly semantic_completed_generation?: number;
  // P1-D-c (decision 28): populated only by `v4WorkspaceReadinessFrom`, from
  // `V4WorkspaceReadinessState`'s own same-named fields -- see that
  // interface's doc comment. Surfaced by `v4StatusFields` as the
  // `semantic_upgrade` lane.
  readonly upgrade_completed_generation?: number;
  readonly upgrade_running?: boolean;
  readonly upgrade_pending_sites?: number;
  // P4-d (plan §9, user-facing status surfaces): which pipeline produced
  // this readiness -- "v4" only from `v4WorkspaceReadinessFrom`, "v3" only
  // from `workspaceReadiness`'s own v3 branch below. Consumed by
  // `v4StatusFields` to decide whether the queryable/durable generation
  // pair and the lexical/semantic completed-generation markers mean
  // anything for this workspace, or whether to fall back to the coarser
  // `structural_ready`/`semantic_ready` booleans v3 has always reported.
  readonly storage_format: "v3" | "v4";
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
/**
 * v4 (plan §9, P2-7): derives `WorkspaceReadiness` for a v4 workspace purely
 * from `v4ReadinessState`'s in-memory record -- see `workspaceReadiness`'s
 * own doc comment for why this is a separate function rather than a few
 * branches inside the v3 one. `structural_ready` flips true as soon as a
 * `Queryable` generation has been recorded (the harness/daemon readiness
 * contract this task's brief calls for: "make sure a v4 workspace reports
 * `structural_ready` at `Queryable`"), gated only on there being no recorded
 * scan failure.
 *
 * P3-5 (plan §6.1's daemon-latency item): this USED TO also require
 * `workspace.status !== "indexing"` -- which sounds like a reasonable extra
 * guard (mirroring v3's own convention) but is actually a hidden
 * serialization bug for v4: `workspace.status` only leaves `"indexing"` when
 * `registry.markReady` runs, and `runV4WorkspaceScan` (below) only calls
 * that AFTER the whole scan (`Queryable` AND `ScanCompleted`) has settled --
 * so this gate silently forced `structural_ready` to wait for the DURABLE
 * phase regardless of how early a live `Queryable` notification arrived,
 * defeating the entire point of tracking `queryable_generation` and
 * `durable_generation` separately. `runV4WorkspaceScan` now calls
 * `v4ReadinessState.set` (and rolls it back on a subsequent failure) the
 * MOMENT its own live `onQueryable` callback fires, live during the scan,
 * not after; `structural_ready` must therefore be derived purely from
 * `v4ReadinessState` having a `queryable_generation`, with no coupling to
 * the coarse `workspace.status` label a completely different concern
 * (`scheduleWorkspaceScan`'s own admission checks) still uses `"indexing"`
 * for. `scanRunning` (from `scanInFlight`, a THIRD, also-`"indexing"`-shaped
 * signal) is deliberately not consulted here either, for the same reason --
 * it is still used below for `structural_build_state`'s cosmetic value.
 */
function v4WorkspaceReadinessFrom(
  workspace: RegisteredWorkspace,
  state: V4WorkspaceReadinessState,
  semantic: ReadonlyMap<string, SemanticMaterializationStatusView>,
  scanRunning: boolean,
): WorkspaceReadiness {
  const queryable = state.queryable_generation !== undefined;
  const durable = state.durable_generation !== undefined;
  const structuralReady = queryable && workspace.last_scan_error === undefined;
  // v4 has no separate "source catalog written, structural analysis still
  // pending" phase to distinguish (plan §4: catalog, parse, and materialize
  // are one Rust-owned pass) -- source and structural readiness coincide.
  const sourceReady = structuralReady;
  const sourceSnapshotId = durable ? `source-snapshot:${state.durable_generation}` : undefined;
  // v4 storage wiring (2026-09-07): semantic maintenance now runs for v4
  // (`submitSemanticMaintenance`, `resolveV4SemanticEntitySource`) -- mirrors
  // v3's `workspaceReadiness` readiness computation exactly:
  // `semanticView.materialization_state === "complete"` AND its
  // `source_snapshot_id` matches the workspace's CURRENT structural
  // snapshot (guards against a stale view left over from a PRIOR scan while
  // a newer one is still in flight/pending its own semantic pass).
  const semanticView = semantic.get(workspace.workspace_id);
  const semanticReady = structuralReady && semanticView?.materialization_state === "complete" && semanticView.source_snapshot_id === workspace.current_snapshot_id;
  return {
    storage_format: "v4",
    source_ready: sourceReady,
    syntax_ready: structuralReady,
    structural_stage_1_ready: structuralReady,
    structural_ready: structuralReady,
    semantic_ready: semanticReady,
    ...(sourceSnapshotId === undefined ? {} : { source_snapshot_id: sourceSnapshotId }),
    ...(workspace.current_snapshot_id === undefined ? {} : { structural_snapshot_id: workspace.current_snapshot_id, ...(sourceSnapshotId === undefined ? {} : { structural_source_snapshot_id: sourceSnapshotId }) }),
    source_availability: sourceReady ? "available" : "unavailable",
    source_completeness: sourceReady ? "complete" : "unknown",
    source_freshness: sourceReady ? "equivalent" : "degraded",
    source_build_state: sourceReady ? "idle" : workspace.status === "indexing" ? "building" : "not_started",
    structural_availability: structuralReady ? "available" : "unavailable",
    structural_completeness: structuralReady ? "complete" : queryable ? "partial" : "unknown",
    structural_freshness: structuralReady ? "equivalent" : "degraded",
    structural_build_state: structuralReady ? "idle" : scanRunning ? "building" : "not_started",
    semantic_availability: semanticReady ? "available" : "unavailable",
    semantic_completeness: semanticReady ? "complete" : "unknown",
    semantic_build_state: semanticReady ? "idle" : structuralReady ? "building" : "not_started",
    readiness_reason_codes: [
      ...(sourceReady ? [] : ["core:source_catalog_unavailable"]),
      ...(structuralReady ? [] : [scanRunning ? "core:analysis_in_progress" : "core:structural_snapshot_unavailable"]),
      ...(semanticReady ? [] : [structuralReady ? "core:semantic_indexing_in_progress" : "core:structural_required"]),
    ],
    ...(scanRunning && !structuralReady ? { retry_after_ms: 1000 } : {}),
    ...(state.queryable_generation === undefined ? {} : { structural_queryable_generation: state.queryable_generation }),
    ...(state.durable_generation === undefined ? {} : { structural_durable_generation: state.durable_generation }),
    ...(state.lexical_completed_generation === undefined ? {} : { lexical_completed_generation: state.lexical_completed_generation }),
    ...(state.semantic_completed_generation === undefined ? {} : { semantic_completed_generation: state.semantic_completed_generation }),
    ...(state.upgrade_completed_generation === undefined ? {} : { upgrade_completed_generation: state.upgrade_completed_generation }),
    ...(state.upgrade_running === undefined ? {} : { upgrade_running: state.upgrade_running }),
    ...(state.upgrade_pending_sites === undefined ? {} : { upgrade_pending_sites: state.upgrade_pending_sites }),
  };
}

async function workspaceReadiness(
  workspace: RegisteredWorkspace,
  storage: DurableStorage | undefined,
  semantic: ReadonlyMap<string, SemanticMaterializationStatusView>,
  scanRunning: boolean,
): Promise<WorkspaceReadiness> {
  // v4 (plan §9, P2-7): a workspace `runV4WorkspaceScan` has ever touched
  // (its very first scan sets this the moment the scan starts, before any
  // generation has landed -- see that function's doc comment) is answered
  // ENTIRELY from `v4ReadinessState`'s in-memory record, never from a v3-shaped
  // DB read: v4's `source_index_state` table has no rows the Rust scan
  // pipeline ever writes (it commits `snapshots`/`workspace_current_state`
  // directly, in one transaction, with no separate progressive "catalog
  // phase" the way v3's multi-fragment source indexer has), so the v3 logic
  // below this branch would see `sourceState === undefined` forever and
  // report `source_ready: false` even after a real, durable v4 scan
  // completed. This is also strictly cheaper than v3's read-only DB open --
  // no I/O at all -- so there is no readiness-poll cost regression here.
  const v4State = v4ReadinessState.get(workspace.workspace_id);
  if (v4State !== undefined) return v4WorkspaceReadinessFrom(workspace, v4State, semantic, scanRunning);
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
    storage_format: "v3",
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
  // v4 (P2-7): `scripts/native-acceleration-controller.mjs` polls
  // `core:index_status` for `structural_ready` (already true, unchanged --
  // see `v4WorkspaceReadinessFrom`) AND `structural_durable`: `true` once
  // `ScanCompleted` has been observed for a v4 workspace
  // (`structural_durable_generation` set), or -- for a v3 workspace, which
  // never sets that field at all -- simply mirrors `structural_ready` (v3
  // has no separate queryable-vs-durable distinction: a v3 structural
  // snapshot is only ever visible once fully durable).
  const structuralDurable = readiness.structural_durable_generation !== undefined ? true : readiness.structural_ready;
  return {
    ...readiness,
    structural_durable: structuralDurable,
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
        // v4 (P2-7): `Queryable`/`ScanCompleted` generations -- see
        // `V4WorkspaceReadinessState`'s doc comment. Absent entirely for a
        // v3 workspace (neither field is ever set on its `WorkspaceReadiness`).
        ...(readiness.structural_queryable_generation === undefined ? {} : { queryable_generation: readiness.structural_queryable_generation }),
        ...(readiness.structural_durable_generation === undefined ? {} : { durable_generation: readiness.structural_durable_generation }),
      },
      semantic: {
        availability: readiness.semantic_availability,
        completeness: readiness.semantic_completeness,
        build_state: readiness.semantic_build_state,
        reason_codes: semanticReasonCodes,
        ...(readiness.semantic_completed_generation === undefined ? {} : { completed_generation: readiness.semantic_completed_generation }),
      },
      // v4 (P2-7): lexical maintenance is wired for v4 (unlike semantic --
      // see `runV4WorkspaceScan`'s doc comment); this sub-object only
      // appears once a completed pass has recorded a generation (v3
      // workspaces never set `lexical_completed_generation`, and a v4
      // workspace with no lexical pass completed yet also omits it, rather
      // than reporting a misleading `0`).
      ...(readiness.lexical_completed_generation === undefined ? {} : { lexical: { completed_generation: readiness.lexical_completed_generation } }),
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
 * P4-d (plan §9, user-facing status surfaces): additive `core:index_status`
 * fields for the v4 lane model -- `storage_format`, structural
 * queryable/durable generations plus a `queryable` convenience boolean,
 * lexical/semantic completion plus a `current` convenience boolean, the
 * last completed scan's kind/paths/timings/timeline, and two top-level
 * `search_text_ready`/`search_semantic_ready` booleans so a caller does not
 * have to re-derive "is this lane caught up" from the raw generation
 * numbers itself. Every field here is DERIVED from state already recorded
 * elsewhere (`WorkspaceReadiness`, `v4LastScanSummaries`,
 * `v4ActiveScanTimelines`/`v4LastScanTimelines` via the caller-supplied
 * `scanTimeline`, and the workspace's own `SemanticMaterializationStatusView`
 * for `profile_id`) -- nothing here performs I/O.
 *
 * A v3 workspace (`readiness.storage_format === "v3"`) never populates the
 * queryable/durable generation pair or the lexical/semantic completed
 * generation (see `workspaceReadiness`'s v3 branch and
 * `v4WorkspaceReadinessFrom`'s own doc comment) -- `lexical.current`/
 * `semantic.current`/`search_text_ready`/`search_semantic_ready` fall back
 * to the existing `structural_ready`/`semantic_ready` booleans for v3
 * rather than comparing generation numbers that do not exist for it, and
 * `last_scan` is omitted entirely for v3 (there is no v4-shaped
 * `ScanCompleted` timings breakdown to report).
 */
function v4StatusFields(
  readiness: WorkspaceReadiness,
  semanticView: SemanticMaterializationStatusView | undefined,
  lastScanSummary: V4LastScanSummary | undefined,
  scanTimeline: V4ScanTimeline | undefined,
): Record<string, unknown> {
  const isV4 = readiness.storage_format === "v4";
  const structuralDurableGeneration = readiness.structural_durable_generation;
  const lexicalCompletedGeneration = readiness.lexical_completed_generation;
  // "Current" means the lexical sidecar has closed out AT LEAST the
  // generation the structural snapshot durably published -- v4's lexical
  // maintenance (`reconcileLexicalProjection`, submitted on `ScanCompleted`)
  // runs asynchronously after the scan itself settles, so `search_text`
  // remains available (source-frontier gated, `queryRequiresStructural`)
  // but reports against a stale/partial lexical index until this catches
  // up. v3 has no equivalent tracked generation for lexical maintenance
  // (`workspaceReadiness`'s v3 branch never reads `lexicalCompletedGeneration`
  // at all) -- `structural_ready` is the closest existing signal.
  const lexicalCurrent = isV4
    ? lexicalCompletedGeneration !== undefined && structuralDurableGeneration !== undefined && lexicalCompletedGeneration >= structuralDurableGeneration
    : readiness.structural_ready;
  const semanticCompletedGeneration = readiness.semantic_completed_generation;
  // v4 storage wiring (2026-09-07): `readiness.semantic_ready` is now
  // meaningful for v4 too (`v4WorkspaceReadinessFrom` computes it from the
  // SAME `semanticMaterializationView`/current-snapshot comparison v3 uses)
  // -- no more `isV4`-only override to "always not current".
  const semanticCurrent = readiness.semantic_ready;
  return {
    storage_format: readiness.storage_format,
    structural: {
      ...(readiness.structural_queryable_generation === undefined ? {} : { queryable_generation: readiness.structural_queryable_generation }),
      ...(structuralDurableGeneration === undefined ? {} : { durable_generation: structuralDurableGeneration }),
      // v3 has no separate queryable-vs-durable phase (a v3 structural
      // snapshot is only ever visible once fully durable, `readinessPayload`'s
      // own `structuralDurable` comment above) -- `queryable` mirrors
      // `structural_ready` there instead of a generation comparison.
      queryable: isV4 ? readiness.structural_queryable_generation !== undefined : readiness.structural_ready,
    },
    lexical: {
      ...(lexicalCompletedGeneration === undefined ? {} : { completed_generation: lexicalCompletedGeneration }),
      current: lexicalCurrent,
    },
    semantic: {
      ...(semanticCompletedGeneration === undefined ? {} : { completed_generation: semanticCompletedGeneration }),
      current: semanticCurrent,
      ...(semanticView?.embedding_profile_id === undefined ? {} : { profile_id: semanticView.embedding_profile_id }),
    },
    // P1-D-c (decision 28): the background residual tsgo pass, v4-only
    // (a v3 workspace never sets any `upgrade_*` field, see
    // `V4WorkspaceReadinessState`'s own doc comment) -- `running` is a
    // best-effort daemon-side signal (optimistically `true` once a scan
    // completes with the pass enabled, cleared by the next
    // `upgrade_completed` event), and `pending_sites` is a snapshot from
    // that event's own report, not a live query against the current store.
    semantic_upgrade: {
      ...(readiness.upgrade_completed_generation === undefined ? {} : { completed_generation: readiness.upgrade_completed_generation }),
      ...(readiness.upgrade_pending_sites === undefined ? {} : { pending_sites: readiness.upgrade_pending_sites }),
      running: readiness.upgrade_running ?? false,
    },
    ...(isV4 && lastScanSummary !== undefined ? {
      last_scan: {
        kind: lastScanSummary.kind,
        ...(lastScanSummary.changed_paths === undefined ? {} : { changed_paths: lastScanSummary.changed_paths }),
        timings: lastScanSummary.timings,
        ...(scanTimeline === undefined ? {} : { timeline: relativeTimeline(scanTimeline) }),
        // Frente E: set only for `kind === "reconcile"`.
        ...(lastScanSummary.reconcile === undefined ? {} : { reconcile: lastScanSummary.reconcile }),
        // P-1 (2026-09-08): set only when this reconcile followed a
        // `core:index_pack_export` pack import -- see `V4LastScanSummary
        // .import`'s own doc comment.
        ...(lastScanSummary.import === undefined ? {} : { import: lastScanSummary.import }),
      },
    } : {}),
    // Folds the lane arithmetic above into one answer per operation family:
    // `search_text` is source-frontier gated (always "available" once
    // `source_ready`) but its RESULTS stay partial until the lexical sidecar
    // catches up, and `search_semantic` mirrors `semantic_ready` exactly
    // (v4 always false today, matching `runV4WorkspaceScan`'s own doc
    // comment that semantic maintenance is not wired for it yet).
    search_text_ready: readiness.source_ready && lexicalCurrent,
    search_semantic_ready: semanticCurrent,
    // P1-D-c: mirrors `search_text_ready`'s convenience-boolean pattern --
    // "has at least one residual pass ever upgraded a possible call/heritage
    // site to confirmed for this workspace" (a v3 workspace, or a v4
    // workspace whose pass has not completed even once yet, is `false`).
    calls_upgraded: readiness.upgrade_completed_generation !== undefined,
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

/**
 * `core:query`/`core:query_continue`'s `response_budget.max_characters` is
 * validated only against the engine's own generic ceiling
 * (`query-plan.ts`'s `MAX_RESPONSE_CHARACTERS`, 10,000,000) -- nothing ties
 * it to what THIS transport can actually carry. A caller can legally ask
 * for a multi-megabyte budget while the local IPC frame is fixed-size
 * (`LocalIpcServer`'s `max_frame_bytes`, default
 * `IPC_DEFAULT_MAX_FRAME_BYTES`); `CursorCache.readPage` now bounds a page
 * by that budget faithfully, so honoring an oversized budget verbatim just
 * moves the same hard failure from "silently unenforced" to "correctly
 * enforced but still too big for the wire" (`core:ipc_frame_too_large`).
 * Clamp the EFFECTIVE budget passed to the engine down to a fraction of the
 * frame instead, leaving headroom for the wire encoding's own overhead
 * (protobuf framing, the envelope fields around `streams`, and any OTHER
 * stream sharing the same frame) -- a caller's declared budget is still
 * honored verbatim whenever it is already frame-safe, and the signed cursor
 * this produces (`CursorCache`'s `next_cursor`) lets the caller page through
 * the rest instead of the whole request failing.
 */
const IPC_RESPONSE_CHARACTER_SAFETY_FACTOR = 0.5;
function frameSafeMaxCharacters(maxFrameBytes: number, requestedMaxCharacters: number): number {
  return Math.max(1, Math.min(requestedMaxCharacters, Math.floor(maxFrameBytes * IPC_RESPONSE_CHARACTER_SAFETY_FACTOR)));
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
/** Alias for the watcher-hint type `scheduleWorkspaceScan`'s pending/aggregation
 * buffers key authoritative deletes by, matching the inline `import(...)`
 * spelling already used at those call sites. */
type ScanWatcherHint = import("@urdira/engine").WatcherHint;
/**
 * Accumulator shape shared by `pendingScans` (events coalesced while a scan
 * is already in flight -- unchanged behavior) and `scanAggregationBuffers`
 * (events buffered BEFORE a watcher-triggered scan starts -- see
 * `DaemonRuntimeOptions.scan_aggregation_window_ms`'s doc comment). Both are
 * populated by the same `mergeScanRequestIntoBuffer` merge rules.
 */
interface ScanRequestBuffer {
  full: boolean;
  readonly uris: Set<string>;
  readonly authoritativeDeletes: Map<string, ScanWatcherHint>;
  readonly presencesAfterDeletes: Set<string>;
  activity: WorkspaceIndexingActivity;
}
function createScanRequestBuffer(activity: WorkspaceIndexingActivity): ScanRequestBuffer {
  return { full: false, uris: new Set(), authoritativeDeletes: new Map(), presencesAfterDeletes: new Set(), activity };
}
/**
 * Merges one incoming scan request (a watcher event, an explicit reindex, a
 * retry, ...) into an accumulator buffer, exactly matching the coalescing
 * rules `scheduleWorkspaceScan` has always applied while a scan is in
 * flight: an unsafe/lost-coverage request (`changedUris === undefined`)
 * supersedes and clears any narrower work already buffered; while an
 * authoritative-delete phase is ALREADY active -- buffered from an earlier,
 * separate merge call, or a scan for one is already in progress -- incoming
 * URIs are treated as post-delete presences (kept for a second, later
 * generation) rather than folded into the same scan as those deletes.
 *
 * P3-2 item 4: THIS call's own `authoritativeDeletes` no longer forces THIS
 * call's own `changedUris` into that deferred bucket (the old condition
 * included `authoritativeDeletes.length > 0` unconditionally, which
 * deferred a cross-path rename's create even when it arrived in the exact
 * same `on_reconcile` invocation as its matching delete -- see `packages/
 * engine/src/watchers.ts`'s `on_reconcile` call site, which now sends a
 * cross-path rename as ONE combined call). A same-batch delete+create pair
 * now folds into the SAME buffer generation (`buffer.uris` +
 * `buffer.authoritativeDeletes`, dispatched together by `flushScanAggregation`/
 * the post-scan `pendingScans` follow-up below); only a uri arriving in a
 * genuinely LATER, separate call (once a delete phase is already buffered
 * or running) still defers to a second generation, which is unavoidable --
 * a scan already in flight cannot retroactively grow its own `paths` list.
 */
function mergeScanRequestIntoBuffer(buffer: ScanRequestBuffer, changedUris: readonly string[] | undefined, authoritativeDeletes: readonly ScanWatcherHint[], activity: WorkspaceIndexingActivity, deletePhaseActive: boolean): void {
  if (activity === "indexing") buffer.activity = "indexing";
  if (changedUris === undefined) {
    buffer.full = true;
    buffer.uris.clear();
    buffer.authoritativeDeletes.clear();
    buffer.presencesAfterDeletes.clear();
  } else if (buffer.authoritativeDeletes.size > 0 || deletePhaseActive) {
    for (const uri of changedUris) buffer.presencesAfterDeletes.add(uri);
  } else {
    for (const uri of changedUris) buffer.uris.add(uri);
  }
  for (const event of authoritativeDeletes) buffer.authoritativeDeletes.set(event.normalized_uri, event);
}

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

/**
 * Extracts the ONE workspace this `core:query`/`core:query_continue`
 * request's admission/scheduling/readiness gates below key off.
 *
 * Frente Q-4 (2026-09-08): a `comparison` scope has no single workspace of
 * its own, but every admission gate below (structural-stage requirement,
 * freshness wait, job scheduling, warm-LRU touch) is written against
 * exactly one. Rather than rebuild that machinery symmetrically for N
 * participants, this admits a comparison request against its "target"
 * participant (or, absent that exact role, its first participant --
 * decision 03's own "General multi-workspace discovery uses caller order
 * and participant ordinal" for non-"base"/"target" roles): that participant
 * gets the FULL existing single-workspace freshness/structural-readiness
 * wait, exactly like any other query against it. Every OTHER participant's
 * readiness is instead probed inside `CanonicalRecordQueryDataPort.
 * executeCompare` itself (typed `core:coverage_incomplete`/
 * `core:workspace_not_found` per participant, not a symmetric admission
 * wait) -- a documented, asymmetric scope decision, not an oversight; see
 * `docs/evidence/2026-09-08-v4-identity-lookup-and-compare.md`.
 */
function singleWorkspaceScopeId(payload: unknown): string | undefined {
  const scope = requestRecord(requestRecord(payload)["scope"]);
  if (scope["scope_type"] === "single_workspace" && typeof scope["workspace_id"] === "string" && scope["workspace_id"].length > 0) return scope["workspace_id"];
  if (scope["scope_type"] === "comparison" && Array.isArray(scope["participants"])) {
    const participants = scope["participants"].map((participant) => requestRecord(participant));
    const primary = participants.find((participant) => participant["role"] === "target") ?? participants[0];
    if (primary !== undefined && typeof primary["workspace_id"] === "string" && primary["workspace_id"].length > 0) return primary["workspace_id"];
  }
  return undefined;
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
 * `QueryEngine` for it, opening and caching a read-only `WorkspaceDatabase`
 * and `QueryEngine` the first time a given workspace is queried, then reusing
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
interface CachedWorkspaceQueryEngine {
  readonly database: WorkspaceDatabase;
  readonly engine: QueryEngine;
  readonly data_port: CanonicalRecordQueryDataPort;
  /**
   * v4 plan P2-5: `NativeCanonicalQuerySnapshotPort` when
   * `workspace_meta.structural_store === "native"` AND the sibling
   * `<db>.structural/` directory exists, else `SqliteCanonicalQuerySnapshotPort`
   * (today's only path, still the default for every v3 workspace and any
   * v4 workspace that has not been converted). Both classes implement
   * `approxWarmBytes()`/`evictWarmRecords()` for the LRU loop below --
   * the native port's are no-ops (it holds no in-process record cache to
   * evict; the OS page cache backing its mmap reads is a different memory
   * class this budget does not track).
   */
  readonly snapshot_port: SqliteCanonicalQuerySnapshotPort | NativeCanonicalQuerySnapshotPort;
  readonly operation_telemetry?: QueryOperationTelemetry;
}

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

// `structuralStoreDirFor` (P2-5) is now `@urdira/engine`'s `structuralStoreDirFor`
// (`workspace-v4-bootstrap.ts`, P2-7) -- one shared definition, since
// `ensureV4Workspace` and this module must agree on exactly the same path.

async function acquireWorkspaceQueryEngine(workspaceId: string, registry: WorkspaceRegistry, storage: DurableStorage, cursorCache: CursorCache, cache: Map<string, CachedWorkspaceQueryEngine>, interner: RecordBodyInterner, lru: WarmRecordsLru, semanticProvider?: ResolvedSemanticProvider, allowSourceBinding = false): Promise<CachedWorkspaceQueryEngine> {
  const registeredWorkspace = await findQueryWorkspace(workspaceId, registry);
  const sourceWorkspace = allowSourceBinding ? registeredWorkspace : undefined;
  const resolution = registeredWorkspace !== undefined && registeredWorkspace.status !== "removed"
    ? { workspace_id: workspaceId }
    : { error: { code: "core:workspace_not_found" as const, details: { workspace_id: workspaceId } } };
  if ("error" in resolution) throw new DaemonError(resolution.error.code, `The requested query workspace ${workspaceId} is unavailable. Call urdira_index_status with the exact workspace_root and copy query_scope.workspace_id byte-for-byte; never synthesize or shorten a workspace id.`, resolution.error.details);
  const cached = cache.get(resolution.workspace_id);
  if (cached) { touchWarmLru(lru, resolution.workspace_id); return cached; }
  // Query engines never mutate workspace state. Keep their cached handles
  // explicitly read-only so the Rust composition worker remains the sole
  // structural/lexical writer and a query cannot accidentally open a
  // competing SQLite writer connection during publication.
  const database = await storage.openWorkspaceReadOnly(resolution.workspace_id);
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
  // v4 plan P2-5/§9: route to the native structural store only when this
  // workspace was actually converted/created for it (`workspace_meta.structural_store`)
  // AND its sibling `<db>.structural/` directory is actually present --
  // the meta flag alone is not enough (e.g. a fork/restore that copied the
  // catalog but not yet the structural directory), so this never silently
  // falls back to reading nonexistent structural data as if it were an
  // empty workspace.
  const structuralStoreDir = structuralStoreDirFor(database.database.filename);
  const structuralStoreKind = await readStructuralStore(database.database);
  // v4 (P2-7): `SqliteCanonicalQuerySnapshotPort`'s `search_literal`/
  // `semantic_index_state`/`semantic_vectors` methods run unqualified SQL
  // against `lexical_index_state`/`lexical_fts`/`lexical_documents`/
  // `vector_projection_rows`/`semantic_index_state` -- tables the v4 catalog
  // schema does not have at all (they live in the lexical/semantic sidecar
  // files, per docs/evidence/2026-09-02-v4-p2-1-schema.md). Without this,
  // `core:search_text` fails outright with "no such table:
  // lexical_index_state" for every v4 workspace, instead of the intended
  // "may be partial until lexical maintenance completes" contract.
  // `ensureV4Workspace` pre-creates each enabled sidecar before this
  // READ-ONLY connection tries to ATTACH it. The semantic file is
  // intentionally absent when semantic indexing is disabled, while the
  // lexical file remains available for text search.
  // ATTACHed table names are disjoint from the main schema's by
  // construction (P2-1), so leaving the unqualified references in that
  // shared port completely unchanged still resolves correctly.
  if (structuralStoreKind === "native") {
    for (const kind of ["lexical", "semantic"] as const) {
      const sidecarPath = sidecarDatabasePathFor(database.database.filename, kind);
      if (!existsSync(sidecarPath)) continue;
      try {
        await database.database.exec(`ATTACH DATABASE '${sidecarPath.replace(/'/g, "''")}' AS v4_${kind}`);
      } catch (error) {
        // Best-effort: a failed ATTACH (e.g. a transient file lock) must not
        // break structural queries -- it only means `search_literal`/
        // semantic reads see "no such table" until the NEXT cache miss
        // (workspace eviction/restart) retries the attach.
        console.error(`[urdira] failed to attach v4 ${kind} sidecar for workspace ${resolution.workspace_id}:`, error);
      }
    }
  }
  const sqliteSnapshotPort = new SqliteCanonicalQuerySnapshotPort(database.database, storage.cas, interner);
  const snapshotPort = structuralStoreKind === "native" && existsSync(structuralStoreDir)
    ? NativeCanonicalQuerySnapshotPort.open(database.database, structuralStoreDir, sqliteSnapshotPort, interner)
    : sqliteSnapshotPort;
  // Frente Q-4 (2026-09-08): `core:compare`'s comparison scope needs each
  // participant workspace's OWN snapshot port -- this closure recurses back
  // into the SAME `acquireWorkspaceQueryEngine`/`cache` this workspace's own
  // engine was just built from, so a comparison participant is served from
  // exactly the same cache, connection lifecycle, and warm-LRU accounting
  // as a direct `core:query` against that workspace. Never invoked at
  // construction time (only lazily, inside an actual `core:compare` call,
  // long after this workspace's own entry is already in `cache`), so there
  // is no self-recursion hazard resolving a workspace against its own
  // not-yet-cached entry.
  const comparisonParticipantResolver = (participantWorkspaceId: string): Promise<CanonicalQuerySnapshotPort> =>
    acquireWorkspaceQueryEngine(participantWorkspaceId, registry, storage, cursorCache, cache, interner, lru, semanticProvider).then((entry) => entry.snapshot_port);
  const dataPort = new CanonicalRecordQueryDataPort(snapshotPort, { ...(semanticProvider === undefined ? {} : { semantic: semanticProvider }), comparison_participants: comparisonParticipantResolver });
  // Query instrumentation is deliberately opt-in because canonical byte
  // accounting and event-loop histograms add measurable work. The existing
  // --debug-timing switch enables one bounded lifetime aggregator per cached
  // workspace without changing MCP/query response models.
  const operationTelemetry = readinessTimingEnabled() ? new QueryOperationTelemetry() : undefined;
  const engine = new QueryEngine({
    data_port: dataPort,
    cursor_cache: cursorCache,
    ...(operationTelemetry === undefined ? {} : { operation_telemetry: operationTelemetry }),
  });
  const entry: CachedWorkspaceQueryEngine = {
    database,
    engine,
    data_port: dataPort,
    snapshot_port: snapshotPort,
    ...(operationTelemetry === undefined ? {} : { operation_telemetry: operationTelemetry }),
  };
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
  const detection = summarizeWorkspaceTechnologyProposal(detectWorkspaceTechnologies({
    provider_fingerprint: workspaceDigest(root),
    git_state_fingerprint: "git:unresolved",
    plugin_catalog_fingerprint: pluginCatalogFingerprint(catalog),
    plugin_catalog: catalog,
    files,
  }));
  const vcsState = await administrativeState(root, ISOMORPHIC_GIT_OBJECT_PORT, () => new Date().toISOString()).then((state: { readonly vcs_state: unknown }) => state.vcs_state as Readonly<Record<string, unknown>>).catch(() => undefined);
  return { ...detection, ...(vcsState === undefined ? {} : { vcs_state: vcsState, suggested_codebase_vcs_identity: vcsState["common_repository_id"] }) };
}

async function startWorkspaceWatcher(manager: WorkspaceWatcherManager, workspace: RegisteredWorkspace): Promise<void> {
  try {
    const root = workspace.canonical_root;
    if (!(await stat(root)).isDirectory()) return;
    // Frente S-E (2026-09-07): a budget-capped estimate of this workspace's
    // own file count, so `watcherOptionsForSourceProvider` can fall back to
    // fs-events for a corpus large enough that kqueue's one-fd-per-watched-file
    // cost would threaten this daemon's ability to spawn its own child
    // processes (the confirmed root cause of `spawn EBADF` at n8n scale --
    // see `KQUEUE_FILE_WATCH_BUDGET`'s own doc comment). Errors (permissions,
    // a root that vanished mid-walk) resolve to `undefined` -- exactly like
    // omitting the estimate entirely -- so a failed estimate never blocks
    // watcher startup, it only forgoes the fd-budget fallback for this one
    // workspace.
    const fileCountEstimate = await countFilesUpToBudget(root, KQUEUE_FILE_WATCH_BUDGET).catch(() => undefined);
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
      }, { watcher_options: watcherOptionsForSourceProvider(workspace.provider.source_provider, fileCountEstimate), on_error: (error: Error) => console.error(`[urdira] watcher error for workspace ${workspace.workspace_id} (${workspace.display_root}):`, error) }),
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
 * v4 (plan §9/P4-b-2, default flip): the v4 (Rust-owned `WorkspaceScan` +
 * native structural store) route is now the DEFAULT for NEWLY added
 * workspaces -- opt out with the exact string `"0"` (not merely falsy: an
 * empty string, `"false"`, or any other value still means v4, matching this
 * function's pre-flip convention of one exact string deciding the outcome,
 * just inverted). `URDIRA_V4=1` continues to work (redundant with the new
 * default, kept so nothing that already sets it explicitly needs to
 * change). An existing workspace's database file already exists (as
 * whichever format it was created with) by the time this runs, so
 * `ensureV4Workspace` sees it and no-ops, leaving it untouched: there is no
 * default-flip-triggered migration, only a routing decision for a workspace
 * that does not have a database file yet (`docs/versioning.md`'s v4
 * index-contract-bump note; decision 29's own "Open items" listed this flip
 * as outstanding for P4).
 *
 * `URDIRA_V4=0` is documented as a one-release opt-out (`docs/versioning.md`,
 * `docs/README.md`): a later release may remove the v3 route entirely, at
 * which point this function -- and the flag -- go away.
 *
 * Called from every `registerWorkspace`/`ensureWorkspaceCatalogRegistration`
 * call site (this function is idempotent, so calling it once per site is
 * exactly as safe as calling it once per process) rather than gated on "is
 * this the very first scan": a workspace's very first `registerWorkspace`
 * call can happen from `core:workspace_add`, from `scheduleWorkspaceScan`'s
 * own registration (a fresh workspace whose `core:workspace_add` response
 * already returned but whose background scan had not yet registered it),
 * or from `withWorkspaceDatabase` (an administrative RPC racing either of
 * those) -- there is no single "the" first call site to special-case.
 */
function isV4Enabled(): boolean {
  return process.env["URDIRA_V4"] !== "0";
}
async function maybeBootstrapV4Workspace(workspaceId: string, storage: DurableStorage, createSemanticSidecar = true): Promise<void> {
  if (!isV4Enabled()) return;
  await ensureV4Workspace({ storage, workspace_id: workspaceId, create_semantic_sidecar: createSemanticSidecar });
}

/**
 * Makes the durable workspace registration visible before an indexing
 * operation is exposed through the in-memory registry. `core:workspace_add`
 * publishes `indexing` immediately and the readiness poll starts as soon as
 * that response is received; leaving catalog/database creation to the first
 * background scan therefore creates a real `storage:workspace_not_found`
 * window between those two events.
 */
async function ensureWorkspaceCatalogRegistration(workspace: RegisteredWorkspace, storage: DurableStorage, createSemanticSidecar = true): Promise<void> {
  await maybeBootstrapV4Workspace(workspace.workspace_id, storage, createSemanticSidecar);
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

/**
 * v4 (plan §9, P2-7): in-memory readiness facts for a v4 workspace, updated
 * by `runV4WorkspaceScan` below and consulted by `workspaceReadiness`'s own
 * v4 branch. This is a SEPARATE source of truth from v3's `workspaceReadiness`
 * (which reads `source_index_state`/`snapshots` off the workspace database
 * via `openWorkspaceReadOnly`) rather than an extension of it, because the
 * v4 catalog schema has no `source_index_state` rows written by the Rust
 * scan pipeline (it writes `snapshots`/`workspace_current_state` directly,
 * in one transaction, with no separate "catalog phase" the way v3's
 * multi-fragment source indexer has) -- deriving v3-shaped readiness from
 * that would either require guessing or a second DB read per poll, neither
 * of which this fast in-memory record needs.
 *
 * `queryable_generation` and `durable_generation` are set TOGETHER, from the
 * one `RustWorkspaceScanOutcome` `runRustWorkspaceScan` resolves with: that
 * engine-layer helper (`@urdira/engine`'s `rust-workspace-scan.ts`) only
 * reports the intermediate `queryable` event's generation/timing AFTER the
 * whole scan has already completed (it has no live mid-flight callback
 * surface for a caller), and per docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md
 * §4.1, the current Rust pipeline's `write_base` call performs the
 * page-cache write, fsync, AND `MANIFEST` publish synchronously in one call
 * anyway -- there is no real wall-clock gap between "queryable" and
 * "durable" to observe yet. The two fields stay distinct in this record's
 * shape (and in `readinessPayload`'s `structural.queryable_generation`/
 * `durable_generation`) so a future engine-layer change that DOES expose a
 * live `Queryable` callback can flip `structural_ready` earlier without any
 * further shape change here.
 */
interface V4WorkspaceReadinessState {
  readonly queryable_generation?: number | undefined;
  readonly durable_generation?: number | undefined;
  readonly lexical_completed_generation?: number | undefined;
  readonly semantic_completed_generation?: number | undefined;
  // P1-D-c (decision 28): unlike every field above, these are NOT set by
  // `runV4WorkspaceScan` itself -- the background residual tsgo pass
  // finishes asynchronously, potentially minutes after the scan that
  // triggered it already updated every other field here. `upgrade_running`
  // is set optimistically (`true`) the moment a scan completes with the
  // pass enabled (`URDIRA_V4_RESIDUAL`), and `upgrade_completed_generation`/
  // `upgrade_pending_sites`/`upgrade_running: false` are set together by the
  // `onUpgradeCompleted` subscription in `runV4WorkspaceScan` once the pass
  // actually reports in -- see `handleV4UpgradeCompleted`.
  readonly upgrade_completed_generation?: number | undefined;
  readonly upgrade_running?: boolean | undefined;
  /** `unresolved_sites` as of the last completed residual pass -- a
   * point-in-time count from that pass's own report, NOT a live query
   * against the current store (no such query is wired here); `undefined`
   * until the first residual pass for this workspace completes in this
   * daemon process's lifetime. */
  readonly upgrade_pending_sites?: number | undefined;
  /**
   * Frente S-H (`generic-waddling-hartmanis.md` §4, Part 1): `true` once
   * `runV4WorkspaceScan` has called `submitSemanticMaintenance` for this
   * workspace at least once in this daemon process's lifetime -- lets a
   * LATER scan that turns out to be a `Reconcile`/`Noop` (nothing changed)
   * skip calling it again (see that call site's own doc comment for why:
   * without this, the periodic reconciliation sweep's coalesced-pending
   * retry mechanism spawns a whole new semantic-maintenance child process
   * on every sweep tick that lands while an earlier real pass is still
   * running, purely to re-confirm the already-complete fast path holds).
   * The very first call for a workspace always fires regardless of this
   * flag being unset -- including the one legitimate case where the FIRST
   * scan a workspace ever sees is itself a `Reconcile` (an index-pack
   * import onto an already-current donor tree, plan §7.1.3): `undefined`
   * here is indistinguishable from "never submitted", so that call is never
   * skipped.
   */
  readonly semantic_maintenance_submitted?: boolean | undefined;
}
const v4ReadinessState = new Map<string, V4WorkspaceReadinessState>();
/**
 * P1-D-c: per-workspace-process (decision 29) transport instances are
 * reused across scans, so this tracks which ones this daemon process has
 * already registered an `onUpgradeCompleted` subscription against --
 * `runV4WorkspaceScan` calls `resolveTransport` on every scan, and without
 * this guard a long-lived workspace would accumulate one duplicate-firing
 * listener per scan for the rest of the process's life.
 */
const v4UpgradeSubscribed = new WeakSet<RustWorkspaceScanTransport>();

/**
 * Applies one `onUpgradeCompleted` event to `v4ReadinessState`, preserving
 * every other field already recorded for `workspaceId` (a plain `.set`
 * with a partial object -- the map's writers do not merge automatically,
 * see the `runV4WorkspaceScan` call site's own comment on why every field
 * must be carried forward explicitly there too). `event.request_id` is
 * available (correlating back to the exact `workspace_scan` request that
 * triggered this pass) but not needed for routing here: decision 29's
 * per-workspace worker process means `transport` (and therefore this
 * closure's captured `workspaceId`) already IS that correlation.
 */
function handleV4UpgradeCompleted(workspaceId: string, event: WorkspaceScanUpgradeCompleted): void {
  const prior = v4ReadinessState.get(workspaceId);
  v4ReadinessState.set(workspaceId, {
    ...prior,
    upgrade_completed_generation: event.generation,
    upgrade_running: false,
    upgrade_pending_sites: event.unresolved_sites,
  });
  notifyReadinessChanged(workspaceId);
}

/**
 * P3-5 (plan `resilient-knitting-twilight.md` §6.1's daemon-latency item):
 * epoch ms captured at module load (effectively "the daemon's start" -- this
 * module loads once, early in `DaemonRuntime.start`'s own import chain, well
 * before any workspace scan can run). Every timestamp in a `V4ScanTimeline`
 * (below) is reported relative to this zero point via `relativeTimeline`, so
 * `core:index_status`'s `last_scan_timeline` carries small, stable numbers
 * instead of raw wall-clock epoch values. `core:status`'s
 * `daemon_epoch_ms_offset` field exposes this same constant so an external
 * harness -- which has its own epoch-ms clock for the moment it performed a
 * mutation's filesystem write (`performance.timeOrigin + performance.now()`,
 * the same clock family `Date.now()` is drawn from) -- can add it back to a
 * reported relative timestamp and diff against its own write timestamp on
 * the SAME clock, rather than being limited to poll-granularity latency.
 */
const DAEMON_START_EPOCH_MS = Date.now();

/**
 * `URDIRA_DEBUG_TIMING=1` gate for a one-line-per-milestone log at every
 * point `V4ScanTimeline` (below) is populated. Off by default -- this is a
 * diagnostic aid for attributing daemon-side edit latency (plan §6.1), not a
 * normal daemon log line.
 */
function debugTiming(line: string): void {
  if (process.env["URDIRA_DEBUG_TIMING"] === "1") console.error(`[urdira][timing] ${line} t=${Date.now() - DAEMON_START_EPOCH_MS}ms`);
}

/**
 * P3-5: one v4 workspace scan's own wall-clock milestones (epoch ms,
 * reported relative to `DAEMON_START_EPOCH_MS`). `core:index_status` exposes
 * the most recently touched (in-flight, then settled) scan's timeline for a
 * v4 workspace as `last_scan_timeline`. Every field is best-effort: a scan
 * that did not originate from a real watcher burst (the first-ever cold
 * scan, `core:reindex`, the periodic reconciliation sweep) has no
 * `fs_event_at`/`aggregated_at` to report, and a scan that fails before
 * reaching a milestone simply never sets the later fields -- reported
 * partially rather than withheld entirely, since a partial timeline is still
 * evidence of where time went.
 */
interface V4ScanTimeline {
  fs_event_at?: number;
  aggregated_at?: number;
  request_sent_at?: number;
  queryable_at?: number;
  completed_at?: number;
  readiness_updated_at?: number;
}
/**
 * Timeline fields observed so far for a workspace's CURRENT watcher-burst
 * buffer, before a scan has actually been admitted (`scanInFlight.add`) --
 * populated by `scheduleWorkspaceScan`'s aggregation branch and
 * `flushScanAggregation`, consumed (moved into `v4ActiveScanTimelines`) at
 * admission.
 */
const v4PendingScanTimelines = new Map<string, V4ScanTimeline>();
/**
 * The timeline for the scan currently in flight for a workspace (from
 * admission through settlement), populated by `runV4WorkspaceScan`. Moved
 * into `v4LastScanTimelines` once the scan settles, success or failure.
 */
const v4ActiveScanTimelines = new Map<string, V4ScanTimeline>();
/** The most recently settled scan's timeline, exposed via `core:index_status`'s `last_scan_timeline` (relative ms, see `relativeTimeline`). */
const v4LastScanTimelines = new Map<string, V4ScanTimeline>();

/**
 * P4-d: the last SUCCESSFULLY completed v4 scan's scope kind, changed-path
 * count, and `ScanCompleted` timings breakdown -- surfaced via
 * `core:index_status`'s `last_scan` (see `v4StatusFields`). Populated only
 * on success (`runV4WorkspaceScan`'s success path, right alongside
 * `v4LastScanTimelines`); a failed attempt has no `ScanCompleted` timings to
 * report and leaves whatever was recorded for the PRIOR successful scan in
 * place, matching `v4ReadinessState`'s own "never regress on failure"
 * convention.
 */
interface V4LastScanSummary {
  readonly kind: "full" | "changed" | "reconcile";
  readonly changed_paths?: number;
  readonly timings: ScanTimings;
  /** Frente E: set only when `kind === "reconcile"`. */
  readonly reconcile?: ReconcileSummary;
  /**
   * P-1 (2026-09-08): set only when this scan followed a `core:index_pack_export`
   * pack import (`importedFromIndexPack`) -- covers the whole
   * `importPendingV4IndexPack` call (stat + native copy/verify + atomic
   * rename), which the `reconcile` scan that ALWAYS follows a successful
   * import (see `docs/decisions/23-index-pack.md`'s "Reconcile follow-up,
   * not full" section) does not otherwise capture at all. `imported: false`
   * still reports `import_wall_ms` for a failed/rolled-back import attempt
   * (root verification failure, or a thrown error) -- the corpus falls
   * through to an ordinary `full` scan in that case, but the import attempt
   * itself still cost real wall time worth surfacing.
   */
  readonly import?: { readonly imported: boolean; readonly import_wall_ms: number; readonly pack_bytes?: number };
}
const v4LastScanSummaries = new Map<string, V4LastScanSummary>();

/**
 * Frente E: explicit opt-out from `reconcile`'s new default for a v4 scan
 * whose `requestedUris === undefined` (see `runV4WorkspaceScan`'s scope
 * decision) -- populated by `core:reindex` and by the outdated-workspace-
 * format recovery sweep (`createDurableStorage`'s startup pass, below),
 * both of which genuinely need a `full` republish regardless of how small
 * an authoritative delta would measure (an explicit user-requested reindex,
 * or a workspace whose on-disk format was just recreated from scratch).
 * Consumed (deleted) by the SAME scope decision on its very next scan --
 * a one-shot flag, not a standing preference for the workspace.
 */
const forceFullScans = new Set<string>();

/** Converts a `V4ScanTimeline`'s absolute epoch-ms fields to `DAEMON_START_EPOCH_MS`-relative ms for the `core:index_status` wire shape (`last_scan_timeline`'s own doc comment above). */
function relativeTimeline(timeline: V4ScanTimeline): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(timeline)) if (value !== undefined) out[key] = value - DAEMON_START_EPOCH_MS;
  return out;
}

/** Rate-limits the "Changed scope rejected as uninitialized, falling back to Full" warning to once per workspace (see `runV4WorkspaceScan` below) -- P3-1 landed the real `ScanScope::Changed` path server-side; the only legitimate reason it can still reject a `Changed` request is the worker having no prior generation/state cached for this workspace (a fresh worker process, or a workspace this worker has never scanned before), which requires a `Full` scan first regardless. */
const v4ChangedScopeUnsupportedWarned = new Set<string>();

/** Builds the `ChangedPath[]` a v4 watcher-driven scan attempts (plan §9, P2-7): a delete always wins over a same-path modify/create hint arriving in the same coalesced buffer (mirrors `mergeScanRequestIntoBuffer`'s own delete-phase precedence). P3-1: `ScanScope::Changed` is now a real, implemented path server-side (`crates/urdira-indexing-worker/src/v4/delta.rs`). Every non-delete path is still mapped to `kind: "modified"` here rather than distinguishing a genuine create -- this is intentionally NOT a correctness gap: the Rust side never trusts a caller-declared `kind` for its own added/changed/deleted classification (`urdira_source_frontier::Delta::compute_partial` re-derives that from re-observing the filesystem against its own cached frontier, `crates/urdira-indexing-worker/src/v4/delta.rs`'s module doc), so a "modified" hint for a path the frontier has never seen before is classified as `added` regardless of what this function declared. Threading a real created/modified distinction through the watcher's own event stream is a documented follow-up, not required for this path's correctness today. */
function mapV4ChangedPaths(requestedUris: readonly string[] | undefined, authoritativeDeletes: readonly ScanWatcherHint[]): ChangedPath[] {
  const byPath = new Map<string, ChangedPath>();
  for (const uri of requestedUris ?? []) byPath.set(uri, { path: uri, kind: "modified" });
  for (const event of authoritativeDeletes) byPath.set(event.normalized_uri, { path: event.normalized_uri, kind: "deleted" });
  return [...byPath.values()];
}

interface RunV4WorkspaceScanInput {
  readonly workspace: RegisteredWorkspace;
  readonly workspaceId: string;
  readonly durableStorage: DurableStorage;
  readonly requestedUris: readonly string[] | undefined;
  readonly authoritativeDeletes: readonly ScanWatcherHint[];
  readonly activity: WorkspaceIndexingActivity;
  readonly registry: WorkspaceRegistry;
  readonly resolveTransport?: ((workspace: RegisteredWorkspace) => Promise<RustWorkspaceScanTransport | undefined>) | undefined;
  readonly submitLexicalMaintenance: (workspaceId: string) => void;
  /** v4 storage wiring (2026-09-07): submitted right alongside `submitLexicalMaintenance` on every successful v4 scan -- see this function's own success-path comment for why semantic maintenance is no longer skipped for v4. */
  readonly submitSemanticMaintenance: (workspaceId: string) => void;
  readonly semanticIndexEnabled: boolean;
  /** Frente P-1 (`generic-waddling-hartmanis.md` §7.1): the SAME
   * workspace_id -> pack path side channel `core:workspace_add`'s v3 branch
   * already consumes (`pendingIndexPackPaths`, `scheduleWorkspaceScan`'s
   * enclosing closure) -- passed through so this function's first-scan
   * branch can consume it too. Optional only so v4-scan unit tests that do
   * not exercise index-pack import at all can omit it. */
  readonly pendingIndexPackPaths?: Map<string, string>;
  /**
   * Frente S-H (`generic-waddling-hartmanis.md` §4, Part 1): called from
   * `onQueryableLive` below, the moment this scan's OWN run confirms a real
   * generation is about to publish (never invoked for a `Reconcile` scan
   * that resolves to `ReconcileMode.Noop` -- see
   * `preemptMaintenanceForPublish`'s own doc comment in
   * `DaemonRuntime.start` for the full mechanism this closes). Optional so
   * v4-scan unit tests that never populate `semanticThreadRuns`/
   * `lexicalThreadRuns` at all can omit it -- a no-op then, same as calling
   * `.abort()` on a map with no entry for this workspace.
   */
  readonly preemptMaintenanceForPublish?: (workspaceId: string) => void;
}

/**
 * Index pack import (Frente P-1, plan §7.1.3): consumes a pending
 * `--index-pack` path registered by `core:workspace_add` on a v4 workspace's
 * genuine first-ever scan. Imports into a fully disjoint staging area first
 * -- `<db>.import-staging-<uuid>` (the exact suffix the orphan sweep already
 * classifies as "in progress" for up to an hour, `packages/daemon/src/orphan-sweep.ts`'s
 * R15 classification) -- so a failure at ANY point (corrupt pack, a Merkle
 * mismatch, an I/O error mid copy) never touches the paths `ensureV4Workspace`
 * just bootstrapped: the caller falls through to an ordinary `full` scan of
 * the freshly-bootstrapped (still pristine) database exactly as if no pack
 * had been requested.
 *
 * Never throws (mirrors `attemptWorkspaceFork`/`attemptIndexPackImport`'s
 * own "never throws" contract, `index-pack.ts`) -- every failure is caught,
 * logged, and the staging directory removed before returning `false`.
 *
 * On success, swaps the staged files atomically into place with `rename`:
 * structural, then sidecar (if the pack carried one), then the catalog file
 * last. If a structural/sidecar rename fails, the catalog has NOT been
 * swapped yet -- the workspace is left exactly as before this attempt
 * (still the empty bootstrap database). The one situation this ordering
 * does not fully protect against -- the database rename itself failing
 * AFTER structural/sidecar already landed -- would leave the (still
 * generation-0) bootstrap database paired with a donor's structural files;
 * the very next `full` scope this function's caller naturally falls back to
 * unconditionally re-derives and republishes `structural/`/`merkle/*.tree`
 * for its own new generation regardless of whatever was already on disk
 * (`catalog::run_full_scan`), so this is self-healing rather than a stuck,
 * wedged state -- decided in implementation rather than hand-rolling a
 * multi-path rollback for a failure mode local same-filesystem `rename(2)`
 * calls essentially never hit in practice.
 */
interface V4IndexPackImportOutcome {
  readonly imported: boolean;
  /** Wall time for this whole function (stat + import + verify + atomic rename), regardless of outcome. */
  readonly import_wall_ms: number;
  /** `undefined` when the pack file itself could not be stat'd (already gone, or never a real path). */
  readonly pack_bytes?: number;
}

async function importPendingV4IndexPack(paths: V4WorkspacePaths, packPath: string, workspaceId: string): Promise<V4IndexPackImportOutcome> {
  // Adversarial-review fix (plan §7.1, R15/R17 cross-check): the staging
  // suffix MUST be appended onto each REAL final path, not derived by
  // running `structuralStoreDirFor`/`sidecarScanDirFor` on the already-
  // suffixed staging DATABASE path. The latter (the original shape here)
  // produced `<db>.import-staging-<uuid>.structural`/`...sidecar` -- which
  // does NOT match `orphan-sweep.ts`'s `IMPORT_STAGING_SUFFIX_PATTERN`
  // (anchored on the name ENDING in `.import-staging-<uuid>`) and instead
  // falls through to the generic `WORKSPACE_FOOTPRINT_SUFFIXES` match on
  // bare `.structural`/`.sidecar`, which strips only THAT suffix and
  // yields a bogus, never-registered safe_id (`<db>.import-staging-<uuid>`)
  // classified as an immediate orphan -- category `"footprint"`, NOT
  // `"staging"`, so it gets NONE of the one-hour `in_progress` grace a
  // staging root needs. A concurrent `workspace-orphans-purge --confirm`
  // (or any future automatic sweep) could delete an import's staging
  // structural/sidecar directory while this function is still copying
  // into it or about to `rename` it -- a real corruption/crash window, not
  // just a stray disk leak. Appending the same suffix directly onto
  // `paths.structural_root`/`paths.sidecar_root` (mirroring exactly how
  // `forkV4StructuralStore` builds `<safeId>.structural.fork-staging-
  // <uuid>`, per `orphan-sweep.ts`'s own doc comment) keeps the recognized
  // shape `<safeId>.structural.import-staging-<uuid>` /
  // `<safeId>.sidecar.import-staging-<uuid>` -- see the matching
  // `IMPORT_STAGING_SUFFIX_PATTERN` fix in `orphan-sweep.ts`.
  const stagingSuffix = `.import-staging-${randomUUID()}`;
  const stagingDatabasePath = `${paths.database_path}${stagingSuffix}`;
  const stagingStructuralRoot = `${paths.structural_root}${stagingSuffix}`;
  const stagingSidecarRoot = `${paths.sidecar_root}${stagingSuffix}`;
  const cleanupStaging = async (): Promise<void> => {
    await rm(stagingDatabasePath, { force: true }).catch(() => undefined);
    await rm(stagingStructuralRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagingSidecarRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  // Adversarial-review fault injection (plan §7.1 review, mirrors R2's
  // `URDIRA_V4_RECONCILE_FAIL_DELTA` convention): lets
  // `tests/phase-daemon-v4-index-pack.test.ts` deterministically exercise
  // the "second/third rename in the atomic swap fails" window without
  // relying on a real filesystem fault. Never read outside a test process
  // (an operator's env would need to set this by name on purpose).
  const failAfterRename = process.env["URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME"];
  // P-1 (2026-09-08): `import_wall_ms` measures this whole function --
  // stat, the native `importV4IndexPack` copy/verify call, and the atomic
  // rename swap -- so it is directly comparable to `reconcile_wall(noop)`
  // in the R20 formula (docs/decisions/23-index-pack.md, `docs/evidence/
  // 2026-09-07-v4-vscode-campaign.md` §6.2/§9 item 4, which previously had
  // to approximate this as `ready_elapsed_ms - reconcile_wall` because no
  // product-exposed metric isolated it).
  const importStartedAt = Date.now();
  const packBytes = await stat(packPath).then((info) => info.size).catch(() => undefined);
  try {
    const imported = await importV4IndexPack({
      packPath,
      targetDatabasePath: stagingDatabasePath,
      targetStructuralRoot: stagingStructuralRoot,
      targetSidecarRoot: stagingSidecarRoot,
      targetWorkspaceId: workspaceId,
    });
    if (!imported.roots_verified) {
      console.error(`[urdira] v4 index pack import for ${workspaceId} failed root verification (${imported.root_mismatches.join("; ")}); falling back to a full scan`);
      await cleanupStaging();
      return { imported: false, import_wall_ms: Date.now() - importStartedAt, ...(packBytes === undefined ? {} : { pack_bytes: packBytes }) };
    }
    await rename(stagingStructuralRoot, paths.structural_root);
    if (failAfterRename === "structural") throw new Error("URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME=structural (test-injected failure)");
    if (existsSync(stagingSidecarRoot)) await rename(stagingSidecarRoot, paths.sidecar_root);
    if (failAfterRename === "sidecar") throw new Error("URDIRA_V4_INDEX_PACK_IMPORT_FAIL_AFTER_RENAME=sidecar (test-injected failure)");
    // Stale `-wal`/`-shm`/`-journal` siblings of the bootstrap database this
    // import is about to replace belong to the OLD (about-to-be-discarded)
    // file -- clearing them first means the freshly-renamed-in catalog is
    // never paired with a WAL that describes a different schema/page count.
    for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${paths.database_path}${suffix}`, { force: true }).catch(() => undefined);
    await rename(stagingDatabasePath, paths.database_path);
    return { imported: true, import_wall_ms: Date.now() - importStartedAt, ...(packBytes === undefined ? {} : { pack_bytes: packBytes }) };
  } catch (error) {
    // NOTE (self-healing, verified live by
    // `tests/phase-daemon-v4-index-pack.test.ts`'s fault-injection tests):
    // if the structural (and/or sidecar) rename above already landed
    // before this catch runs, `paths.structural_root`/`paths.sidecar_root`
    // now hold the DONOR's files while `paths.database_path` is still the
    // untouched, generation-0 bootstrap catalog -- `cleanupStaging` cannot
    // undo an already-completed rename (its own staging source path is
    // gone). This is NOT a stuck/corrupt state: the caller (`runV4WorkspaceScan`)
    // falls back to a `full` scope because `importedFromIndexPack` stays
    // `false`, and a full scan's publish pipeline unconditionally rewrites
    // `MANIFEST` and every fixed-name file it lists (`records.tree`/
    // `dependency.tree`/... -- `urdira-structural-store`'s `merkle::persist`
    // overwrites those paths in place, never conditionally) for the
    // catalog's own new generation, regardless of whatever donor content
    // was left on disk. Readers only ever resolve through `MANIFEST`
    // (`reader.rs`), so the donor leftovers are inert once superseded --
    // at most an orphaned-segment-file disk cost (compaction, which would
    // reclaim that, is not wired into any live scan path today), never a
    // MANIFEST/generation mismatch a query could observe.
    console.error(`[urdira] v4 index pack import for ${workspaceId} threw, falling back to a full scan:`, error);
    await cleanupStaging();
    return { imported: false, import_wall_ms: Date.now() - importStartedAt, ...(packBytes === undefined ? {} : { pack_bytes: packBytes }) };
  }
}

/**
 * v4 (plan §9, P2-7) scan entry point, called from `scheduleWorkspaceScan`'s
 * `run` in place of the whole v3 plugin-resolution/fork/pack/
 * `runProgressiveWorkspaceScan` sequence, once that caller has confirmed
 * (`readStructuralStore(database.database) === "native"`) that this
 * workspace is v4. Deliberately throws (rather than swallowing) on every
 * failure -- `scheduleWorkspaceScan`'s existing `catch` block already
 * implements exactly the retry/degrade semantics a v4 failure needs
 * (`storage:workspace_writer_busy` bounded retry, `core:source_changed`
 * retry, terminal degrade-to-`priorSnapshotId` with a recorded
 * `last_scan_error`) -- duplicating that here would be a second, divergent
 * copy of the same policy.
 */
async function runV4WorkspaceScan(input: RunV4WorkspaceScanInput): Promise<void> {
  const { workspace, workspaceId, durableStorage, requestedUris, authoritativeDeletes, activity, registry, resolveTransport, submitLexicalMaintenance, submitSemanticMaintenance, pendingIndexPackPaths, preemptMaintenanceForPublish } = input;
  // Visible to a readiness poll racing this scan's own first await, before
  // any generation has actually landed: still v4, still "not ready yet",
  // exactly like a v3 workspace mid its own first scan.
  if (!v4ReadinessState.has(workspaceId)) v4ReadinessState.set(workspaceId, {});
  const transport = await resolveTransport?.(workspace);
  if (!transport) {
    throw new Error(`No v4 workspace-scan transport is configured for workspace ${workspaceId} (URDIRA_V4 requires DaemonRuntimeOptions.resolve_workspace_scan_transport to be wired by the composing application).`);
  }
  // P1-D-c: subscribe exactly once per transport instance (decision 29's
  // one-worker-process-per-workspace model means this transport, and
  // therefore this closure's captured `workspaceId`, never serves a
  // different workspace later).
  if (!v4UpgradeSubscribed.has(transport)) {
    v4UpgradeSubscribed.add(transport);
    onRustWorkspaceUpgradeCompleted(transport, (event) => {
      handleV4UpgradeCompleted(workspaceId, event);
    });
  }
  const paths = await ensureV4Workspace({ storage: durableStorage, workspace_id: workspaceId, create_semantic_sidecar: input.semanticIndexEnabled });
  // Mirrors `attemptWorkspaceFork`'s own "genuine first-ever scan" predicate
  // (`priorSnapshotId === undefined`, i.e. `workspace.current_snapshot_id`):
  // no v4 snapshot has ever published for this workspace yet.
  const isFirstScan = workspace.current_snapshot_id === undefined;
  // Index pack import (Frente P-1, plan §7.1.3): the cross-machine sibling
  // of v3's `attemptWorkspaceFork`/`attemptIndexPackImport` compatibility
  // copiers -- tried only on a genuine first-ever scan, and only when
  // `core:workspace_add` registered a pack path for THIS workspace id
  // (`pendingIndexPackPaths`, `scheduleWorkspaceScan`'s closure); consumed
  // (deleted) on this first read regardless of outcome, exactly like the v3
  // side channel, so a later `core:reindex` never re-attempts an import
  // against an already-populated workspace. On success the scan below is
  // forced to `reconcile` (skipping `full` even though `isFirstScan` is
  // true): the imported catalog already has a generation > 0 to diff
  // against, and `reconcile` is exactly the mechanism (Frente E) that
  // derives and republishes the authoritative difference between the
  // donor's tree and this workspace's own -- a `full` scan here would
  // needlessly redo the donor's own work from scratch.
  let importedFromIndexPack = false;
  let indexPackImportOutcome: V4IndexPackImportOutcome | undefined;
  const pendingPackPath = isFirstScan ? pendingIndexPackPaths?.get(workspaceId) : undefined;
  if (pendingPackPath !== undefined) {
    pendingIndexPackPaths?.delete(workspaceId);
    indexPackImportOutcome = await importPendingV4IndexPack(paths, pendingPackPath, workspaceId);
    importedFromIndexPack = indexPackImportOutcome.imported;
  }
  // `requestedUris === undefined` is `mergeScanRequestIntoBuffer`'s own
  // "unsafe/lost-coverage" signal (an explicit reindex, or a coalesced
  // buffer that saw one) -- treated the same way v3's full scan already
  // treats it: as requiring a full rescan, not a narrow changed-paths one.
  // Frente E (plan `generic-waddling-hartmanis.md` §2.3): `requestedUris ===
  // undefined` used to mean "full" unconditionally -- but it is ALSO the
  // signal `watchers.ts` sends for every git-driven "unknown extent of
  // change" event (`branch_changed`/`events_lost`/`provider_reset`, always
  // `changedUris === undefined`) and for the periodic reconciliation sweep,
  // neither of which actually needs the FULL pipeline: `reconcile` derives
  // the same authoritative delta from a fresh walk (never trusting the
  // watcher's own hint either way) and republishes it through whichever
  // pipeline (`changed`'s or `full`'s) is cheaper for the delta's measured
  // size -- see `crates/urdira-indexing-worker/src/v4/scan.rs::run_reconcile`'s
  // own doc comment. `forceFullScans` (below) is the explicit opt-out for
  // the callers that genuinely need `full` regardless of delta size --
  // `core:reindex` and the outdated-workspace-format recovery sweep, both
  // populate it before scheduling this scan.
  const forceFull = forceFullScans.delete(workspaceId);
  let scope: ScanScope = importedFromIndexPack
    ? { kind: "reconcile" }
    : isFirstScan || forceFull
      ? { kind: "full" }
      : requestedUris === undefined
        ? { kind: "reconcile" }
        : { kind: "changed", paths: mapV4ChangedPaths(requestedUris, authoritativeDeletes) };
  // P3-1: the worker rejects `Changed{paths: []}` outright (`crates/urdira-
  // indexing-worker/src/v4/delta.rs`, "requires at least one path") -- found
  // live via `tests/v4-mutation-harness.test.ts`'s rename mutation, which
  // can coalesce into a `requestedUris`/`authoritativeDeletes` pair that
  // `mapV4ChangedPaths` collapses to zero paths (e.g. a create+delete of the
  // SAME uri arriving in one buffer). Nothing to scan is a legitimate,
  // silent no-op here -- this workspace's current snapshot is already
  // accurate -- not a scan failure.
  if (scope.kind === "changed" && scope.paths.length === 0) return;
  const priority = activity === "indexing" ? "interactive" as const : "background" as const;
  const buildRequest = (currentScope: ScanScope) => ({
    workspace_id: workspaceId,
    workspace_root: workspace.canonical_root,
    database_path: paths.database_path,
    structural_root: paths.structural_root,
    cas_root: paths.cas_root,
    sidecar_root: paths.sidecar_root,
    scope: currentScope,
    // Stable, workspace-scoped placeholder identities: v4 has no JS/TS
    // plugin registry/configuration/lock concept the way v3's
    // `resolve_plugin_provider` does (the Rust worker owns catalog, parse,
    // and materialize as one pass with no external configuration surface
    // yet) -- these three ids exist purely to satisfy the protocol's
    // `registry_snapshots`/`FOREIGN KEY` placeholder rows
    // (docs/evidence/2026-09-02-v4-p2-2b-cold-pipeline.md §4.3), so a fixed,
    // per-workspace value that never changes across scans is exactly right.
    registry_snapshot_id: `registry:${workspaceId}:v4`,
    configuration_revision_id: `configuration:${workspaceId}:v4`,
    resolution_lock_id: `resolution:${workspaceId}:v4`,
    priority,
  });
  // P3-5 timeline (plan §6.1's daemon-latency item): `timeline` is either the
  // draft `scheduleWorkspaceScan`'s aggregation branch built for this exact
  // scan (moved from `v4PendingScanTimelines` into `v4ActiveScanTimelines`
  // at admission -- `fs_event_at`/`aggregated_at` already set, for a
  // watcher-driven scan) or a fresh empty object (a non-watcher scan: first
  // cold scan, `core:reindex`, the reconciliation sweep -- neither of those
  // two fields is meaningful for it).
  const timeline = v4ActiveScanTimelines.get(workspaceId) ?? {};
  v4ActiveScanTimelines.set(workspaceId, timeline);
  // Snapshot to roll back to if a live `Queryable` notification below turns
  // out to have been premature (the scan fails AFTER reporting queryable --
  // see `onQueryableLive`'s own doc comment). Captured once, before either
  // scan attempt, so a "Changed rejected, retry Full" cycle rolls back to
  // the state from BEFORE this whole `runV4WorkspaceScan` call, not to an
  // intermediate value.
  const priorReadinessForRollback = v4ReadinessState.get(workspaceId);
  let liveQueryableApplied = false;
  // P3-5 item 2c: flips `v4ReadinessState.queryable_generation` (and
  // `structural_ready`, via `v4WorkspaceReadinessFrom`'s own doc comment
  // above) the MOMENT the worker reports `Queryable`, live during the scan
  // -- not after the whole scan (`ScanCompleted` included) settles, which is
  // what this used to wait for (the only place `v4ReadinessState` was ever
  // written was after this function's own `await` below returned). If the
  // scan goes on to fail anyway (queryable data was published but the
  // durable/publish phase then errored -- not observed in the current Rust
  // pipeline, where `write_base` performs both synchronously, but not
  // impossible), the `catch` block below rolls this back to
  // `priorReadinessForRollback` before re-throwing, so a failed scan never
  // leaves a dangling `queryable_generation` with no corresponding durable
  // state.
  const onQueryableLive = (event: { readonly generation: number }): void => {
    // Frente S-H (Part 1): the earliest point THIS scan's own run body can
    // confirm a real generation is actually about to publish -- never
    // reached at all for a `Reconcile` scan that resolves to
    // `ReconcileMode.Noop` (see `preemptMaintenanceForPublish`'s own doc
    // comment). Redundant (and harmless) when `scheduleWorkspaceScan`
    // already pre-empted eagerly at admission for this scan's `activity`.
    preemptMaintenanceForPublish?.(workspaceId);
    timeline.queryable_at = Date.now();
    debugTiming(`workspace=${workspaceId} queryable_at generation=${event.generation}`);
    v4ReadinessState.set(workspaceId, { ...v4ReadinessState.get(workspaceId), queryable_generation: event.generation });
    liveQueryableApplied = true;
    timeline.readiness_updated_at = Date.now();
    debugTiming(`workspace=${workspaceId} readiness_updated_at (queryable)`);
    notifyReadinessChanged(workspaceId);
  };
  let outcome: Awaited<ReturnType<typeof runRustWorkspaceScan>>;
  try {
    try {
      timeline.request_sent_at = Date.now();
      debugTiming(`workspace=${workspaceId} request_sent_at scope=${scope.kind}`);
      outcome = await runRustWorkspaceScan(transport, buildRequest(scope), onQueryableLive);
    } catch (error) {
      // P3-1: `ScanScope::Changed` is a real, implemented path server-side
      // now (`crates/urdira-indexing-worker/src/v4/delta.rs`) -- this is no
      // longer a blanket "not supported yet" fallback. The ONE legitimate
      // reason a `Changed` request can still fail this way is the worker
      // having no prior generation for this workspace cached (a freshly
      // restarted worker process that has never scanned this workspace, or
      // this daemon process's own `isFirstScan`/`current_snapshot_id` state
      // disagreeing with what the worker persisted) -- `delta::run` rejects
      // that case explicitly with this exact message
      // (`crates/urdira-indexing-worker/src/v4/delta.rs`), and a `Full` scan
      // is the only correct recovery (there is nothing to diff against).
      // Every OTHER `Changed`-scope failure (a real bug, a corrupt delta, an
      // I/O error) is NOT caught here -- it propagates to the outer `catch`
      // below (rollback + timeline bookkeeping), same as any other scan
      // failure, rather than being silently masked by a full-rescan retry.
      // Frente E: `run_reconcile` rejects the identical "no prior
      // generation" case with the SAME message substring (`scan.rs`'s own
      // doc comment on that error) -- covered here too, same retry-to-full
      // recovery, since a workspace `reconcile` targets always needs SOME
      // prior generation to diff against.
      const isUninitializedState = (scope.kind === "changed" || scope.kind === "reconcile") && error instanceof Error && error.message.includes("requires a prior generation; send scope: Full");
      if (!isUninitializedState) throw error;
      if (!v4ChangedScopeUnsupportedWarned.has(workspaceId)) {
        v4ChangedScopeUnsupportedWarned.add(workspaceId);
        console.warn(`[urdira] v4 workspace scan: worker has no prior generation cached for workspace ${workspaceId} yet; falling back to Full once (this warning is logged once per workspace).`);
      }
      scope = { kind: "full" };
      timeline.request_sent_at = Date.now();
      debugTiming(`workspace=${workspaceId} request_sent_at scope=full (retry)`);
      outcome = await runRustWorkspaceScan(transport, buildRequest(scope), onQueryableLive);
    }
  } catch (error) {
    // Reached by a genuine failure from EITHER attempt above (the initial
    // `Changed`/`Full` call, or the "no prior generation" retry) -- one
    // rollback path for both, so a failure during the retry cannot skip
    // the same bookkeeping a first-attempt failure gets.
    if (liveQueryableApplied) v4ReadinessState.set(workspaceId, priorReadinessForRollback ?? {});
    v4ActiveScanTimelines.delete(workspaceId);
    v4LastScanTimelines.set(workspaceId, timeline);
    throw error;
  }
  timeline.completed_at = Date.now();
  debugTiming(`workspace=${workspaceId} completed_at generation=${outcome.generation}`);
  // P4-d: `scope` here is whichever request actually succeeded -- either
  // the original request, or the `Full` retry after a `Changed`/`Reconcile`
  // rejection (both reassignments above keep `scope` pointing at the
  // attempt that produced `outcome`).
  v4LastScanSummaries.set(workspaceId, scope.kind === "changed"
    ? { kind: "changed", changed_paths: scope.paths.length, timings: outcome.timings }
    : scope.kind === "reconcile"
      // `exactOptionalPropertyTypes`: omit `reconcile` entirely rather than
      // assigning `undefined` -- `outcome.reconcile` is absent only if the
      // worker predates Frente E, an older-binary edge case worth keeping
      // distinguishable from "reconcile ran and reported nothing".
      ? { kind: "reconcile", timings: outcome.timings, ...(outcome.reconcile === undefined ? {} : { reconcile: outcome.reconcile }), ...(indexPackImportOutcome === undefined ? {} : { import: indexPackImportOutcome }) }
      : { kind: "full", timings: outcome.timings });
  const priorReadiness = v4ReadinessState.get(workspaceId);
  // P1-D-c: the residual pass is gated behind the SAME env var
  // `indexing-core-process-transport.ts` forwards to the worker child
  // process (`URDIRA_V4_RESIDUAL`) -- read here too so `upgrade_running`
  // does not optimistically latch `true` forever when the pass is not even
  // enabled (no `upgrade_completed` event would ever arrive to clear it).
  // `upgrade_completed_generation`/`upgrade_pending_sites` are carried
  // forward explicitly (this `.set` replaces the whole record, same
  // convention `lexical_completed_generation`/`semantic_completed_generation`
  // already follow above) -- a residual pass's own reported completion must
  // survive the NEXT structural scan, not be wiped by it.
  const residualEnabled = process.env["URDIRA_V4_RESIDUAL"] !== undefined && process.env["URDIRA_V4_RESIDUAL"] !== "0";
  // Frente S-H (Part 1): a true `Reconcile`/`Noop` (R3, `crates/urdira-
  // indexing-worker/src/v4/scan.rs`) means nothing changed -- no new
  // generation published, nothing new for semantic/lexical maintenance to
  // catch up on. Once maintenance has been submitted at least once for this
  // workspace (`semantic_maintenance_submitted`, below), a further no-op
  // scan skips resubmitting it entirely -- see the tail of this function for
  // why this matters beyond a "cheap fast-path lookup": the THREADED path
  // spawns a real child process per submission, and without this check the
  // periodic reconciliation sweep's own coalesced-pending retry (`submit
  // SemanticMaintenance`'s own `semanticMaintenancePending` mechanism)
  // spawns one every time a no-op sweep tick's own scan happens to land
  // while an earlier, real pass is still running.
  const isReconcileNoop = scope.kind === "reconcile" && outcome.reconcile?.mode === "noop";
  v4ReadinessState.set(workspaceId, {
    queryable_generation: outcome.queryable?.generation ?? outcome.generation,
    durable_generation: outcome.generation,
    lexical_completed_generation: priorReadiness?.lexical_completed_generation,
    semantic_completed_generation: priorReadiness?.semantic_completed_generation,
    upgrade_completed_generation: priorReadiness?.upgrade_completed_generation,
    upgrade_pending_sites: priorReadiness?.upgrade_pending_sites,
    upgrade_running: residualEnabled ? true : priorReadiness?.upgrade_running,
    semantic_maintenance_submitted: priorReadiness?.semantic_maintenance_submitted === true || !isReconcileNoop,
  });
  timeline.readiness_updated_at = Date.now();
  debugTiming(`workspace=${workspaceId} readiness_updated_at (durable)`);
  registry.markReady(workspaceId, outcome.snapshot_id, "ready");
  v4ActiveScanTimelines.delete(workspaceId);
  v4LastScanTimelines.set(workspaceId, timeline);
  // v4 storage wiring (2026-09-07): semantic maintenance (`reconcileSemanticProjection`)
  // used to be deliberately skipped here -- its entity-grain lane (decision
  // 17, `@urdira/engine`'s `semantic-reconciler.ts`) read `record_occurrences`/
  // `record_value_nodes` directly, structural v3 tables that do not exist at
  // all in the v4 catalog schema (docs/evidence/2026-09-02-v4-p2-1-schema.md).
  // `submitSemanticMaintenance` now resolves a native-store-backed
  // `SemanticEntityRecordSource` for a v4 workspace (`resolveV4SemanticEntitySource`,
  // `semantic-v4-wiring.ts`) and feeds it to the SAME reconciler.
  // `reconcileSemanticProjection`'s own already-complete fast path means a
  // scan that published nothing new (e.g. a `reconcile` no-op whose
  // `completed_generation` already matches the current one) costs this call
  // two cheap point lookups when it runs in-process -- but Frente S-H found
  // live that submitting it UNCONDITIONALLY on every scan, combined with
  // `submitSemanticMaintenance`'s own coalesced-pending retry, spawns a
  // whole new child process on the THREADED path (the shipped default) for
  // every no-op periodic-sweep tick that happens to land while an earlier
  // real pass is still running -- see `isReconcileNoop`/
  // `semantic_maintenance_submitted` above. Skipped here ONLY once
  // maintenance has genuinely been submitted at least once already for this
  // workspace; always still submitted lexical maintenance regardless (a
  // separate, smaller-blast-radius lever left as a follow-up, not fixed by
  // this frente -- lexical's own coalesced retry is not spawning a
  // subprocess for the SAME test-observed failure mode this frente was
  // asked to fix).
  submitLexicalMaintenance(workspaceId);
  if (!isReconcileNoop || priorReadiness?.semantic_maintenance_submitted !== true) submitSemanticMaintenance(workspaceId);
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
  private constructor(private readonly options: DaemonRuntimeOptions, paths: DaemonPaths, private readonly lock: ProcessLock, private readonly descriptor: EndpointDescriptorStore, private readonly checkpoint: LastKnownGoodStore, private readonly server: LocalIpcServer, scheduler: DaemonScheduler, recoveredCheckpoint: import("./ownership.js").LastKnownGood | undefined, recovery: PersistentCursorRecovery, recoveredCursorIds: ReadonlyArray<string>, private readonly pendingWarms: ReadonlySet<Promise<void>>, private readonly watcherManager?: WorkspaceWatcherManager, private readonly indexingStorage?: DurableStorage, private readonly queryEnginesForTest?: ReadonlyMap<string, CachedWorkspaceQueryEngine>, private readonly reconciliationSweepTimer?: NodeJS.Timeout, private readonly semanticHost?: NeuralSemanticProviderHost, private readonly clearScanAggregationTimers?: () => void) {
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
    // v4 (plan §6, Frente H): the most recently computed orphan sweep,
    // refreshed at startup (below) and by `core:workspace_orphans_list`/
    // `core:workspace_orphans_purge` -- see `DaemonStatus.orphaned_workspace_data`'s
    // own doc comment for why `core:status` reads this cached value instead
    // of re-sweeping on every call.
    let latestOrphanReport: OrphanReport | undefined;
    const workspacesDataDir = join(options.data_root, "workspaces");
    const knownWorkspaceSafeIds = (): ReadonlySet<string> => new Set((options.workspace_registry?.listIncludingRemoved() ?? []).map((workspace) => workspaceSafeId(workspace.workspace_id)));
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
      // v4 (P4-b-prep, plan §9): `createDurableStorage` above no longer
      // throws when its startup recovery sweep finds a catalogued workspace
      // at an outdated/unsupported index contract (a v3 database from
      // before a since-applied migration, or a stale pre-cutover leftover);
      // it records each one on `indexingStorage.outdatedWorkspaces` instead
      // of opening it (see `OutdatedWorkspaceRecord`'s doc comment in
      // `@urdira/storage`). Reflect every such workspace into the
      // `WorkspaceRegistry` here, BEFORE the crash-recovery loop and the
      // "ready"/"degraded" warm-up filter below ever read `.list()`:
      // `recordScanFailure` stamps the error code (visible on
      // `core:index_status` as `last_scan_error_code`) without touching
      // `status`, then `beginReconciliation` (unless already `"indexing"`,
      // or `"suspended"` -- a suspended workspace's own `resume()` contract
      // is untouched here) flips `status` to `"indexing"`. That is the
      // exact state the UNCHANGED crash-recovery loop below already scans
      // for, so the workspace's `openWorkspace`/`registerWorkspace` call
      // inside `scheduleWorkspaceScan` throws the identical outdated-format
      // error again, and the P4-a `isOutdatedWorkspaceError` catch branch
      // there runs `recreateOutdatedWorkspaceDatabase` and reschedules a
      // fresh Full scan -- the same recovery an already-running daemon
      // applies when it discovers this mid-scan, now also reachable from a
      // cold start. A workspace already removed/removing by the time this
      // runs (a narrow race with a concurrent `core:workspace_remove`) is
      // left alone: its database is going away regardless.
      if (indexingStorage && options.workspace_registry) {
        const registry = options.workspace_registry;
        for (const outdated of indexingStorage.outdatedWorkspaces) {
          const workspace = registry.get(outdated.workspace_id);
          if (!workspace || workspace.status === "removed" || workspace.status === "removing") continue;
          registry.recordScanFailure(outdated.workspace_id, outdated.error_code);
          // Frente E: the eventual scan this reconciliation triggers (via
          // the crash-recovery loop below, once `recreateOutdatedWorkspace
          // Database` clears the on-disk footprint) must be `full`, never
          // `reconcile` -- the recreated database has no prior generation
          // for `reconcile` to diff against, and would just error+retry via
          // the SAME "requires a prior generation" fallback above at extra
          // cost. Set unconditionally alongside `beginReconciliation` (both
          // gated by the identical status check) rather than relying on
          // that retry path.
          forceFullScans.add(outdated.workspace_id);
          if (workspace.status !== "indexing" && workspace.status !== "suspended") registry.beginReconciliation(outdated.workspace_id);
        }
      }
      // v4 (P4-b-2, default flip): one diagnostic line per daemon start,
      // naming how many catalogued workspaces this installation already has
      // in each format -- an operator's first signal of how far along a
      // fleet is from v4 without a separate admin query. Counts come from
      // `recoverMigrations`'s own per-workspace format detection (no extra
      // file opens); an installation with no `indexingStorage` (no
      // `workspace_registry`/`resolve_plugin_provider` configured -- see the
      // comment on `indexingStorage`'s assignment above) never scans a
      // workspace at all, so there is nothing to count.
      if (indexingStorage) {
        const counts = indexingStorage.workspaceFormatCounts;
        console.error(`[urdira] startup: ${counts.v3} v3 workspace(s), ${counts.v4} v4 workspace(s) registered under ${options.data_root} (new workspaces default to v4; set URDIRA_V4=0 to opt out)`);
      }
      // v4 (plan §6, Frente H): a startup orphan sweep of `<data_root>/
      // workspaces` -- catches leftovers from BEFORE `purgeWorkspace`'s
      // full-footprint fix (see its own doc comment) as well as anything a
      // crashed process left mid-operation. Never allowed to fail startup:
      // any error (a permissions issue, an unexpected `readdir` failure --
      // `sweepWorkspaceDataDir` already treats a missing directory as "no
      // orphans", not an error) is caught and logged here, exactly like
      // R15 requires, so a broken sweep degrades to "no `orphaned_workspace_data`
      // this life" rather than blocking every other workspace from ever
      // becoming queryable.
      if (indexingStorage && options.workspace_registry) {
        try {
          latestOrphanReport = await sweepWorkspaceDataDir({ workspacesDir: workspacesDataDir, knownSafeIds: knownWorkspaceSafeIds() });
          if (latestOrphanReport.orphans.length > 0) {
            const bytes = latestOrphanReport.orphans.reduce((sum, group) => sum + group.total_bytes, 0);
            console.warn(`[urdira] ${latestOrphanReport.orphans.length} orphaned workspace data set(s) (${Math.round(bytes / (1024 * 1024))} MB) under ${workspacesDataDir}; run "urdira workspace orphans" to review`);
          }
        } catch (error) {
          console.error(`[urdira] startup orphan sweep failed (continuing without it): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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
      /**
       * Frente S-H (`generic-waddling-hartmanis.md` §4, Part 1) -- fixes Bug
       * 4 of `docs/evidence/2026-09-08-v4-semantic-embed-stall-root-cause.md`:
       * pre-empts an in-flight threaded lexical/semantic maintenance run,
       * same two calls `scheduleWorkspaceScan` used to make UNCONDITIONALLY
       * the instant ANY scan was admitted -- including the periodic
       * reconciliation sweep's own "just double-check nothing changed" scan,
       * which by definition does not yet know whether anything will turn out
       * to have changed. `scheduleWorkspaceScan` below now calls this
       * EAGERLY, at admission, only for a scan that is KNOWN in advance to
       * publish a real generation (a genuine edit, an explicit
       * `core:reindex`, a first-ever scan, ...); for the one ambiguous case
       * -- `activity === "checking_for_updates"`, the periodic sweep's own
       * signal for "an already-`ready` workspace, unknown whether anything
       * changed" (`DaemonRuntimeOptions.reconciliation_sweep_interval_ms`'s
       * doc comment; the ONLY call site that ever passes this activity) --
       * admission does NOT call this, and this is instead called lazily,
       * from within the scan's own run body, at the earliest point that
       * body can confirm a real generation is actually about to publish:
       * v4's `onQueryableLive` (never invoked by `run_reconcile`'s `Noop`
       * branch -- `crates/urdira-indexing-worker/src/v4/scan.rs`, R3: a true
       * no-op never calls `Catalog::apply` and never becomes queryable) and
       * v3's `on_stage_published` (`workspace-indexing-session.ts`'s own doc
       * comment: "the expanded agent benchmark measures the source-first
       * structural readiness boundary" -- fired only once a stage's
       * `runFullWorkspaceScan` call actually published a real snapshot, not
       * for a periodic equivalence check that found nothing). A no-op sweep
       * therefore never touches an unrelated in-flight maintenance pass at
       * all; a real change still pre-empts it, just at the (slightly later,
       * but WAL-safe: see `SerializedWriter`'s own busy-retry doc comment
       * this same file's `WORKSPACE_WRITER_BUSY_MAX_RETRIES` already relies
       * on for the identical class of contention) moment the scan itself
       * confirms real work rather than guessing at admission time. Calling
       * this more than once for the same workspace (the eager call already
       * fired, then the lazy hook ALSO fires once the scan's own body
       * confirms real work) is harmless: `.abort()` on an already-aborted or
       * already-finished run is a no-op, and a workspace with no run
       * in-flight resolves to `undefined` either way.
       */
      const preemptMaintenanceForPublish = (workspaceId: string): void => {
        lexicalThreadRuns.get(workspaceId)?.abort();
        semanticThreadRuns.get(workspaceId)?.abort();
      };
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
      // `storage:workspace_writer_busy` (see `packages/storage/src/storage.ts`)
      // means a foreground mutation could not acquire the cross-process
      // writer lock -- normally because detached Rust lexical maintenance
      // holds it for one bounded chunk (`reconcile_lexical` in
      // `crates/urdira-indexing-core/src/lib.rs`). That is a short, expected
      // race, not a real scan failure, so it gets its own bounded retry
      // counter here, exactly parallel to how `core:source_changed` is
      // retried below but with an explicit delay/cap so a writer that never
      // releases the lock cannot turn into a busy-loop. Reset on every
      // successful scan completion (see the `WORKSPACE_WRITER_BUSY_MAX_RETRIES`
      // usage below and its success-path resets).
      const workspaceWriterBusyRetries = new Map<string, number>();
      const WORKSPACE_WRITER_BUSY_MAX_RETRIES = 8;
      // Parallel bounded-retry counter for a plugin resolving to nothing on
      // a workspace that explicitly selected one -- see its use at
      // `scheduleWorkspaceScan`'s `resolvePluginProvider` call, below.
      // Cleared as soon as any later scan resolves the plugin again.
      const pluginResolutionMissingRetries = new Map<string, number>();
      const PLUGIN_RESOLUTION_MISSING_MAX_RETRIES = 8;
      // Scan-priority sidecar (docs/evidence/2026-09-02-edit-latency.md's
      // "primera edicion" residual): a real edit-triggered scan and detached
      // Rust lexical maintenance (`reconcile_lexical`'s `yield_mutation_lease`
      // in `crates/urdira-indexing-core`) both want the same process-local
      // `workspace_lease`. (A second detached rebuild pass used to contend
      // for the same lease to build derived accelerator indexes after a
      // cold-direct commit; it was removed -- those indexes are now built
      // inline, synchronously, inside the cold-direct commit itself -- see
      // docs/evidence/2026-09-02, T2.) Maintenance already releases that
      // lease between bounded chunks (B1), but nothing told it to let a
      // *specific* incoming edit win the immediate re-acquire race, so a cold
      // corpus's first foreground edit could still lose every such race in a
      // row and wait out the whole detached pass (measured: 12.5s of
      // `stage_plan`). This marker file -- `<database_path>.urdira-scan-pending`,
      // the same private-sidecar convention as `GenerationRequest.cancellation_path`
      // (`crates/urdira-indexing-core/src/lib.rs`) -- is this daemon's side of
      // that priority signal: its mere existence tells the Rust maintenance
      // loops "a real edit is queued, give it the next turn". It is created
      // by `markScanPending` once this scan's actual on-disk database path is
      // known (right after `durableStorage.openWorkspace` below, in `run`) --
      // deliberately before plugin resolution, workspace-fork/index-pack
      // attempts, source enumeration, and the Rust structural generation
      // itself, so maintenance sees it as early as possible. It is removed by
      // `clearScanPending` in this job's own outer `finally` below regardless
      // of outcome (success, failure, or a database that never opened), which
      // is the simpler "(o al completar)" half of the design contract --
      // precisely tracking the moment the Rust generation itself acquires the
      // lease would need a new event threaded back from the Rust worker,
      // which is unnecessary: the Rust side already bounds how long it honors
      // a still-present marker (a short wait per chunk boundary, not an
      // unbounded wait), so this file living for this job's whole duration
      // only ever costs maintenance a few bounded chunks of delay, never a
      // hang. Only set for a genuine edit ("indexing" activity), not a
      // passive "checking_for_updates" freshness sweep -- the latter must not
      // pause maintenance for no real edit. Best-effort throughout: a failure
      // to write or remove this advisory file must never affect scan success
      // -- worst case, maintenance simply does not see the priority hint for
      // this one job.
      const scanPendingSidecarPath = (databasePath: string): string => `${databasePath}.urdira-scan-pending`;
      const markScanPending = (databasePath: string): void => {
        void writeFile(scanPendingSidecarPath(databasePath), `${process.pid}\n`, "utf8").catch(() => undefined);
      };
      const clearScanPending = (databasePath: string): void => {
        void unlink(scanPendingSidecarPath(databasePath)).catch(() => undefined);
      };
      const pendingScans = new Map<string, ScanRequestBuffer>();
      // Burst-aggregation state (see `DaemonRuntimeOptions.scan_aggregation_window_ms`'s
      // doc comment): `scanAggregationBuffers` holds the union of every
      // watcher edit event buffered so far for a workspace that has NO scan
      // in flight yet; `scanAggregationTimers` holds that buffer's pending
      // debounce/flush timer; `scanAggregationStartedAt` records when the
      // FIRST event of the current buffer arrived, so the debounce can be
      // capped at `scan_aggregation_max_ms` instead of resetting forever.
      // All three are always mutated together (see `flushScanAggregation`
      // below, the only place that clears them, and the aggregation branch
      // of `scheduleWorkspaceScan`, the only place that populates them).
      const scanAggregationBuffers = new Map<string, ScanRequestBuffer>();
      const scanAggregationTimers = new Map<string, NodeJS.Timeout>();
      const scanAggregationStartedAt = new Map<string, number>();
      const scanAggregationWindowMs = Math.max(0, options.scan_aggregation_window_ms ?? 200);
      const scanAggregationMaxMs = Math.max(scanAggregationWindowMs, options.scan_aggregation_max_ms ?? 1_000);
      /**
       * P3-5 (plan §6.1's daemon-latency item): a v4 workspace's own
       * single-pass Rust `WorkspaceScan` has a sub-second worker-compute
       * floor (worker-only ~0.7-0.9s steady-state, see
       * docs/evidence/2026-09-03-v4-p3-2-incremental-residuals.md §8.1) --
       * v3's 200ms/1000ms debounce defaults were tuned for the JS/TS
       * plugin's own multi-fragment source indexer and are a
       * disproportionately large fraction of a v4 edit's total observed
       * latency. When the composing application did not explicitly
       * override `scan_aggregation_window_ms`/`scan_aggregation_max_ms`,
       * a v4 workspace (`v4ReadinessState.has(workspaceId)`, set the
       * instant `runV4WorkspaceScan` starts running for that workspace's
       * first-ever scan, well before any watcher could fire a real edit
       * event against it) uses a tighter 100ms/500ms pair instead. An
       * EXPLICIT option always wins, for every workspace, v3 or v4 alike --
       * this only changes an unset default, it adds no new knob.
       */
      const scanAggregationWindowMsFor = (workspaceId: string): number =>
        options.scan_aggregation_window_ms !== undefined ? scanAggregationWindowMs : v4ReadinessState.has(workspaceId) ? 100 : scanAggregationWindowMs;
      const scanAggregationMaxMsFor = (workspaceId: string): number => {
        if (options.scan_aggregation_max_ms !== undefined) return scanAggregationMaxMs;
        const window = scanAggregationWindowMsFor(workspaceId);
        return v4ReadinessState.has(workspaceId) ? Math.max(window, 500) : scanAggregationMaxMs;
      };
      // `aggregatable` is `true` ONLY at the one call site that represents a
      // real filesystem watcher event (`WorkspaceWatcherManagerOptions.on_reconcile`
      // below). Every other call site -- `core:workspace_add`'s first scan,
      // `core:reindex`, the periodic reconciliation sweep, the
      // workspace-writer-busy retry, and this same function's own
      // `pendingScans`/aggregation follow-up recursion -- omits it and so
      // defaults to `false`, keeping their scan start exactly as immediate as
      // it is today. This is deliberately narrower than gating on
      // `activity === "indexing"` alone: several of those other call sites
      // also pass `"indexing"`, but none of them are a burst of near-
      // simultaneous edits, and per `scan_aggregation_window_ms`'s contract
      // none of them may gain latency they do not already have.
      const scheduleWorkspaceScan = (workspaceId: string, changedUris?: readonly string[], authoritativeDeletes: readonly ScanWatcherHint[] = [], activity: WorkspaceIndexingActivity = "indexing", aggregatable = false): void => {
        const registry = options.workspace_registry;
        const resolvePluginProvider = options.resolve_plugin_provider;
        const durableStorage = indexingStorage;
        if (!registry || !resolvePluginProvider || !durableStorage) return;
        // A concrete filesystem event or explicit scan always upgrades a
        // periodic check that happened to be in flight; a later sweep must
        // never downgrade visible real indexing to a passive check.
        scanActivities.set(workspaceId, scanActivities.get(workspaceId) === "indexing" || activity === "indexing" ? "indexing" : "checking_for_updates");
        if (scanInFlight.has(workspaceId)) {
          const pending = pendingScans.get(workspaceId) ?? createScanRequestBuffer(activity);
          mergeScanRequestIntoBuffer(pending, changedUris, authoritativeDeletes, activity, activeAuthoritativeDeletePhases.has(workspaceId));
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
        const effectiveAggregationWindowMs = scanAggregationWindowMsFor(workspaceId);
        if (aggregatable && activity === "indexing" && effectiveAggregationWindowMs > 0) {
          // No scan is in flight yet: this is the FIRST (or a subsequent,
          // still-within-window) event of a potential burst. Buffer it and
          // (re)start the debounce timer instead of starting a scan
          // immediately -- see `scan_aggregation_window_ms`'s doc comment for
          // the full rationale and `flushScanAggregation` below for what
          // actually starts the scan once the window elapses.
          const now = Date.now();
          const buffer = scanAggregationBuffers.get(workspaceId) ?? createScanRequestBuffer(activity);
          const isFirstEventOfBurst = !scanAggregationBuffers.has(workspaceId);
          scanAggregationBuffers.set(workspaceId, buffer);
          mergeScanRequestIntoBuffer(buffer, changedUris, authoritativeDeletes, activity, activeAuthoritativeDeletePhases.has(workspaceId));
          if (isFirstEventOfBurst) {
            scanAggregationStartedAt.set(workspaceId, now);
            // P3-5 timeline: the burst's first watcher event, the true
            // `fs_event_at` for whatever scan this burst eventually becomes
            // (consumed at admission, `scanInFlight.add` below).
            v4PendingScanTimelines.set(workspaceId, { fs_event_at: now });
            debugTiming(`workspace=${workspaceId} fs_event_at`);
          }
          const startedAt = scanAggregationStartedAt.get(workspaceId) ?? now;
          const existingTimer = scanAggregationTimers.get(workspaceId);
          if (existingTimer !== undefined) clearTimeout(existingTimer);
          // Debounce (reset) on every event, but never past the hard cap
          // measured from the burst's first event -- a continuous stream of
          // edits, each landing just inside the rolling window, must still
          // flush eventually instead of postponing the scan forever.
          const delayMs = Math.min(effectiveAggregationWindowMs, Math.max(0, scanAggregationMaxMsFor(workspaceId) - (now - startedAt)));
          const timer = setTimeout(() => flushScanAggregation(workspaceId), delayMs);
          timer.unref?.();
          scanAggregationTimers.set(workspaceId, timer);
          return;
        }
        // P3-5 timeline: a watcher-driven scan that skipped the aggregation
        // branch above entirely (`scan_aggregation_window_ms` resolved to 0
        // for this workspace) still gets a timeline -- `fs_event_at` and
        // `aggregated_at` collapse to the same instant, correctly reflecting
        // that no debounce delay was applied.
        if (aggregatable && !v4PendingScanTimelines.has(workspaceId)) {
          const now = Date.now();
          v4PendingScanTimelines.set(workspaceId, { fs_event_at: now, aggregated_at: now });
        }
        scanInFlight.add(workspaceId);
        notifyReadinessChanged(workspaceId);
        {
          const pendingTimeline = v4PendingScanTimelines.get(workspaceId);
          if (pendingTimeline !== undefined) {
            v4PendingScanTimelines.delete(workspaceId);
            v4ActiveScanTimelines.set(workspaceId, pendingTimeline);
          }
        }
        const scanController = new AbortController();
        const scanGeneration = (scanGenerations.get(workspaceId) ?? 0) + 1;
        scanGenerations.set(workspaceId, scanGeneration);
        const requestedUris = changedUris === undefined ? undefined : [...new Set(changedUris)];
        if (authoritativeDeletes.length > 0) activeAuthoritativeDeletePhases.set(workspaceId, new Set(authoritativeDeletes.map((event) => event.normalized_uri)));
        // Pre-empt a stale in-flight threaded lexical/semantic maintenance
        // run (see `preemptMaintenanceForPublish`'s own doc comment above)
        // as early as possible -- before this scan is even admitted to the
        // scheduler -- rather than waiting for it to actually start running.
        // Frente S-H: skipped here for `"checking_for_updates"` (the
        // periodic reconciliation sweep's own signal that this scan does
        // not yet know whether anything actually changed, the ONLY activity
        // value this daemon ever schedules that admission cannot already
        // tell will publish) -- that ambiguous case defers the same call to
        // `preemptMaintenanceForPublish`'s lazy call sites instead
        // (`onQueryableLive` in `runV4WorkspaceScan`, `on_stage_published`
        // below), which fire only once the scan's own run body confirms a
        // real generation is actually about to publish. Every OTHER
        // activity value (a genuine edit, `core:reindex`, a first-ever scan,
        // outdated-format recovery, ...) is by construction always about to
        // publish, so pre-empting eagerly here is unchanged from before this
        // fix for all of them.
        if (activity !== "checking_for_updates") preemptMaintenanceForPublish(workspaceId);
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
                  await maybeBootstrapV4Workspace(workspace.workspace_id, durableStorage, options.semantic_index !== false);
                  await durableStorage.catalog.registerWorkspace({
                    workspace_id: workspace.workspace_id,
                    canonical_root: workspace.canonical_root,
                    display_root: workspace.display_root,
                    source_provider_bindings: [workspace.provider],
                    status: "registered",
                    registered_at: workspace.registered_at,
                  });
                  database = await durableStorage.openWorkspace(workspaceId);
                  // Priority signal for detached Rust maintenance (see
                  // `markScanPending`'s doc comment above): only a genuine
                  // edit needs to pre-empt maintenance, not a passive
                  // freshness sweep.
                  if (activity === "indexing") markScanPending(database.database.filename);
                  // v4 (plan §9, P2-7): a workspace whose database was
                  // bootstrapped v4 (by `maybeBootstrapV4Workspace` just
                  // above, on ITS first-ever scan, or by an earlier scan on
                  // every scan since) is routed entirely differently from
                  // here on -- no language-plugin resolution, no workspace
                  // fork/index-pack compatibility copiers, no
                  // `runProgressiveWorkspaceScan`: the Rust composition
                  // worker owns catalog+parse+materialize+publish as one
                  // `WorkspaceScan` command (`runRustWorkspaceScan`,
                  // `@urdira/engine`). `runV4WorkspaceScan` either returns
                  // normally (having already called `registry.markReady`
                  // and submitted lexical maintenance) or throws, in which
                  // case the SAME `catch` block below this `try` handles it
                  // exactly like any v3 scan failure (writer-busy retry,
                  // `core:source_changed` retry, terminal degrade) --
                  // deliberately reusing that machinery rather than
                  // duplicating it.
                  if ((await readStructuralStore(database.database)) === "native") {
                    await runV4WorkspaceScan({
                      workspace,
                      workspaceId,
                      durableStorage,
                      requestedUris,
                      authoritativeDeletes,
                      activity,
                      registry,
                      resolveTransport: options.resolve_workspace_scan_transport,
                      submitLexicalMaintenance,
                      submitSemanticMaintenance,
                      semanticIndexEnabled: options.semantic_index !== false,
                      pendingIndexPackPaths,
                      preemptMaintenanceForPublish,
                    });
                    workspaceWriterBusyRetries.delete(workspaceId);
                    notifyReadinessChanged(workspaceId);
                    return undefined;
                  }
                  const plugin = await resolvePluginProvider(workspace, database);
                  if (plugin) pluginResolutionMissingRetries.delete(workspaceId);
                if (!plugin) {
                    // A workspace with an explicit plugin selection does not
                    // change that selection between scans (`register`'s own
                    // idempotent early return and `updateSelection` are the
                    // only writers of `selected_plugin_ids`, and neither runs
                    // as part of an ordinary scan -- `packages/engine/src/workspaces.ts`).
                    // A plugin that resolved for an earlier scan of this same
                    // workspace resolving to nothing here is therefore not a
                    // legitimate "no language plugin configured" state; it is
                    // a transient resolution failure (for example a composition
                    // worker session that could not be recreated under memory
                    // pressure right after a large cold publish). Treat it the
                    // same way as `storage:workspace_writer_busy`: a bounded,
                    // delayed retry, never a silent, permanent degrade to the
                    // generic source-only path below -- which has its own
                    // untested-at-this-scale byte-budget ceiling (see
                    // docs/evidence/2026-09-02-v4-p0-s4-promotion-gap.md).
                    if ((workspace.selected_plugin_ids ?? []).length > 0) {
                      const attempts = (pluginResolutionMissingRetries.get(workspaceId) ?? 0) + 1;
                      if (attempts <= PLUGIN_RESOLUTION_MISSING_MAX_RETRIES) {
                        pluginResolutionMissingRetries.set(workspaceId, attempts);
                        const delayMs = Math.min(2_000, 1_000 + attempts * 250);
                        console.warn(`[urdira] workspace scan deferred for ${workspaceId}: plugin resolution returned no provider for a workspace with an explicit plugin selection (attempt ${attempts}/${PLUGIN_RESOLUTION_MISSING_MAX_RETRIES}); retrying in ${delayMs}ms`);
                        setTimeout(() => scheduleWorkspaceScan(workspaceId, requestedUris, authoritativeDeletes, "indexing"), delayMs);
                        return undefined;
                      }
                      pluginResolutionMissingRetries.delete(workspaceId);
                      console.error(`[urdira] workspace scan giving up on plugin resolution for ${workspaceId} after ${attempts} attempts; falling back to a generic source-only scan`);
                    }
                    // Generic source discovery is useful without a language
                    // plugin. Leave the registry in indexing state (there is
                    // intentionally no structural snapshot to mark ready),
                    // while the durable source catalog becomes queryable via
                    // API v3 source bindings.
                    /* c8 ignore start -- production app integration supplies this resolver; daemon unit tests use plugin-backed scans. */
                    const sourceIndexingCore = options.resolve_source_indexing_core === undefined
                      ? undefined
                      : await options.resolve_source_indexing_core(workspace, database);
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
                      ...(sourceIndexingCore === undefined ? {} : { indexing_core: sourceIndexingCore }),
                    });
                    /* c8 ignore stop */
                    workspaceWriterBusyRetries.delete(workspaceId);
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
                  // The Rust cutover also bypasses this compatibility copier
                  // until donor-row publication has a Rust-native command.
                  // The compatibility fork copier still uses the TypeScript
                  // bulk-copy API for donor rows. Until that copier is a
                  // first-class Rust worker command, never enter it on the
                  // production cutover route: falling through to the normal
                  // Rust generation is slower than a fork but preserves the
                  // single-writer invariant and avoids a second structural
                  // SQLite owner.
                  if (priorSnapshotId === undefined && plugin.indexing_core === undefined && options.workspace_fork !== false && hasPotentialWorkspaceForkDonor(workspace, registry)) {
                    try {
                      const forkOutcome = await attemptWorkspaceFork({ workspace, database, storage: durableStorage, registry, plugin, ...(plugin.indexing_core === undefined ? {} : { indexing_core: plugin.indexing_core }), ...(options.workspace_fork_verify === undefined ? {} : { verify_mode: options.workspace_fork_verify }) });
                      if (forkOutcome.status === "forked") {
                        registry.markReady(workspaceId, forkOutcome.snapshot_id, "ready");
                        workspaceWriterBusyRetries.delete(workspaceId);
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
                  // contract as `attemptWorkspaceFork`; it is compatibility-
                  // only while Rust owns production writes.
                  // As with workspace forks, pack bulk-copy remains an
                  // oracle/test implementation until its publication is
                  // driven by the Rust composition protocol. Production
                  // Rust generations must not be followed by a TypeScript
                  // structural transaction.
                  if (priorSnapshotId === undefined && plugin.indexing_core === undefined) {
                    const pendingPackPath = pendingIndexPackPaths.get(workspaceId);
                    if (pendingPackPath !== undefined) {
                      pendingIndexPackPaths.delete(workspaceId);
                      if (options.index_pack !== false) {
                        try {
                          /* c8 ignore next -- the production resolver supplies the Rust writer; pack-import unit tests use the compatibility oracle. */
                          const importOutcome = await attemptIndexPackImport({ workspace, database, storage: durableStorage, registry, plugin, ...(plugin.indexing_core === undefined ? {} : { indexing_core: plugin.indexing_core }), pack_path: pendingPackPath, ...(options.index_pack_verify === undefined ? {} : { verify_mode: options.index_pack_verify }) });
                          if (importOutcome.status === "imported") {
                            registry.markReady(workspaceId, importOutcome.snapshot_id, "ready");
                            workspaceWriterBusyRetries.delete(workspaceId);
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
                  } else if (priorSnapshotId === undefined && plugin.indexing_core !== undefined) {
                    // Consume a pending pack request even when the legacy
                    // copier is intentionally bypassed, so it cannot be
                    // replayed after the Rust full generation publishes.
                    pendingIndexPackPaths.delete(workspaceId);
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
                      // Frente S-H (Part 1), v3 sibling of `onQueryableLive`'s
                      // identical call: this callback ONLY fires once a real
                      // snapshot has published for this stage -- a pure
                      // equivalence check (no change found) never reaches it
                      // -- so this is the earliest point a `"checking_for_updates"`
                      // scan (skipped at admission, see `preemptMaintenanceForPublish`'s
                      // own doc comment) can confirm real work is happening.
                      preemptMaintenanceForPublish(workspaceId);
                      if (stage.ordinal < stage.stage_count) registry.markStructuralStagePublished(workspaceId, stageResult.snapshot_id);
                      notifyReadinessChanged(workspaceId);
                    },
                  });
                  registry.markReady(workspaceId, result.snapshot_id, "ready");
                  workspaceWriterBusyRetries.delete(workspaceId);
                  notifyReadinessChanged(workspaceId);
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
                  // v4 destructive-cutover recovery (plan §9, P4-a): the
                  // database this workspace's `openWorkspace` call above just
                  // tried to open is at an outdated index contract -- a v3
                  // database opened by v4 code, a v4 database opened by v3
                  // code, or a pre-v3/pre-v4 layout neither runtime accepts
                  // (`core:index_contract_unsupported`/
                  // `storage:workspace_format_outdated`, `packages/storage/src/schema.ts`
                  // and `storage.ts`'s `ensureIdentityFormat(V4)`). There is
                  // no in-place migration for this: `recreateOutdatedWorkspaceDatabase`
                  // moves every file/directory that belongs to this one
                  // workspace's on-disk footprint aside into a sibling
                  // `*.v3.stale-<timestamp>/` directory (never deletes --
                  // see that module's own doc comment), which clears the
                  // path for a brand-new database. `maybeBootstrapV4Workspace`
                  // then re-bootstraps that clear path in the CURRENT format
                  // (v4 unless `URDIRA_V4=0`, per `isV4Enabled`'s doc comment
                  // -- the same bootstrap step every first-ever scan already performs at
                  // the top of this `run`), and the `pendingScans` full-scan
                  // entry below reuses the exact same post-scan coalescer
                  // `core:source_changed` uses just below to schedule a
                  // fresh Full scan once this attempt settles.
                  if (isOutdatedWorkspaceError(error)) {
                    // `defaultWorkspaceDatabasePath`, not a `catalog.getWorkspace`
                    // lookup: the throw above can come from EITHER
                    // `durableStorage.catalog.registerWorkspace` (this
                    // workspace's very first touch this process life, when
                    // the on-disk file already exists at an outdated format
                    // -- `registerWorkspaceSerialized` validates schema
                    // compatibility before it ever inserts the catalog row,
                    // so `getWorkspace` would still return `undefined` here)
                    // or `durableStorage.openWorkspace` (every later scan of
                    // an already-catalogued workspace) -- both resolve the
                    // SAME default path for a fresh workspace id, and this
                    // runtime never registers one under a non-default path.
                    const outdatedDatabasePath = durableStorage.defaultWorkspaceDatabasePath(workspaceId);
                    try {
                      const recreated = await recreateOutdatedWorkspaceDatabase({
                        rootDir: options.data_root,
                        workspaceId,
                        databasePath: outdatedDatabasePath,
                        reason: error instanceof Error ? error.message : String(error),
                        logger: (line) => console.error(line),
                      });
                      await maybeBootstrapV4Workspace(workspaceId, durableStorage, options.semantic_index !== false);
                      console.error(`[urdira] workspace scan for ${workspaceId} recovered from an outdated-format database (moved ${recreated.movedPaths.length} file(s)/directory(ies) to ${recreated.staleDirectory}); scheduling a fresh Full scan`);
                      pendingScans.set(workspaceId, {
                        full: true,
                        uris: new Set(),
                        authoritativeDeletes: new Map(),
                        presencesAfterDeletes: new Set(),
                        activity: "indexing",
                      });
                      return undefined;
                    } catch (recreateError) {
                      console.error(`[urdira] workspace scan failed to recreate the outdated-format database for ${workspaceId}; falling back to the generic failure handling below:`, recreateError);
                    }
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
                  // `storage:workspace_writer_busy`: the foreground SQLite
                  // mutation could not acquire the cross-process writer lock
                  // within its bounded wait (`packages/storage/src/storage.ts`'s
                  // `acquireWorkspaceMutationLock`), almost always because
                  // detached Rust lexical maintenance is mid-chunk with the
                  // lease (`reconcile_lexical`,
                  // `crates/urdira-indexing-core/src/lib.rs`). That lease is
                  // released between chunks, so a short, capped, delayed
                  // retry is normally enough -- this is not an indexing
                  // failure and, like `core:source_changed` above, must not
                  // pin the workspace to a stale degraded snapshot or record
                  // a `last_scan_error` that would otherwise stick until the
                  // next successful scan.
                  if (failureCode === WORKSPACE_WRITER_BUSY_CODE) {
                    const attempts = (workspaceWriterBusyRetries.get(workspaceId) ?? 0) + 1;
                    if (attempts <= WORKSPACE_WRITER_BUSY_MAX_RETRIES) {
                      workspaceWriterBusyRetries.set(workspaceId, attempts);
                      const delayMs = Math.min(2_000, 1_000 + attempts * 250);
                      console.warn(`[urdira] workspace scan deferred for ${workspaceId}: workspace writer busy (attempt ${attempts}/${WORKSPACE_WRITER_BUSY_MAX_RETRIES}); retrying in ${delayMs}ms`);
                      setTimeout(() => scheduleWorkspaceScan(workspaceId, requestedUris, authoritativeDeletes, "indexing"), delayMs);
                      return undefined;
                    }
                    // The lease has stayed contended across every retry --
                    // no longer treated as a normal race. Clear the counter
                    // and fall through to the terminal failure handling
                    // below so this is at least diagnosable (recorded
                    // `last_scan_error`, workspace re-pinned to degraded).
                    workspaceWriterBusyRetries.delete(workspaceId);
                    console.error(`[urdira] workspace scan giving up for ${workspaceId} after ${attempts} workspace-writer-busy retries`);
                  } else {
                    workspaceWriterBusyRetries.delete(workspaceId);
                  }
                  // A scan failure must always leave a visible failure state --
                  // see `WorkspaceRegistry#recordScanFailure`'s own doc comment
                  // (2026-09-08 P0 fix) for the "first-ever scan, no snapshot at
                  // all" case it now handles directly (re-pins straight to
                  // "degraded" itself). The error must at least reach stderr too,
                  // or the failure is completely undiagnosable from the daemon
                  // process alone.
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
                  // Re-pin to "degraded" against the FRESHEST known snapshot, not
                  // just `priorSnapshotId` (captured before this scan started).
                  // A first-ever scan (`priorSnapshotId === undefined`) that got
                  // far enough to publish an intermediate structural stage
                  // (`markStructuralStagePublished`) before failing later already
                  // has a newer usable snapshot than `priorSnapshotId` -- re-read
                  // the workspace's own `current_snapshot_id` after `recordScan
                  // Failure` above so that case is re-pinned too, instead of
                  // silently relying on `recordScanFailure`'s own "no snapshot at
                  // all" fallback (which only covers the case where NEITHER a
                  // prior generation NOR an intermediate stage exists).
                  const latestSnapshotId = priorSnapshotId ?? registry.get(workspaceId)?.current_snapshot_id;
                  if (latestSnapshotId !== undefined) {
                    try { registry.markReady(workspaceId, latestSnapshotId, "degraded"); } catch { /* superseded by a concurrent scan or lifecycle change */ }
                  }
                  notifyReadinessChanged(workspaceId);
                } finally {
                  if (database) {
                    clearScanPending(database.database.filename);
                    await database.close().catch(() => undefined);
                  }
                }
                return undefined;
              } finally {
                scanInFlight.delete(workspaceId);
                notifyReadinessChanged(workspaceId);
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
                    // Preserve a second generation for same-path recreate
                    // batches (`pending.presencesAfterDeletes`) even when
                    // both callbacks arrived while the first scan was still
                    // running. `pending.uris` (P3-2 item 4: a cross-path
                    // rename's create, merged into the SAME buffer
                    // generation as its matching delete by `mergeScanRequest
                    // IntoBuffer`) is dispatched TOGETHER with the deletes
                    // just below instead of being discarded -- this used to
                    // hardcode `[]` here too, the same bug as `flushScan
                    // Aggregation`'s sibling branch.
                    if (pending.presencesAfterDeletes.size > 0) {
                      pendingScans.set(workspaceId, {
                        full: false,
                        uris: new Set(pending.presencesAfterDeletes),
                        authoritativeDeletes: new Map(),
                        presencesAfterDeletes: new Set(),
                        activity: pending.activity,
                      });
                    }
                    scheduleWorkspaceScan(workspaceId, [...pending.uris], [...pending.authoritativeDeletes.values()], pending.activity);
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
          notifyReadinessChanged(workspaceId);
          activeAuthoritativeDeletePhases.delete(workspaceId);
          scanActivities.delete(workspaceId);
          // Scheduler admission never actually started this scan -- restore
          // whatever timeline was already recorded (`fs_event_at`/
          // `aggregated_at`) so the eventual retry's own `runV4WorkspaceScan`
          // still reports them, instead of a silent gap.
          const abandonedTimeline = v4ActiveScanTimelines.get(workspaceId);
          if (abandonedTimeline !== undefined) {
            v4ActiveScanTimelines.delete(workspaceId);
            v4PendingScanTimelines.set(workspaceId, abandonedTimeline);
          }
        }
      };
      // Fires when a burst's aggregation window elapses (or is force-flushed
      // early -- see `core:query`/`core:query_continue`'s handler below,
      // "flush-on-query"), or is a no-op if the buffer was already flushed by
      // one of those. Replays the exact same `full`/`authoritativeDeletes`/
      // `presencesAfterDeletes`/`uris` branching `scheduleWorkspaceScan`'s
      // own post-scan `pendingScans` follow-up uses (see its `finally`
      // block, below) so a burst that happened to include a rename/recreate
      // still publishes the delete generation before the replacement, and
      // reuses `scheduleWorkspaceScan` itself (non-aggregatable, so this
      // never re-enters the buffering branch) to actually start the scan --
      // by then `scanAggregationBuffers` no longer holds an entry for this
      // workspace, so a concurrent watcher event arriving during that call
      // starts a brand-new burst rather than being folded into this one.
      const flushScanAggregation = (workspaceId: string): void => {
        const timer = scanAggregationTimers.get(workspaceId);
        if (timer !== undefined) clearTimeout(timer);
        scanAggregationTimers.delete(workspaceId);
        scanAggregationStartedAt.delete(workspaceId);
        const buffer = scanAggregationBuffers.get(workspaceId);
        scanAggregationBuffers.delete(workspaceId);
        if (buffer === undefined) return;
        // P3-5 timeline: the burst is settling into one (or two, for a
        // rename's delete+create pair) actual scan(s) right now.
        const pendingTimeline = v4PendingScanTimelines.get(workspaceId);
        if (pendingTimeline !== undefined) {
          pendingTimeline.aggregated_at = Date.now();
          debugTiming(`workspace=${workspaceId} aggregated_at`);
        }
        if (buffer.full) {
          scheduleWorkspaceScan(workspaceId, undefined, [], buffer.activity);
        } else if (buffer.authoritativeDeletes.size > 0) {
          // Preserve a second generation for same-path recreate batches
          // (`buffer.presencesAfterDeletes`), same rationale as the
          // post-scan `pendingScans` follow-up below: the tombstone
          // generation for the deletes publishes first, and any post-delete
          // presences buffered alongside them are queued as the follow-up
          // scan's own buffer. `buffer.uris`, in contrast, is dispatched
          // TOGETHER with the deletes in the SAME call just below (P3-2
          // item 4): a cross-path rename's create already lives in
          // `buffer.uris`, not `presencesAfterDeletes`, per `mergeScan
          // RequestIntoBuffer`'s fix above -- this used to hardcode `[]`
          // here, silently discarding `buffer.uris` and re-deferring even a
          // same-generation create to a separate follow-up scan.
          //
          // P3-2 item 4 fix (found live: a rename's Created half was being
          // silently dropped, causing the real daemon path to hang
          // indefinitely on a rename mutation): this USED TO call
          // `scheduleWorkspaceScan(workspaceId, [...presencesAfterDeletes],
          // [], activity)` directly, the same way the post-scan `finally`
          // block below calls it for `pending.uris`. That looked
          // symmetrical but was NOT: `scheduleWorkspaceScan` for the
          // deletes just above runs its `scanInFlight.add`/
          // `activeAuthoritativeDeletePhases.set` SYNCHRONOUSLY (no `await`
          // before either), so by the time control reached the
          // `presencesAfterDeletes` call on the very next line,
          // `scanInFlight` was already true for this workspace AND
          // `activeAuthoritativeDeletePhases` was already set from the
          // delete scan THIS SAME FLUSH just started. That call therefore
          // fell into the `pendingScans` merge branch with
          // `deletePhaseActive: true`, which routes its own uris into
          // `presencesAfterDeletes` AGAIN instead of `uris` -- and the
          // post-scan `finally` block's branch selection only ever reads
          // `pending.uris` when `pending.authoritativeDeletes` is empty
          // (see its own `else` branch below), never
          // `pending.presencesAfterDeletes` in that case. The created
          // path's presence silently vanished into a buffer field nothing
          // downstream reads. Fixed by seeding `pendingScans` directly here
          // (exactly like the post-scan `finally` block's own
          // `presencesAfterDeletes` handling a few dozen lines below
          // already does correctly) instead of routing through
          // `scheduleWorkspaceScan`/`mergeScanRequestIntoBuffer` a second
          // time -- `scanInFlight` is guaranteed false for this workspace
          // at this point (the aggregation-buffer branch that produced
          // `buffer` only runs while nothing is in flight), so the delete
          // scan started just below is guaranteed to be the very next scan
          // to observe this pre-seeded `pendingScans` entry in its own
          // `finally` block once it completes.
          if (buffer.presencesAfterDeletes.size > 0) {
            pendingScans.set(workspaceId, {
              full: false,
              uris: new Set(buffer.presencesAfterDeletes),
              authoritativeDeletes: new Map(),
              presencesAfterDeletes: new Set(),
              activity: buffer.activity,
            });
          }
          scheduleWorkspaceScan(workspaceId, [...buffer.uris], [...buffer.authoritativeDeletes.values()], buffer.activity);
        } else {
          scheduleWorkspaceScan(workspaceId, [...buffer.uris], [], buffer.activity);
        }
      };
      // Shutdown cleanup for the aggregation state above: cancels every still
      // -pending debounce/flush timer (a burst mid-window when `stop()` is
      // called) instead of leaving it to fire later against an already-
      // stopped scheduler. `scheduleWorkspaceScan`'s own scheduler-admission
      // `catch` already tolerates a submit call after the daemon starts
      // stopping, but an uncleared `setTimeout` would otherwise sit in the
      // event loop doing nothing useful, or fire the moment `.unref()` is not
      // honored on a platform. Wired into `DaemonRuntime.stop()` below via
      // the constructor.
      const clearScanAggregationTimers = (): void => {
        for (const timer of scanAggregationTimers.values()) clearTimeout(timer);
        scanAggregationTimers.clear();
        scanAggregationBuffers.clear();
        scanAggregationStartedAt.clear();
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
        if (options.lexical_owned_by_rust === true) return;
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
                // v4 (plan §9, P2-7): checked FIRST, ahead of the threaded
                // path below -- `runLexicalReconcileInThread`'s worker
                // thread (`lexical-worker-thread.ts`) calls
                // `reconcileLexicalProjection` against the MAIN workspace
                // database exactly like the non-threaded branch below it
                // does, and neither of those knows about v4's sidecar
                // split. `v4ReadinessState` (set by `runV4WorkspaceScan`,
                // above, the moment a v4 workspace's first scan starts) is
                // this function's cheap, synchronous way to tell without a
                // DB read. Deliberately runs in-process, not threaded, for
                // now (documented as a follow-up in this task's evidence
                // doc) -- v4 lexical maintenance is new work, not a
                // regression against any existing threaded contract.
                if (v4ReadinessState.has(workspaceId)) {
                  database = await durableStorage.openWorkspace(workspaceId);
                  const sidecarSql = await database.openSidecar("lexical");
                  // See this task's evidence doc, "maintenance on sidecars":
                  // `reconcileLexicalProjection`'s own SQL joins
                  // `lexical_documents` (sidecar-only) against
                  // `artifact_versions`/`workspace_current_state`
                  // (catalog-only) with UNQUALIFIED table names in the same
                  // query. Rather than editing that shared, v3-serving
                  // reconciler to qualify every reference, ATTACH the v4
                  // catalog file onto the sidecar connection: SQLite
                  // resolves an unqualified table name by searching `main`
                  // (here, the sidecar's own schema) then every attached
                  // database in attachment order, and the two schemas'
                  // table names are disjoint by construction (P2-1), so
                  // every reference in that shared SQL resolves correctly
                  // with zero changes to it.
                  const escapedCatalogPath = database.database.filename.replace(/'/g, "''");
                  await sidecarSql.exec(`ATTACH DATABASE '${escapedCatalogPath}' AS v4_catalog`);
                  // A duck-typed `WorkspaceDatabase`: `reconcileLexicalProjection`
                  // only ever reads `input.database.database` (the SQL
                  // connection, here the ATTACHed sidecar) and
                  // `input.database.projections.{putLexicalDocument,markLexicalComplete,lexicalCompletedGeneration}`.
                  // `WorkspaceDatabase` is a class with private fields, so it
                  // cannot be satisfied structurally by a plain object --
                  // this cast is the documented alternative to constructing
                  // a second REAL `WorkspaceDatabase` around the same
                  // already-`openSidecar`-owned connection, which would risk
                  // double-closing it (that connection's lifetime is owned
                  // by `database`, closed in this job's own `finally` below).
                  const sidecarHandle = {
                    database: sidecarSql,
                    projections: new WorkspaceProjectionRepository(sidecarSql, durableStorage.blobs, workspaceId),
                  } as unknown as WorkspaceDatabase;
                  const result = await reconcileLexicalProjection({ database: sidecarHandle, workspace_id: workspaceId, content: durableStorage.cas });
                  const priorReadiness = v4ReadinessState.get(workspaceId);
                  v4ReadinessState.set(workspaceId, {
                    ...priorReadiness,
                    lexical_completed_generation: result.marker_written ? result.generation : priorReadiness?.lexical_completed_generation,
                  });
                  return undefined;
                }
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
        // v4 storage wiring (2026-09-07): semantic maintenance now runs for a
        // v4 workspace too -- `reconcileSemanticProjection`'s entity-grain
        // lane is fed a native-store-backed `SemanticEntityRecordSource`
        // (`resolveV4SemanticEntitySource`, `semantic-v4-wiring.ts`) instead
        // of the v3-only `record_occurrences`/`record_value_nodes` SQL it
        // used to require unconditionally. `v4ReadinessState.has(workspaceId)`
        // is no longer consulted here at all; every call site (post-scan,
        // post-fork/pack-import, startup prewarm, the coalesced-pending
        // retry) now behaves identically for v3 and v4.
        if (semanticMaintenanceInFlight.has(workspaceId)) { semanticMaintenancePending.add(workspaceId); return; }
        semanticMaintenanceInFlight.add(workspaceId);
        try {
          scheduler.submit({
            job_id: `semantic-maintenance:${workspaceId}:${randomUUID()}`,
            client_id: "core:semantic_maintenance",
            workspace_id: workspaceId,
            pool: "semantic",
            run: async () => {
              // Frente S-H: one genuine run admission (never fired for a
              // call coalesced into `semanticMaintenancePending` above) --
              // see `on_semantic_maintenance_started`'s own doc comment.
              options.on_semantic_maintenance_started?.(workspaceId);
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
                  // Frente S-D (2026-09-07, Lever 2): `semantic_shard_count`
                  // omitted or `<= 1` degrades `runSemanticReconcileSharded`
                  // to exactly the pre-Lever-2 single-process call -- see
                  // that option's own doc comment.
                  const threadRun = runSemanticReconcileSharded({ data_root: options.data_root, workspace_id: workspaceId, descriptor: semanticDescriptor!, ...(options.semantic_embed_batch_size === undefined ? {} : { embed_batch_size: options.semantic_embed_batch_size }) }, options.semantic_shard_count ?? 1);
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
                  // v4 storage wiring: `undefined` for a v3 workspace, which
                  // keeps the original SQL path unmodified -- see
                  // `resolveV4SemanticEntitySource`'s own doc comment.
                  const entityRecordSource = await resolveV4SemanticEntitySource(database, durableStorage.cas, workspaceId);
                  reconciled = await reconcileSemanticProjection({ database, workspace_id: workspaceId, content: durableStorage.cas, provider, wait_for_query_drain: waitForQueryDrain, ...(options.semantic_embed_batch_size === undefined ? {} : { embed_batch_size: options.semantic_embed_batch_size }), ...(entityRecordSource === undefined ? {} : { entity_record_source: entityRecordSource }) });
                }
                const workspace = options.workspace_registry?.get(workspaceId);
                semanticMaterializations.set(workspaceId, semanticMaterializationView(workspaceId, reconciled, provider, workspace?.current_snapshot_id ?? ""));
                // v4 storage wiring (2026-09-07): mirrors `submitLexicalMaintenance`'s
                // v4 branch updating `lexical_completed_generation` -- a no-op
                // for a v3 workspace (`v4ReadinessState.has` is false there).
                // `v4WorkspaceReadinessFrom`/`v4StatusFields` read this back
                // into `core:index_status`'s `semantic.completed_generation`/
                // `semantic.current` fields.
                if (reconciled.marker_written && v4ReadinessState.has(workspaceId)) {
                  const priorV4Readiness = v4ReadinessState.get(workspaceId);
                  v4ReadinessState.set(workspaceId, { ...priorV4Readiness, semantic_completed_generation: reconciled.generation });
                }
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
      // ready.
      //
      // Adversarial-review note (Frente E, 2026-09-06): for a v3 workspace
      // this is still a full-rescan retry (v3 has no incremental recovery
      // semantics -- `runFullWorkspaceScan`/`CandidateIndexer`,
      // `packages/engine/src/workspace-indexing-session.ts`, not modified by
      // this change -- so a fresh full scan is the simplest correct retry;
      // a very large v3 workspace pays for a full rescan after every crash
      // instead of resuming near where it left off, a known limitation).
      // For a NON-first-scan v4 workspace, this call has no URIs, so
      // `runV4WorkspaceScan`'s own scope decision (`packages/daemon/src/
      // runtime.ts`, this task's own diff) now routes it through
      // `ScanScope::Reconcile` rather than `Full` -- deliberately NOT added
      // to `forceFullScans`. `run_reconcile` performs the exact same
      // authoritative walk `Full` would (never trusting anything the
      // crashed process left behind, including a dangling
      // `Catalog::apply`-but-never-published generation --
      // `catalog::read_highest_applied_generation`'s doc comment), so it is
      // equally correct, and strictly cheaper when the crash happened
      // between two otherwise-unrelated edits: a real recovery win this
      // sweep gets "for free" from Frente E's own invariant ("T moves cost,
      // never the result"), not a regression back to the "no partial-
      // progress resumption" limitation this comment used to describe.
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
        // `aggregatable: true` -- this is the ONE call site a real
        // filesystem watcher event reaches (see `scheduleWorkspaceScan`'s
        // `aggregatable` doc comment above): eligible to buffer for up to
        // `scan_aggregation_window_ms` before its scan actually starts,
        // instead of starting immediately.
        on_reconcile: async (workspaceId, changedUris, _reason, authoritativeDeletes = []) => {
          try { options.workspace_registry?.beginReconciliation(workspaceId); scheduleWorkspaceScan(workspaceId, changedUris, authoritativeDeletes, "indexing", true); } catch { /* removed workspaces are ignored */ }
        },
      }) : undefined;
      server = new LocalIpcServer({ endpoint: paths.endpoint, ...(options.max_frame_bytes === undefined ? {} : { max_frame_bytes: options.max_frame_bytes }), handler: async (request, context) => {
        // `daemon_epoch_ms_offset` (P3-5, plan §6.1's daemon-latency item):
        // the epoch ms this module loaded at (`DAEMON_START_EPOCH_MS`), the
        // zero point every v4 workspace's `last_scan_timeline` (below) is
        // relative to. An external harness with its own epoch-ms clock for
        // when it performed a mutation's filesystem write can add this back
        // to a reported relative timestamp to compute a true latency on the
        // SAME clock, rather than being limited to poll-granularity timing.
        // Additive: not part of `DaemonStatus`'s declared shape, so this is
        // a widening cast, not a type change.
        if (request.call === "core:status") return { state: "ready", pid: process.pid, engine_build_id: options.engine_build_id, private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION, rpc_capabilities: rpcCapabilities, endpoint: paths.endpoint, active_jobs: scheduler.activeCount, restart_leases: scheduler.restartLeaseCount, daemon_epoch_ms_offset: DAEMON_START_EPOCH_MS, ...(latestOrphanReport === undefined ? {} : { orphaned_workspace_data: { count: latestOrphanReport.orphans.length, bytes: latestOrphanReport.orphans.reduce((sum, group) => sum + group.total_bytes, 0) } }) } satisfies DaemonStatus;
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
            // `last_scan_timeline` (P3-5, plan §6.1's daemon-latency item):
            // only ever present for a v4 workspace (`v4ReadinessState.has`
            // is v4's own bootstrap marker, see `runV4WorkspaceScan`'s first
            // line) -- the currently in-flight scan's timeline if one is
            // running, else the most recently settled one. Absent (not an
            // empty object) for a v3 workspace or a v4 workspace that has
            // never had a watcher-driven/timed scan yet.
            const v4Timeline = v4ReadinessState.has(workspace.workspace_id)
              ? (v4ActiveScanTimelines.get(workspace.workspace_id) ?? v4LastScanTimelines.get(workspace.workspace_id))
              : undefined;
            return { workspace_id: workspace.workspace_id, codebase_id: workspace.codebase_id, project_name: administrative["project_name"], workspace_label: administrative["workspace_label"], workspace_kind: administrative["workspace_kind"], display_root: basename(workspace.display_root), ...(administrative["vcs_state"] === undefined ? {} : { vcs_state: administrative["vcs_state"] }), workspace_status: workspace.status, startup_phase: workspace.status === "registering" ? "reconciling_sources" : readiness.source_ready && !readiness.structural_ready ? "publishing_structural" : "ready", ...(workspace.current_snapshot_id === undefined ? {} : { current_snapshot_id: workspace.current_snapshot_id }), freshness_status: workspaceFreshnessStatus(workspace), ...(workspace.last_scan_error === undefined ? {} : { last_scan_error_code: workspace.last_scan_error }), ...(workspace.last_scan_error_at === undefined ? {} : { last_scan_error_at: workspace.last_scan_error_at }), plugins: pluginStatus.plugins, capabilities: pluginStatus.capabilities, structural_progress: pluginStatus.structural_progress, semantic_materializations: semanticMaterializations.get(workspace.workspace_id) === undefined ? [] : [semanticMaterializations.get(workspace.workspace_id)!], configuration_issues: [], ...readinessPayload(readiness), ...(v4Timeline === undefined ? {} : { last_scan_timeline: relativeTimeline(v4Timeline) }), ...v4StatusFields(readiness, semanticMaterializations.get(workspace.workspace_id), v4LastScanSummaries.get(workspace.workspace_id), v4Timeline) };
          };
          // v4 (plan §6, Frente H): the same cached sweep `core:status`
          // reads (see `DaemonStatus.orphaned_workspace_data`'s doc comment
          // for why this is the last sweep, not a live re-sweep) --
          // `urdira_index_status` is the MCP tool an agent already always
          // calls first, so surfacing it here (rather than inventing a
          // separate lookup) is what actually reaches the renderer
          // (`renderIndexStatusText`, `@urdira/mcp`).
          const orphanedWorkspaceDataField = latestOrphanReport === undefined ? {} : { orphaned_workspace_data: { count: latestOrphanReport.orphans.length, bytes: latestOrphanReport.orphans.reduce((sum, group) => sum + group.total_bytes, 0) } };
          if (apiVersion === 3 && workspaceIds.length === 0 && payload.workspace_root === undefined) return { workspaces: await Promise.all(options.workspace_registry.list().map(buildStatusView)), ...orphanedWorkspaceDataField };
          const resolution = resolveIndexStatusRequest(options.workspace_registry, { api_version: apiVersion, workspace_ids: workspaceIds, ...(typeof payload.workspace_root === "string" ? { workspace_root: payload.workspace_root } : {}) });
          if ("error" in resolution) throw new DaemonError(resolution.error.code, "Workspace index status is unavailable.", resolution.error.details);
          const workspace = options.workspace_registry.get(resolution.workspace_id);
          if (workspace === undefined) return { workspaces: [], ...orphanedWorkspaceDataField };
          return { workspaces: [await buildStatusView(workspace)], ...orphanedWorkspaceDataField };
        }
        const queryStorage = indexingStorage;
        if ((request.call === "core:query" || request.call === "core:query_continue") && options.workspace_registry && queryStorage && cursorCache) {
          const registry = options.workspace_registry;
          const storage = queryStorage;
          const cache = cursorCache;
          const workspaceId = singleWorkspaceScopeId(request.payload);
          if (workspaceId === undefined) throw new DaemonError("core:ipc_request_invalid", `${request.call} requires an explicit single_workspace scope.`);
          // Flush-on-query: a query naming this workspace must not be made to
          // wait out an in-progress aggregation window (see
          // `DaemonRuntimeOptions.scan_aggregation_window_ms`'s doc comment)
          // for edits that already arrived -- force whatever is buffered to
          // start scanning right now. Best-effort and synchronous (never
          // awaited): a no-op when nothing is buffered for this workspace,
          // and even a genuine flush only submits the scan job here, it does
          // not block this request on the scan itself (freshness/frontier
          // waits below already handle that).
          flushScanAggregation(workspaceId);
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
          const cachedQuery = await acquireWorkspaceQueryEngine(workspaceId, registry, storage, cache, queryEngines, recordBodyInterner, warmRecordsLru, semanticProvider, queryUsesSourceBinding(request.payload));
          const engine = cachedQuery.engine;
          // A cold `core:query`/`core:query_continue` can itself trigger a
          // full `records()` load (see `acquireWorkspaceQueryEngine`'s own
          // doc comment) exactly like an explicit warm -- re-checking the
          // budget after `execute()`/`continue()` settles catches that case
          // too, not just the explicit `warmWorkspaceQueryEngine` call
          // sites, per `DaemonRuntimeOptions.warm_records_budget_mb`'s "after
          // any load/warm completes" rule.
          if (request.call === "core:query") {
            const rawQueryRequest = request.payload as QueryRequest;
            const maxFrameBytes = options.max_frame_bytes ?? IPC_DEFAULT_MAX_FRAME_BYTES;
            const requestedMaxCharacters = rawQueryRequest.options.response_budget.max_characters;
            const clampedMaxCharacters = frameSafeMaxCharacters(maxFrameBytes, requestedMaxCharacters);
            const queryRequest: QueryRequest = clampedMaxCharacters === requestedMaxCharacters ? rawQueryRequest : { ...rawQueryRequest, options: { ...rawQueryRequest.options, response_budget: { ...rawQueryRequest.options.response_budget, max_characters: clampedMaxCharacters } } };
            const hydrationStartedAt = Date.now();
            try {
              const page = attachIndexFreshness(await engine.execute(queryRequest, context.signal), registry.get(workspaceId));
              if (cachedQuery.operation_telemetry !== undefined) {
                emitTiming("operation_metrics", `operation_metrics=${JSON.stringify(cachedQuery.operation_telemetry.snapshot())}`);
                emitTiming("operation_page_metrics", `operation_page_metrics=${JSON.stringify(cachedQuery.operation_telemetry.pageSnapshot())}`);
              }
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
            const maxFrameBytes = options.max_frame_bytes ?? IPC_DEFAULT_MAX_FRAME_BYTES;
            return attachIndexFreshness(await engine.continue({ cursor, response_budget: { max_items: budget["max_items"] as number, max_characters: frameSafeMaxCharacters(maxFrameBytes, budget["max_characters"] as number) } }), registry.get(workspaceId));
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
            if (confirmed && indexingStorage !== undefined) await ensureWorkspaceCatalogRegistration(existing, indexingStorage, options.semantic_index !== false);
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
          if (confirmed && indexingStorage !== undefined) await ensureWorkspaceCatalogRegistration(workspace, indexingStorage, options.semantic_index !== false);
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
          // Frente P-1 (`generic-waddling-hartmanis.md` §7.1): a v4 workspace
          // ("ready") can still have a `reconcile`/`changed` scan running in
          // the background -- `status` alone does not imply "no scan in
          // flight" for v4 the way it always has for v3 (a v3 scan always
          // pins `status` to `"indexing"` first). Exporting mid-scan would
          // read a `merkle_roots`/`snapshots` row for a generation whose
          // `structural/` files a concurrent scan is still rewriting.
          //
          // Fix (2026-09-06, live evidence in
          // `tests/phase-daemon-v4-index-pack.test.ts`): rejecting the very
          // instant `scanInFlight` is observed true is too eager. `registry
          // .markReady` (inside `runV4WorkspaceScan`) flips `workspace.status`
          // to `"ready"` several lines BEFORE that same scan's own
          // `scanInFlight.delete` runs -- the scan job's `finally` still has
          // to close its (by then unused) per-scan `WorkspaceDatabase` handle,
          // a real, awaited disk operation. Measured live: ~2-15ms. A caller
          // that polls `core:index_status` until `"ready"` and immediately
          // calls `core:index_pack_export` next (exactly what `workspace-add
          // --index-pack`'s donor-export step does, and what this suite's own
          // `pollUntilReady` does) can land inside that window and see a scan
          // "in progress" that has, in truth, already produced its final,
          // consistent generation. Waiting (bounded -- so a genuinely
          // long-running concurrent scan still surfaces the lifecycle error
          // below instead of hanging the whole RPC) for `scanInFlight` to
          // clear turns that spurious failure into a few-millisecond delay.
          const scanSettleDeadlineMs = Math.min(Date.now() + INDEX_PACK_EXPORT_SCAN_SETTLE_WAIT_MS, Date.parse(context.deadline_at));
          if (!(await waitForScanSettled(workspace.workspace_id, scanInFlight, context.signal, scanSettleDeadlineMs))) {
            throw new DaemonError("core:workspace_lifecycle", "Workspace has a scan in progress; index pack export requires no scan in flight.");
          }
          const requireGitClean = values["require-git-clean"] === "true";
          // 2026-09-08 P0 fix (docs/evidence/2026-09-07-v4-vscode-campaign.md
          // §6.0/§9 item 3): a large export used to run silently for its
          // whole duration with no progress signal at all -- a caller
          // watching `on_progress` (the CLI's own terminal rendering) saw
          // nothing until the RPC either finished or hit a timeout. `out
          // Path`'s own growing file size, sampled on an interval and pushed
          // through `context.reportProgress` (the same streamed-frame
          // mechanism `core:workspace_preview`'s file-discovery progress
          // already uses), gives a real, live signal without needing to wait
          // for `exportV4IndexPack`/`exportIndexPack` to report their own
          // internal progress -- both write their single output file
          // incrementally regardless of format (v4's gzip container, v3's
          // tagged-NDJSON stream). Cleared unconditionally in `finally`
          // below so a thrown/cancelled export never leaves a dangling timer.
          const exportStartedAt = Date.now();
          let exportProgressBytesTotal: number | undefined;
          const exportProgressInterval = setInterval(() => {
            stat(outPath).then((info) => {
              context.reportProgress({ phase: "index_pack_export", completed: info.size, ...(exportProgressBytesTotal === undefined ? {} : { total: exportProgressBytesTotal }), message: `writing index pack (${info.size} bytes so far)` });
            }).catch(() => undefined);
          }, 1_000);
          try {
          // v4 (native structural store) branches to a completely different
          // export container (`exportV4IndexPack`, a single gzip file of
          // `workspace.sqlite` + `structural/` + `sidecar/`) than v3's
          // tagged-NDJSON row replay -- see `index-pack.ts`'s v4 section
          // doc comment. A short-lived read-only open is enough to tell
          // which one this workspace is; it is closed again before either
          // worker thread opens its own connection to the same file.
          const structuralStoreDatabase = await indexingStorage.openWorkspace(workspace.workspace_id);
          const structuralStoreKind = await readStructuralStore(structuralStoreDatabase.database).finally(() => structuralStoreDatabase.close().catch(() => undefined));
          if (structuralStoreKind === "native") {
            const databasePath = indexingStorage.defaultWorkspaceDatabasePath(workspace.workspace_id);
            // Best-effort progress denominator only (never blocks the export
            // itself, and a stale/wrong estimate only affects the reported
            // percentage, never correctness): the uncompressed container is
            // roughly `structural/` + the sqlite catalog's own on-disk size
            // (§6.4 of the evidence doc above measured the compressed pack at
            // ~44% of this sum on a real 3.6GB VS Code-scale store).
            exportProgressBytesTotal = await Promise.all([
              directorySizeBytesForProgressEstimate(structuralStoreDirFor(databasePath)),
              stat(databasePath).then((info) => info.size).catch(() => 0),
            ]).then(([structuralBytes, databaseBytes]) => structuralBytes + databaseBytes).catch(() => undefined);
            // `exportV4IndexPack` (inside the worker thread) independently
            // guards against a concurrent scan publishing a NEW generation
            // while the export's own file walk is in flight -- it re-reads
            // `current_generation` after the walk and throws
            // `IndexPackExportRaceError` (name preserved across the thread
            // boundary, see that class's doc comment) if it moved. That is a
            // genuine race distinct from the gate above (a second scan that
            // started AFTER the wait above already cleared): retry the whole
            // export from scratch, waiting for the new scan to settle first,
            // up to `INDEX_PACK_EXPORT_MAX_ATTEMPTS` times, before finally
            // surfacing the race to the caller. Every attempt that succeeds
            // is, by that same internal check, a single consistent
            // generation's worth of `roots`/`structural/` files -- there is
            // no separate re-verification to do here.
            let resultV4: Awaited<ReturnType<typeof runIndexPackExportV4InThread>> | undefined;
            for (let attempt = 1; ; attempt++) {
              try {
                resultV4 = await runIndexPackExportV4InThread({
                  database_path: databasePath,
                  structural_root: structuralStoreDirFor(databasePath),
                  sidecar_root: sidecarScanDirFor(databasePath),
                  workspace_id: workspace.workspace_id,
                  out_path: outPath,
                  ...(requireGitClean ? { require_git_clean: true, canonical_root: workspace.canonical_root } : {}),
                });
                break;
              } catch (error) {
                const isRace = error instanceof Error && error.name === "IndexPackExportRaceError";
                if (!isRace || attempt >= INDEX_PACK_EXPORT_MAX_ATTEMPTS) throw error;
                const retryDeadlineMs = Math.min(Date.now() + INDEX_PACK_EXPORT_SCAN_SETTLE_WAIT_MS, Date.parse(context.deadline_at));
                await waitForScanSettled(workspace.workspace_id, scanInFlight, context.signal, retryDeadlineMs);
              }
            }
            // `pack_path` alongside the pre-existing `out_path` (kept for
            // backward compatibility with any existing caller reading it):
            // the design this task's plan called for names the field
            // `pack_path` (`{pack_path, bytes, generation, roots,
            // export_wall_ms}`).
            return { workspace_id: workspace.workspace_id, out_path: resultV4.pack_path, pack_path: resultV4.pack_path, generation: resultV4.manifest.generation, bytes: (await stat(resultV4.pack_path)).size, roots: resultV4.manifest.roots, export_wall_ms: Date.now() - exportStartedAt };
          }
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
          return { workspace_id: workspace.workspace_id, out_path: result.out_path, pack_path: result.out_path, pack_id: result.manifest.pack_id, manifest_digest: result.manifest.manifest_digest, row_counts: result.manifest.row_counts, export_wall_ms: Date.now() - exportStartedAt };
          } finally {
            clearInterval(exportProgressInterval);
          }
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
        // v4 (plan §6, Frente H): read-only, no-confirmation re-sweep -- the
        // CLI's `urdira workspace orphans` routes here through `MUTATING_COMMANDS`'s
        // `directCommand` bypass (`@urdira/cli`) purely to reuse its
        // preview/dispatch plumbing, not because this call mutates
        // anything.
        if (options.workspace_registry && indexingStorage && request.call === "core:workspace_orphans_list") {
          latestOrphanReport = await sweepWorkspaceDataDir({ workspacesDir: workspacesDataDir, knownSafeIds: knownWorkspaceSafeIds() });
          return { orphans: latestOrphanReport.orphans, retained_stale: latestOrphanReport.retained_stale, in_progress: latestOrphanReport.in_progress };
        }
        if (options.workspace_registry && indexingStorage && request.call === "core:workspace_orphans_purge") {
          const payload = requestRecord(request.payload);
          const requestedSafeIds = Array.isArray(payload["args"]) ? payload["args"].filter((value): value is string => typeof value === "string") : [];
          const values = requestRecord(payload["values"]);
          const all = values["all"] === "true";
          if (!all && requestedSafeIds.length === 0) throw new DaemonError("core:ipc_request_invalid", "core:workspace_orphans_purge requires --all or at least one safe_id.");
          // `--all` and explicit safe ids together is ambiguous intent, not
          // a "do both, ids win" or "do both, --all wins" convenience: a
          // caller who typed `--all workspace_a` almost certainly meant one
          // or the other, and silently purging every orphan when they named
          // one specific id (or vice versa) is exactly the kind of
          // "function invocable by the agent = 100% functional" fidelity
          // gap plan §0(c) exists to close. Reject instead of guessing.
          if (all && requestedSafeIds.length > 0) throw new DaemonError("core:ipc_request_invalid", "core:workspace_orphans_purge accepts --all or explicit safe_ids, not both.");
          const knownSafeIds = knownWorkspaceSafeIds();
          const report = await sweepWorkspaceDataDir({ workspacesDir: workspacesDataDir, knownSafeIds });
          latestOrphanReport = report;
          const candidates = all ? report.orphans : report.orphans.filter((group) => requestedSafeIds.includes(group.safe_id));
          const purged: string[] = [];
          let bytesFreed = 0;
          for (const group of candidates) {
            // Defensive re-check (R15): a race between the sweep above and
            // this loop (a concurrent `core:workspace_add` re-registering
            // the same safe id, or a query opening a handle against it)
            // must never delete a now-live workspace's files just because
            // the report captured it a moment earlier as an orphan.
            if (knownSafeIds.has(group.safe_id)) continue;
            if (isWorkspaceDatabaseFileOpen(join(workspacesDataDir, `${group.safe_id}.sqlite`))) continue;
            const entries: WorkspaceFootprintEntry[] = group.entries.map((entry) => ({ path: entry.path, kind: entry.kind, is_directory: entry.kind === "structural" || entry.kind === "sidecar" }));
            await removeWorkspaceFootprint(entries, { keep_database: false });
            purged.push(group.safe_id);
            bytesFreed += group.total_bytes;
          }
          latestOrphanReport = await sweepWorkspaceDataDir({ workspacesDir: workspacesDataDir, knownSafeIds: knownWorkspaceSafeIds() });
          return { purged, bytes_freed: bytesFreed, remaining: latestOrphanReport.orphans };
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
          const requestedScope = values["scope"];
          if (requestedScope !== undefined && requestedScope !== "full" && requestedScope !== "reconcile") {
            throw new DaemonError("core:ipc_request_invalid", "core:reindex scope must be full or reconcile.");
          }
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
          // `core:reindex` remains a full republish by default. The explicit
          // `scope: reconcile` form is the deterministic recovery trigger
          // used by benchmark harnesses and other callers that need the
          // authoritative changed frontier without forcing a full scan. Keep
          // the force-full marker out of that form so v4's existing
          // `requestedUris === undefined` -> `ScanScope::Reconcile` path can
          // perform its bounded delta walk. If a scan is already in flight,
          // the full form still forces the NEXT one full as before.
          if (requestedScope !== "reconcile") forceFullScans.add(workspace.workspace_id);
          if (!alreadyIndexing) scheduleWorkspaceScan(workspace.workspace_id);
          return { workspace_id: workspace.workspace_id, status: operation.workspace.status, reconciliation_operation_id: operation.operation_id, reindex_started: !alreadyIndexing, scope: requestedScope === "reconcile" ? "reconcile" : "full" };
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
          // Adversarial-review fix (Frente E, 2026-09-06): a non-`query_only`
          // `impact` (`"plugin_resolution"`/`"source_selection"`/
          // `"semantic_projection"`/`"analysis"`, `classifyWorkspaceConfigurationImpact`)
          // means the RULES for interpreting the SAME on-disk bytes changed,
          // not the bytes themselves. `runV4WorkspaceScan`'s reconcile
          // default derives its delta from an authoritative FILE-CONTENT
          // walk (`catalog::enumerate`/`diff`) -- it has no way to see a
          // configuration-only change, so an unmodified reconcile call here
          // would find `touched_count == 0` and take the `Noop` branch,
          // silently leaving the workspace serving results built under the
          // STALE configuration forever. `forceFullScans` (same mechanism
          // `core:reindex` uses, above) makes this call always `full`
          // instead, same as it did before Frente E's `reconcile` default.
          if (indexing) forceFullScans.add(workspace.workspace_id);
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
      const runtime = new DaemonRuntime(options, paths, lock, descriptor, checkpoint, server!, scheduler, recoveredCheckpoint, recovery, recoveredCursorIds, pendingWarms, watcherManager, indexingStorage, queryEngines, reconciliationSweepTimer, semanticHost, clearScanAggregationTimers);
      runtime.state = "ready";
      runtimeHandle = runtime;
      options.on_startup_progress?.("ready");
      return runtime;
    } catch (error) { await server?.close().catch(() => undefined); await indexingStorage?.close().catch(() => undefined); if (process.platform !== "win32") await unlink(paths.endpoint).catch(() => undefined); await lock.release(); throw error; }
  }
  status(): DaemonStatus { return { state: this.state, pid: process.pid, engine_build_id: this.options.engine_build_id, private_interface_version: DAEMON_PRIVATE_INTERFACE_VERSION, rpc_capabilities: daemonRpcCapabilities(this.options.workspace_registry !== undefined), endpoint: this.endpoint, active_jobs: this.scheduler.activeCount, restart_leases: this.scheduler.restartLeaseCount, daemon_epoch_ms_offset: DAEMON_START_EPOCH_MS }; }
  byteTelemetrySnapshot(): Readonly<Record<string, unknown>> {
    return this.indexingStorage?.byteTelemetry.snapshot() ?? {};
  }
  /** Internal diagnostic snapshot; never exposed by MCP or query responses. */
  queryOperationTelemetrySnapshot(): Readonly<Record<string, readonly QueryOperationTelemetrySummary[]>> {
    return Object.fromEntries(
      [...(this.queryEnginesForTest?.entries() ?? [])]
        .filter((entry): entry is [string, CachedWorkspaceQueryEngine & { readonly operation_telemetry: QueryOperationTelemetry }] => entry[1].operation_telemetry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([workspaceId, cached]) => [workspaceId, cached.operation_telemetry.snapshot()]),
    );
  }
  async stop(options: { readonly force?: boolean } = {}): Promise<void> {
    if (this.state === "stopping") return;
    this.state = "stopping";
    clearInterval(this.reconciliationSweepTimer);
    // Cancel any burst-aggregation window still open when the daemon stops
    // (see `scan_aggregation_window_ms`'s doc comment and
    // `clearScanAggregationTimers`'s own doc comment above): otherwise a
    // buffered burst's debounce timer would keep sitting in the event loop
    // for up to `scan_aggregation_max_ms` after shutdown began.
    this.clearScanAggregationTimers?.();
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
