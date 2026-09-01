// A small per-workspace pool of `WorkerTransport` instances (today, always
// the JavaScript/TypeScript analysis worker -- see `apps/urdira/src/index.ts`'s
// `buildJavascriptTypescriptPluginProvider`), replacing the create-a-worker-
// per-scan/hard-terminate-in-`finally` pattern `thread-transport.ts`'s own
// header comment used to describe as "the natural Phase 5 hook, once
// pooling is wired up." A pooled worker's whole point is to survive across
// scans of the SAME workspace: `@urdira/plugin-javascript-typescript`'s
// `JsTsAnalysisSession` (held inside the worker, one per worker instance --
// see `worker.ts`) keeps a per-file memo that only pays off when the worker
// itself keeps living between an edit and the next rescan.
//
// Deliberately generic over `WorkerTransport` (`@urdira/plugin-sdk`) rather
// than JS/TS-specific: nothing here reads or writes any JS/TS-shaped
// payload. Lives in `apps/urdira` (not `@urdira/daemon`) for the same reason
// `buildJavascriptTypescriptPluginProvider` itself does -- `@urdira/daemon`
// has no dependency on any production language plugin (AGENTS.md), so it
// only ever calls the two plain-function hooks this module's owner supplies
// via `DaemonRuntimeOptions.analysis_worker_pool_evict`/`_close_all`, never
// touching a pool instance directly.

import type { WorkerTransport } from "@urdira/plugin-sdk";
import type {
  IndexingResourceAccountingPort,
  ProcessTreeRssAdmissionRequest,
  ProcessTreeRssReservation,
  ProcessTreeRssTelemetry,
} from "./process-tree-rss.js";

export interface AnalysisWorkerPoolOptions<TDescriptor> {
  /** Builds a fresh worker for a cache miss (a new workspace, a descriptor-digest
   * change, or after an eviction). Synchronous, matching
   * `createJavascriptTypescriptThreadTransport`/`createJavascriptTypescriptWorker`'s
   * own synchronous construction (a `Worker`/in-process closure is ready to
   * `invoke` immediately; nothing here needs to await a build). */
  readonly create: (descriptor: TDescriptor) => WorkerTransport;
  /** Prune cap: entries beyond this count are evicted LRU-first among
   * currently-idle (released, not on-loan) entries. Default 2. */
  readonly max_entries?: number;
  /** Hard cap on concurrent worker leases. Acquisition fails instead of
   * sharing a worker or silently creating an unbounded process fan-out. */
  readonly max_active?: number;
  /** Idle time after `release()` before an unused entry is proactively
   * evicted. Default 300000 (5 minutes). */
  readonly idle_ttl_ms?: number;
  /** Optional internal process-tree RSS admission. Callers must use
   * `acquireWithResourceAdmission` when configured; the synchronous path is
   * rejected so native child processes cannot bypass accounting. */
  readonly resource_accounting?: IndexingResourceAccountingPort;
}

interface PoolEntry<TDescriptor> {
  readonly worker: WorkerTransport;
  readonly descriptor: TDescriptor;
  readonly descriptor_digest: string;
  in_use: boolean;
  idle_timer: NodeJS.Timeout | undefined;
  resource_reservation: ProcessTreeRssReservation | undefined;
}

function workerIsUnusable(worker: WorkerTransport): boolean {
  // The optional hook is deliberately outside the public worker protocol so
  // existing plugin transports remain valid. The threaded JS/TS transport
  // exposes it only for a terminal worker error; its in-process recovery path
  // remains healthy and reusable.
  const health = (worker as WorkerTransport & { readonly is_healthy?: () => boolean }).is_healthy;
  return health !== undefined && health() === false;
}

/**
 * One live worker per key (today, `workspace_id`), reused across scans as
 * long as its descriptor digest stays the same. `acquire`/`release` bracket
 * exactly the way `createWorker(...)`/`await worker.terminate()` used to:
 * a scan's `finally` calls `release(key)` instead of `terminate()`, and the
 * worker keeps running for the next scan of the same workspace to reuse.
 *
 * Real termination (closing the worker, which for the JS/TS worker also
 * kills its Go analysis-server child process) only ever happens on:
 *  - a descriptor-digest change (`acquire` with a different digest than the
 *    live entry's own -- e.g. a plugin upgrade changed the analysis/registry
 *    digests baked into the descriptor);
 *  - explicit `evict(key)` (workspace removal, wired through
 *    `DaemonRuntimeOptions.analysis_worker_pool_evict`);
 *  - `closeAll()` (daemon shutdown, wired through
 *    `DaemonRuntimeOptions.analysis_worker_pool_close_all`);
 *  - idle TTL expiry after `release()`;
 *  - LRU eviction once the live entry count exceeds `max_entries`.
 */
