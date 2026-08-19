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
}

interface PoolEntry<TDescriptor> {
  readonly worker: WorkerTransport;
  readonly descriptor: TDescriptor;
  readonly descriptor_digest: string;
  in_use: boolean;
  idle_timer: NodeJS.Timeout | undefined;
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
  private activeLeases = 0;

  constructor(options: AnalysisWorkerPoolOptions<TDescriptor>) {
    this.create = options.create;
    this.maxEntries = options.max_entries ?? 2;
    this.maxActive = options.max_active ?? this.maxEntries;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1) throw new Error("Analysis worker pool max_active must be a positive integer.");
    this.idleTtlMs = options.idle_ttl_ms ?? 300_000;
  }

  /** Reuses a live worker for `key` when its descriptor digest matches, or
   * creates (and pools) a fresh one otherwise. Marks the entry on-loan --
   * it is never a target for idle-TTL or LRU eviction until `release(key)`. */
  acquire(key: string, descriptor: TDescriptor, descriptorDigest: string): WorkerTransport {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.descriptor_digest === descriptorDigest) {
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
    this.entries.set(key, { worker, descriptor, descriptor_digest: descriptorDigest, in_use: true, idle_timer: undefined });
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
}
