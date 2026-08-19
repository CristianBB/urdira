import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonError } from "./errors.js";

export const WORK_POOL_KINDS = ["source", "structural", "semantic", "query"] as const;
export type WorkPoolKind = (typeof WORK_POOL_KINDS)[number];
export interface ProgressEvent { readonly phase: string; readonly completed: number; readonly total?: number; readonly message?: string; }
/** Source access exposed to daemon workers is intentionally read-only. */
export interface ReadOnlySourcePort { readonly enumerate: () => Promise<ReadonlyArray<string>>; readonly read: (artifact_id: string, artifact_version_id: string) => Promise<Uint8Array>; }
export interface ClientQuota { readonly max_in_flight: number; }
export interface SchedulerOptions { readonly pool_concurrency: Readonly<Record<WorkPoolKind, number>>; readonly max_active: number; readonly client_quotas: Readonly<Record<string, ClientQuota>>; readonly default_client_quota?: ClientQuota; readonly restart_lease_ttl_ms?: number; readonly query_reserved_slots?: number; }
export interface SchedulerJobRequest<T> { readonly job_id: string; readonly client_id: string; readonly workspace_id?: string; readonly pool: WorkPoolKind; readonly cost?: number; readonly run: (signal: AbortSignal, reportProgress: (event: ProgressEvent) => void) => Promise<T>; readonly publish?: (value: T) => Promise<void>; }
export interface JobHandle<T> { readonly job_id: string; readonly promise: Promise<T>; readonly progress: ReadonlyArray<ProgressEvent>; readonly cancel: () => void; }
export interface RestartLease { readonly lease_id: string; readonly renew: () => Promise<void>; readonly release: () => Promise<void>; }
export interface PersistedCursorState { readonly scope_digest: string; readonly cursors: ReadonlyArray<string>; readonly expires_at: string; }

interface Entry<T> { request: SchedulerJobRequest<T>; controller: AbortController; progress: ProgressEvent[]; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void; handle: JobHandle<T>; state: "queued" | "running" | "settled"; }