export class AnalysisWorkerPool<TDescriptor> {
  private readonly entries = new Map<string, PoolEntry<TDescriptor>>();
  private readonly create: (descriptor: TDescriptor) => WorkerTransport;
  private readonly maxEntries: number;
  private readonly maxActive: number;
  private readonly idleTtlMs: number;
  private readonly resourceAccounting: IndexingResourceAccountingPort | undefined;
  private activeLeases = 0;

  constructor(options: AnalysisWorkerPoolOptions<TDescriptor>) {
    this.create = options.create;
    this.maxEntries = options.max_entries ?? 2;
    this.maxActive = options.max_active ?? this.maxEntries;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1) throw new Error("Analysis worker pool max_active must be a positive integer.");
    this.idleTtlMs = options.idle_ttl_ms ?? 300_000;
    this.resourceAccounting = options.resource_accounting;
  }

  /** Reuses a live worker for `key` when its descriptor digest matches, or
   * creates (and pools) a fresh one otherwise. Marks the entry on-loan --
   * it is never a target for idle-TTL or LRU eviction until `release(key)`. */
  acquire(key: string, descriptor: TDescriptor, descriptorDigest: string): WorkerTransport {
    if (this.resourceAccounting !== undefined) throw new Error("Analysis worker process-tree RSS accounting requires acquireWithResourceAdmission().");
    return this.acquireUnchecked(key, descriptor, descriptorDigest);
  }

  /** Performs conservative whole-process-tree RSS admission before leasing a
   * worker. On ceiling pressure it terminates idle workers LRU-first, forcing
   * a fresh sample after each victim; an incomplete sample never starts work. */
  async acquireWithResourceAdmission(
    key: string,
    descriptor: TDescriptor,
    descriptorDigest: string,
    request: Omit<ProcessTreeRssAdmissionRequest, "fresh_sample">,
  ): Promise<WorkerTransport> {
    if (this.resourceAccounting === undefined) return this.acquireUnchecked(key, descriptor, descriptorDigest);
    // Worker creation registers a new supervised process immediately after a
    // successful admission. A cached process-table snapshot taken for the
    // previous shard predates that registration and would therefore mark the
    // new component as missing. Every lease boundary needs one fresh sample;
    // host samplers still coalesce genuinely concurrent collection in-flight.
    let decision = await this.resourceAccounting.admit({ ...request, fresh_sample: true });
    while (!decision.admitted && decision.reason === "ceiling_exceeded" && await this.evictOldestIdleForResourcePressure()) {
      decision = await this.resourceAccounting.admit({ ...request, fresh_sample: true });
    }
    if (!decision.admitted || decision.reservation === undefined) {
      throw new Error(`Analysis worker RSS admission exhausted (${decision.reason}): tree=${decision.telemetry.process_tree_rss_bytes} reserved=${decision.telemetry.reserved_rss_bytes} requested=${decision.telemetry.requested_rss_bytes} ceiling=${decision.telemetry.ceiling_rss_bytes}.`);
    }
    try {
      const worker = this.acquireUnchecked(key, descriptor, descriptorDigest);
      const entry = this.entries.get(key);
      if (entry === undefined) throw new Error("Analysis worker disappeared during RSS admission.");
      entry.resource_reservation = decision.reservation;
      return worker;
    } catch (error) {
      decision.reservation.release();
      throw error;
    }
  }

  /** Internal telemetry hook for daemon logging/benchmarks. */
  sampleResourceTelemetry(options: { readonly fresh?: boolean } = {}): Promise<ProcessTreeRssTelemetry | undefined> {
    return this.resourceAccounting?.sampleTelemetry(options) ?? Promise.resolve(undefined);
  }

  /** Reclaims idle workers until a fresh complete sample is at or below the
   * ceiling. In-flight scans are never terminated; incomplete telemetry is
   * returned unchanged so the next admission remains fail-closed. */
  async enforceResourceCeiling(): Promise<ProcessTreeRssTelemetry | undefined> {
    if (this.resourceAccounting === undefined) return undefined;
    let telemetry = await this.resourceAccounting.sampleTelemetry({ fresh: true });
    while (telemetry.complete && telemetry.projected_rss_bytes > telemetry.ceiling_rss_bytes && await this.evictOldestIdleForResourcePressure()) {
      telemetry = await this.resourceAccounting.sampleTelemetry({ fresh: true });
    }
    return telemetry;
  }

  private acquireUnchecked(key: string, descriptor: TDescriptor, descriptorDigest: string): WorkerTransport {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (!workerIsUnusable(existing.worker) && existing.descriptor_digest === descriptorDigest) {
        if (existing.in_use) throw new Error(`Analysis worker admission exhausted for ${key}: worker is already leased.`);
        this.clearIdleTimer(existing);
        existing.in_use = true;
        this.activeLeases += 1;
        // Move to most-recently-used: `Map` iteration order is insertion
        // order, and `enforceCap` below walks entries in that order to pick
        // an LRU eviction victim among idle ones.
        this.entries.delete(key);
        this.entries.set(key, existing);
        return existing.worker;
      }
      // Descriptor changed underneath this key (e.g. a plugin upgrade): the
      // stale worker can never serve a request under the new descriptor
      // correctly, so it is evicted immediately rather than reused.
      this.entries.delete(key);
      this.clearIdleTimer(existing);
      if (existing.in_use) this.activeLeases -= 1;
      void existing.worker.terminate().catch(() => undefined);
    }
    if (this.activeLeases >= this.maxActive) throw new Error(`Analysis worker admission exhausted: ${this.activeLeases}/${this.maxActive} worker leases are active.`);
    const worker = this.create(descriptor);
    this.entries.set(key, { worker, descriptor, descriptor_digest: descriptorDigest, in_use: true, idle_timer: undefined, resource_reservation: undefined });
    this.activeLeases += 1;
    this.enforceCap();
    return worker;
  }

  /** Returns a previously-`acquire`d worker to the pool instead of
   * terminating it, starting its idle-TTL clock and making it eligible for
   * LRU eviction beyond the cap. A no-op for an unknown/already-evicted key
   * (mirrors `await worker.terminate()` being safe to call on an already-
   * terminated transport). */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (!entry.in_use) return;
    entry.in_use = false;
    this.activeLeases -= 1;
    entry.resource_reservation?.release();
    entry.resource_reservation = undefined;
    this.scheduleIdleEviction(key, entry);
    this.enforceCap();
  }

  /** Closes and removes the pooled worker for `key`, if any. Safe to call
   * for a key with no live entry (a no-op). Never throws -- a worker
   * transport's `terminate()` failure must not fail the caller (workspace
   * removal, daemon shutdown) that triggered this eviction. */
  async evict(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.clearIdleTimer(entry);
    if (entry.in_use) this.activeLeases -= 1;
    entry.resource_reservation?.release();
    entry.resource_reservation = undefined;
    await entry.worker.terminate().catch(() => undefined);
  }

  /** Evicts every shard lease belonging to a workspace. */
  async evictWorkspace(workspaceId: string): Promise<void> {
    const keys = [...this.entries.keys()].filter((key) => key === workspaceId || key.startsWith(`${workspaceId}:`));
    await Promise.all(keys.map((key) => this.evict(key)));
  }

  /** Closes every pooled worker (daemon shutdown). Never throws. */
  async closeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((key) => this.evict(key)));
  }

  /** Number of currently-pooled entries (on-loan + idle). Test/introspection only. */
  get size(): number {
    return this.entries.size;
  }

  /** Number of currently leased workers. Test/introspection only. */
  get active(): number {
    return this.activeLeases;
  }

  private scheduleIdleEviction(key: string, entry: PoolEntry<TDescriptor>): void {
    this.clearIdleTimer(entry);
    const timer = setTimeout(() => { void this.evict(key); }, this.idleTtlMs);
    timer.unref?.();
    entry.idle_timer = timer;
  }

  private clearIdleTimer(entry: PoolEntry<TDescriptor>): void {
    if (entry.idle_timer !== undefined) { clearTimeout(entry.idle_timer); entry.idle_timer = undefined; }
  }

  /** Evicts idle (not on-loan) entries, oldest-first by `Map` insertion
   * order, until the live count is back at or under `max_entries` -- or
   * until every remaining entry is on-loan, whichever comes first (the cap
   * is a target, never something that forcibly kills an in-flight scan's
   * worker). */
  private enforceCap(): void {
    while (this.entries.size > this.maxEntries) {
      let victim: string | undefined;
      for (const [key, entry] of this.entries) {
        if (!entry.in_use) { victim = key; break; }
      }
      if (victim === undefined) return;
      void this.evict(victim);
    }
  }

  private async evictOldestIdleForResourcePressure(): Promise<boolean> {
    const victim = [...this.entries].find(([, entry]) => !entry.in_use)?.[0];
    if (victim === undefined) return false;
    await this.evict(victim);
    return true;
  }
}