export class DaemonScheduler {
  private readonly queues: Record<WorkPoolKind, Entry<unknown>[]> = { source: [], structural: [], semantic: [], query: [] };
  private readonly poolActive: Record<WorkPoolKind, number> = { source: 0, structural: 0, semantic: 0, query: 0 };
  private readonly clientInFlight = new Map<string, number>();
  private readonly entries = new Set<Entry<unknown>>();
  private readonly publicationTails = new Map<string, Promise<void>>();
  private readonly restartLeases = new Map<string, { released: boolean; expires_at: number }>();
  private sequence = 0;
  private stopping = false;
  private stopWaiters: Array<() => void> = [];
  constructor(private readonly options: SchedulerOptions) {
    if (!Number.isSafeInteger(options.max_active) || options.max_active < 1) throw new DaemonError("core:admission_exhausted", "Global admission must be a positive safe integer.");
    for (const pool of WORK_POOL_KINDS) if (!Number.isSafeInteger(options.pool_concurrency[pool]) || options.pool_concurrency[pool] < 1) throw new DaemonError("core:admission_exhausted", `Pool ${pool} concurrency must be positive.`);
    const reserved = options.query_reserved_slots ?? 1;
    if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved > options.max_active) throw new DaemonError("core:admission_exhausted", "Reserved query capacity must be between zero and max_active.");
  }
  get activeCount(): number { return [...Object.values(this.poolActive)].reduce((sum, value) => sum + value, 0); }
  get restartLeaseCount(): number { this.expireLeases(); return [...this.restartLeases.values()].filter((lease) => !lease.released).length; }
  submit<T>(request: SchedulerJobRequest<T>): JobHandle<T> {
    if (this.stopping) throw new DaemonError("core:daemon_not_running", "Daemon scheduler is stopping.");
    const quota = this.options.client_quotas[request.client_id] ?? this.options.default_client_quota ?? { max_in_flight: 64 };
    const inFlight = this.clientInFlight.get(request.client_id) ?? 0;
    if (quota && inFlight >= quota.max_in_flight) throw new DaemonError("core:quota_exceeded", `Client ${request.client_id} has exhausted its in-flight quota.`);
    if (!WORK_POOL_KINDS.includes(request.pool)) throw new DaemonError("core:admission_exhausted", `Pool ${request.pool} is not registered.`);
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    const progress: ProgressEvent[] = [];
    const controller = new AbortController();
    const entry = {} as Entry<T>;
    const cancel = (): void => {
      if (entry.state === "settled") return;
      controller.abort();
      if (entry.state === "queued") { const queue = this.queues[request.pool] as Entry<T>[]; const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); this.settle(entry, undefined, new DaemonError("core:operation_cancelled", "Scheduled work was cancelled.")); }
    };
    const handle: JobHandle<T> = { job_id: request.job_id, promise, progress, cancel };
    entry.request = request; entry.controller = controller; entry.progress = progress; entry.resolve = resolve; entry.reject = reject; entry.handle = handle; entry.state = "queued";
    this.entries.add(entry as Entry<unknown>); this.queues[request.pool].push(entry as Entry<unknown>); this.clientInFlight.set(request.client_id, inFlight + 1); this.pump();
    return handle;
  }
  async acquireRestartLease(ownerId: string): Promise<RestartLease> {
    if (this.stopping) throw new DaemonError("core:daemon_not_running", "Cannot acquire a restart lease while stopping.");
    const leaseId = `restart-${ownerId}-${this.sequence++}`;
    const state = { released: false, expires_at: Date.now() + (this.options.restart_lease_ttl_ms ?? 60_000) }; this.restartLeases.set(leaseId, state);
    return { lease_id: leaseId, renew: async () => { if (state.released || state.expires_at <= Date.now()) { state.released = true; this.restartLeases.delete(leaseId); throw new DaemonError("core:daemon_restart_required", "Restart lease is expired."); } state.expires_at = Date.now() + (this.options.restart_lease_ttl_ms ?? 60_000); }, release: async () => { if (state.released) return; state.released = true; this.restartLeases.delete(leaseId); this.maybeStopResolved(); } };
  }
  async stop(options: { readonly force?: boolean } = {}): Promise<void> {
    this.stopping = true;
    if (options.force) {
      for (const entry of [...this.entries]) {
        entry.controller.abort();
        if (entry.state === "queued") {
          const queue = this.queues[entry.request.pool]; const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
          this.settle(entry, undefined, new DaemonError("core:operation_cancelled", "Queued work was cancelled during forced shutdown."));
        }
      }
      for (const [leaseId, lease] of this.restartLeases) { lease.released = true; this.restartLeases.delete(leaseId); }
    }
    if (this.entries.size === 0 && this.restartLeaseCount === 0) return;
    await new Promise<void>((resolve) => this.stopWaiters.push(resolve));
  }

  /** True while a query is queued or executing; background maintenance uses
   * this signal to yield at its next document/commit boundary. */
  hasQueryPressure(): boolean {
    return this.queues.query.length > 0 || this.poolActive.query > 0;
  }

  queryPressureSnapshot(): { readonly queued: number; readonly active: number } {
    return { queued: this.queues.query.length, active: this.poolActive.query };
  }
  private pump(): void {
    let started = true;
    while (started && this.activeCount < this.options.max_active) {
      started = false;
      // Queries are foreground work. Drain them before admitting lower
      // priority maintenance, while retaining a reserved global slot so a
      // queued query can always make progress even when semantic work is hot.
      const pools: readonly WorkPoolKind[] = ["query", "source", "structural", "semantic"];
      for (const pool of pools) {
        if (this.activeCount >= this.options.max_active || this.poolActive[pool] >= this.options.pool_concurrency[pool]) continue;
        if (pool !== "query" && this.queues.query.length > 0 && this.activeCount >= this.options.max_active - (this.options.query_reserved_slots ?? 1)) continue;
        const entry = this.queues[pool].shift(); if (!entry) continue;
        entry.state = "running"; this.poolActive[pool]++; started = true; void this.run(entry);
      }
    }
  }
  private async run<T>(entry: Entry<T>): Promise<void> {
    const report = (event: ProgressEvent): void => { if (event.completed < 0 || (event.total !== undefined && event.completed > event.total)) throw new DaemonError("core:execution_failed", "Progress event is outside its declared bounds."); entry.progress.push(event); };
    try {
      const value = await entry.request.run(entry.controller.signal, report);
      if (entry.controller.signal.aborted) throw new DaemonError("core:operation_cancelled", "Scheduled work was cancelled.");
      if (entry.request.publish && entry.request.workspace_id) {
        const previous = this.publicationTails.get(entry.request.workspace_id) ?? Promise.resolve();
        const publication = previous.catch(() => undefined).then(() => entry.request.publish!(value));
        this.publicationTails.set(entry.request.workspace_id, publication);
        await publication;
        if (this.publicationTails.get(entry.request.workspace_id) === publication) this.publicationTails.delete(entry.request.workspace_id);
      } else if (entry.request.publish) await entry.request.publish(value);
      this.settle(entry, value);
    } catch (error) { this.settle(entry, undefined, error); }
    finally { this.poolActive[entry.request.pool]--; this.pump(); this.maybeStopResolved(); }
  }
  private settle<T>(entry: Entry<T>, value?: T, error?: unknown): void {
    if (entry.state === "settled") return; entry.state = "settled"; this.entries.delete(entry as Entry<unknown>);
    const count = this.clientInFlight.get(entry.request.client_id) ?? 1; if (count <= 1) this.clientInFlight.delete(entry.request.client_id); else this.clientInFlight.set(entry.request.client_id, count - 1);
    if (error !== undefined) entry.reject(error); else entry.resolve(value as T);
  }
  private maybeStopResolved(): void { if (this.stopping && this.entries.size === 0 && this.restartLeaseCount === 0) { for (const resolve of this.stopWaiters.splice(0)) resolve(); } }
  private expireLeases(): void { const now = Date.now(); for (const [leaseId, lease] of this.restartLeases) if (!lease.released && lease.expires_at <= now) { lease.released = true; this.restartLeases.delete(leaseId); } }
}

export class PersistentCursorRecovery {
  constructor(private readonly path: string) {}
  async save(executionId: string, state: PersistedCursorState): Promise<void> {
    this.validate(state);
    const values = await this.readAll(); values[executionId] = state; await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(values)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temp, this.path);
  }
  async load(executionId: string): Promise<PersistedCursorState | undefined> { const values = await this.readAll(); const state = values[executionId]; if (!state) return undefined; if (Date.parse(state.expires_at) <= Date.now()) return undefined; return state; }
  async remove(executionId: string): Promise<void> { const values = await this.readAll(); delete values[executionId]; await mkdir(dirname(this.path), { recursive: true }); await writeFile(this.path, `${JSON.stringify(values)}\n`, { encoding: "utf8", mode: 0o600 }); }
  private async readAll(): Promise<Record<string, PersistedCursorState>> { try { const value: unknown = JSON.parse(await readFile(this.path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object"); const entries = Object.entries(value as Record<string, unknown>); const result: Record<string, PersistedCursorState> = {}; for (const [executionId, state] of entries) { if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error(`invalid cursor ${executionId}`); this.validate(state as PersistedCursorState); result[executionId] = state as PersistedCursorState; } return result; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}; throw new DaemonError("core:daemon_recovery_failed", "Persistent cursor recovery state is invalid."); } }
  private validate(state: PersistedCursorState): void { if (typeof state.scope_digest !== "string" || state.scope_digest.length === 0 || !Array.isArray(state.cursors) || !state.cursors.every((cursor) => typeof cursor === "string" && cursor.length > 0) || !Number.isFinite(Date.parse(state.expires_at))) throw new DaemonError("core:daemon_recovery_failed", "Persistent cursor recovery state is invalid."); }
}
