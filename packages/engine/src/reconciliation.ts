import { EngineError } from "./errors.js";
import type { WatcherBinding, WatcherEventClass, WatcherHint, WatcherHintBatch } from "./watchers.js";

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface ReconciliationClock {
  now(): number;
  set_timeout(callback: () => void, delayMs: number): TimerHandle;
  clear_timeout(handle: TimerHandle): void;
}

export const SYSTEM_RECONCILIATION_CLOCK: ReconciliationClock = Object.freeze({
  now: () => performance.now(),
  set_timeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clear_timeout: (handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export type ReconciliationKind = "targeted" | "administrative" | "complete";
export type ReconciliationTrigger =
  | "settled_batch"
  | "maximum_batch_window"
  | "absence_barrier"
  | "exclusion_barrier"
  | "watcher_overflow"
  | "provider_reset"
  | "provider_restart"
  | "daemon_recovery"
  | "resume"
  | "explicit_freshness"
  | "unproven_freshness"
  | "periodic"
  | "administrative_change"
  | "source_barrier";

export interface ReconciliationRequest {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly source_provider: string;
  readonly source_provider_version: string;
  readonly ordering_domain: string;
  readonly kind: ReconciliationKind;
  readonly trigger: ReconciliationTrigger;
  readonly hints: readonly WatcherHint[];
  readonly source_barrier: boolean;
  readonly source_epoch: number;
}

export interface ReconciliationResult {
  readonly stable: boolean;
  readonly equivalent: boolean;
  readonly checkpoint_id: string;
  readonly target_state?: unknown;
}

export interface ReconciliationPort {
  reconcile(request: ReconciliationRequest): Promise<ReconciliationResult>;
  commit_reconciliation(commit: ReconciliationCommit): Promise<ReconciliationCommitOutcome>;
  set_source_barrier_state(update: SourceBarrierStateUpdate): Promise<void>;
}

export type ReconciliationCommitOutcome = "committed" | "stale";

export interface ReconciliationCommit {
  readonly request: ReconciliationRequest;
  readonly result: ReconciliationResult;
  readonly current_state?: SourceBarrierStateUpdate;
  readonly is_current: () => boolean;
}

export interface SourceBarrierStateUpdate {
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly state: "stale" | "current" | "degraded";
  readonly prior_snapshot_queryable: true;
  readonly checkpoint_id?: string;
  readonly error_code?: string;
}

export interface SourceBarrierStatus {
  readonly state: "stale" | "current" | "degraded";
  readonly attempts: number;
  readonly pending_hint_count: number;
  readonly error_code?: string;
}

export interface ReconciliationCoordinatorOptions {
  readonly workspace_id: string;
  readonly bindings: readonly WatcherBinding[];
  readonly port: ReconciliationPort;
  readonly clock?: ReconciliationClock;
  readonly quiet_window_ms?: number;
  readonly maximum_batch_ms?: number;
  readonly complete_interval_ms?: number;
  readonly barrier_retry_ms?: number;
  readonly maximum_barrier_attempts?: number;
}

interface BindingState {
  readonly binding: WatcherBinding;
  hints: WatcherHint[];
  first_hint_at: number | undefined;
  quiet_timer: TimerHandle | undefined;
  maximum_timer: TimerHandle | undefined;
  periodic_timer: TimerHandle | undefined;
  barrier_retry_timer: TimerHandle | undefined;
  barrier_open: boolean;
  barrier_state: "stale" | "current" | "degraded";
  barrier_attempts: number;
  barrier_error_code: string | undefined;
  barrier_state_persisted: boolean;
  source_epoch: number;
}

const DEFAULT_QUIET_WINDOW_MS = 50;
const DEFAULT_MAXIMUM_BATCH_MS = 250;
const DEFAULT_COMPLETE_INTERVAL_MS = 10 * 60 * 1_000;
const DEFAULT_BARRIER_RETRY_MS = 50;
const MAX_TIMER_MS = 24 * 60 * 60 * 1_000;

const SOURCE_BARRIER_EVENTS = new Set<WatcherEventClass>([
  "administrative",
  "git_head",
  "git_index",
  "worktree_administration",
  "provider_root_transition",
]);

function checkedDuration(code: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new EngineError(code, "The reconciliation duration is outside its safety bounds.");
  }
  return value;
}

export class ReconciliationCoordinator {
  readonly #workspaceId: string;
  readonly #port: ReconciliationPort;
  readonly #clock: ReconciliationClock;
  readonly #quietWindowMs: number;
  readonly #maximumBatchMs: number;
  readonly #completeIntervalMs: number;
  readonly #barrierRetryMs: number;
  readonly #maximumBarrierAttempts: number;
  readonly #states = new Map<string, BindingState>();
  #tail: Promise<void> = Promise.resolve();
  #queuedError: unknown;
  #closed = false;

  constructor(options: ReconciliationCoordinatorOptions) {
    if (options.workspace_id.length === 0 || options.bindings.length === 0) {
      throw new EngineError("engine:reconciliation_configuration_invalid", "A workspace and at least one provider binding are required.");
    }
    this.#workspaceId = options.workspace_id;
    this.#port = options.port;
    this.#clock = options.clock ?? SYSTEM_RECONCILIATION_CLOCK;
    this.#quietWindowMs = checkedDuration("engine:reconciliation_debounce_invalid", options.quiet_window_ms ?? DEFAULT_QUIET_WINDOW_MS, 60_000);
    this.#maximumBatchMs = checkedDuration("engine:reconciliation_debounce_invalid", options.maximum_batch_ms ?? DEFAULT_MAXIMUM_BATCH_MS, 60_000);
    this.#barrierRetryMs = checkedDuration("engine:reconciliation_retry_invalid", options.barrier_retry_ms ?? DEFAULT_BARRIER_RETRY_MS, 60_000);
    this.#maximumBarrierAttempts = checkedDuration("engine:reconciliation_retry_invalid", options.maximum_barrier_attempts ?? 3, 100);
    if (this.#quietWindowMs > this.#maximumBatchMs) {
      throw new EngineError("engine:reconciliation_debounce_invalid", "The quiet window cannot exceed the maximum batch window.");
    }
    const interval = options.complete_interval_ms ?? DEFAULT_COMPLETE_INTERVAL_MS;
    const mutableWatched = options.bindings.some((binding) => binding.mutable_watched !== false);
    if (interval === 0 && mutableWatched) {
      throw new EngineError("engine:complete_reconciliation_required", "Complete reconciliation cannot be disabled for a mutable watched provider.");
    }
    this.#completeIntervalMs = interval === 0
      ? 0
      : checkedDuration("engine:complete_reconciliation_interval_invalid", interval, MAX_TIMER_MS);
    for (const binding of options.bindings) {
      if (binding.workspace_id !== this.#workspaceId || this.#states.has(binding.source_provider_binding_id)) {
        throw new EngineError("engine:reconciliation_binding_invalid", "Provider bindings must be unique and belong to the coordinator workspace.");
      }
      this.#states.set(binding.source_provider_binding_id, {
        binding,
        hints: [],
        first_hint_at: undefined,
        quiet_timer: undefined,
        maximum_timer: undefined,
        periodic_timer: undefined,
        barrier_retry_timer: undefined,
        barrier_open: false,
        barrier_state: "current",
        barrier_attempts: 0,
        barrier_error_code: undefined,
        barrier_state_persisted: true,
        source_epoch: 0,
      });
    }
    if (this.#completeIntervalMs > 0) {
      for (const state of this.#states.values()) this.#schedulePeriodic(state);
    }
  }

  accept(batch: WatcherHintBatch): void {
    if (this.#closed) throw new EngineError("engine:reconciliation_closed", "The reconciliation coordinator is closed.");
    const state = this.#state(batch.source_provider_binding_id);
    if (batch.workspace_id !== this.#workspaceId || batch.source_provider !== state.binding.source_provider
      || batch.source_provider_version !== state.binding.source_provider_version || batch.ordering_domain !== state.binding.ordering_domain
      || batch.events.some((event) => event.source_provider_binding_id !== batch.source_provider_binding_id
        || event.workspace_id !== batch.workspace_id || event.ordering_domain !== batch.ordering_domain)) {
      throw new EngineError("engine:watcher_binding_mismatch", "The watcher batch does not match its registered provider binding.");
    }
    for (const hint of batch.events) this.#acceptHint(state, hint);
  }

  provider_restarted(bindingId: string): void { this.#completeNow(this.#state(bindingId), "provider_restart", []); }
  recover(bindingId: string): void { this.#completeNow(this.#state(bindingId), "daemon_recovery", []); }
  resume(bindingId: string): void { this.#completeNow(this.#state(bindingId), "resume", []); }
  request_freshness(bindingId: string, targetedStateProvesFreshness: boolean): void {
    const state = this.#state(bindingId);
    if (targetedStateProvesFreshness) this.#queueFlush(state, "targeted", "explicit_freshness", false);
    else this.#completeNow(state, "unproven_freshness", []);
  }

  barrier_open(bindingId: string): boolean { return this.#state(bindingId).barrier_open; }

  barrier_status(bindingId: string): SourceBarrierStatus {
    const state = this.#state(bindingId);
    return {
      state: state.barrier_state,
      attempts: state.barrier_attempts,
      pending_hint_count: state.hints.length,
      ...(state.barrier_error_code === undefined ? {} : { error_code: state.barrier_error_code }),
    };
  }

  async idle(): Promise<void> {
    await this.#tail;
    if (this.#queuedError !== undefined) {
      const error = this.#queuedError;
      this.#queuedError = undefined;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of this.#states.values()) this.#clearAllTimers(state);
  }

  #acceptHint(state: BindingState, hint: WatcherHint): void {
    state.source_epoch += 1;
    if (SOURCE_BARRIER_EVENTS.has(hint.event_class)) {
      state.hints.push(hint);
      this.#clearBatchTimers(state);
      if (!state.barrier_open) {
        state.barrier_open = true;
        state.barrier_state = "stale";
        state.barrier_attempts = 0;
        state.barrier_error_code = undefined;
        state.barrier_state_persisted = false;
        this.#enqueue(() => this.#runSourceBarrier(state));
      } else if (state.barrier_state === "degraded") {
        state.barrier_state = "stale";
        state.barrier_attempts = 0;
        state.barrier_error_code = undefined;
        state.barrier_state_persisted = false;
        this.#enqueue(() => this.#runSourceBarrier(state));
      }
      return;
    }
    if (hint.event_class === "overflow" || hint.event_class === "provider_reset") {
      this.#completeNow(state, hint.event_class === "overflow" ? "watcher_overflow" : "provider_reset", [hint]);
      return;
    }
    if (state.barrier_open) {
      state.hints.push(hint);
      return;
    }
    if (hint.event_class === "absence" || hint.event_class === "exclusion") {
      state.hints.push(hint);
      const trigger = hint.event_class === "absence" ? "absence_barrier" : "exclusion_barrier";
      this.#queueFlush(state, "targeted", trigger, false);
      return;
    }
    state.hints.push(hint);
    this.#scheduleBatch(state);
  }

  #scheduleBatch(state: BindingState): void {
    const now = this.#clock.now();
    if (state.first_hint_at === undefined) {
      state.first_hint_at = now;
      state.maximum_timer = this.#clock.set_timeout(() => {
        state.maximum_timer = undefined;
        this.#queueFlush(state, "targeted", "maximum_batch_window", false);
      }, this.#maximumBatchMs);
    }
    if (state.quiet_timer !== undefined) this.#clock.clear_timeout(state.quiet_timer);
    state.quiet_timer = this.#clock.set_timeout(() => {
      state.quiet_timer = undefined;
      this.#queueFlush(state, "targeted", "settled_batch", false);
    }, this.#quietWindowMs);
  }

  #completeNow(state: BindingState, trigger: ReconciliationTrigger, extraHints: readonly WatcherHint[]): void {
    state.hints.push(...extraHints);
    if (state.barrier_open) {
      state.source_epoch += 1;
      this.#clearBatchTimers(state);
      if (trigger !== "periodic") this.#enqueue(() => this.#runSourceBarrier(state));
      return;
    }
    this.#queueFlush(state, "complete", trigger, false);
  }

  #queueFlush(state: BindingState, kind: ReconciliationKind, trigger: ReconciliationTrigger, sourceBarrier: boolean): void {
    if (kind === "targeted" && state.barrier_open) return;
    const hints = this.#takeHints(state);
    const epoch = state.source_epoch;
    this.#enqueue(() => this.#reconcile(state, kind, trigger, sourceBarrier, hints, epoch));
  }

  #takeHints(state: BindingState): readonly WatcherHint[] {
    const hints = state.hints;
    state.hints = [];
    this.#clearBatchTimers(state);
    return hints;
  }

  async #reconcile(
    state: BindingState,
    kind: ReconciliationKind,
    trigger: ReconciliationTrigger,
    sourceBarrier: boolean,
    hints: readonly WatcherHint[],
    sourceEpoch: number,
  ): Promise<void> {
    if (kind === "targeted" && state.barrier_open) {
      this.#restorePrefix(state, hints);
      return;
    }
    const request = this.#request(state, kind, trigger, hints, sourceBarrier, sourceEpoch);
    try {
      const result = await this.#port.reconcile(request);
      if (kind === "targeted" && state.barrier_open) {
        this.#restorePrefix(state, hints);
        return;
      }
      if (!result.stable) {
        throw new EngineError("engine:reconciliation_unstable", "The provider did not produce a stable reconciliation result.");
      }
      const outcome = await this.#commitStableResult(request, result, () => kind !== "targeted" || !state.barrier_open);
      if (outcome === "stale") this.#restorePrefix(state, hints);
    } catch (error) {
      this.#restorePrefix(state, hints);
      throw error;
    }
  }

  async #runSourceBarrier(state: BindingState): Promise<void> {
    while (state.barrier_open && state.barrier_state !== "degraded" && !this.#closed) {
      if (!state.barrier_state_persisted) {
        try {
          await this.#setBarrierState(state, "stale");
          state.barrier_state_persisted = true;
        } catch (error) {
          await this.#barrierFailed(state, error);
          return;
        }
      }
      const hints = this.#takeHints(state);
      const epoch = state.source_epoch;
      const administrative = this.#request(state, "administrative", "administrative_change", hints, true, epoch);
      const complete = this.#request(state, "complete", "source_barrier", hints, true, epoch);
      let result: ReconciliationResult;
      try {
        await this.#port.reconcile(administrative);
        result = await this.#port.reconcile(complete);
      } catch (error) {
        this.#restorePrefix(state, hints);
        await this.#barrierFailed(state, error);
        return;
      }
      if (!result.stable) {
        this.#restorePrefix(state, hints);
        await this.#barrierFailed(state, new EngineError("engine:source_barrier_unstable", "The provider did not produce a stable source-barrier capture."));
        return;
      }
      if (state.source_epoch !== epoch) {
        this.#restorePrefix(state, hints);
        continue;
      }
      let outcome: ReconciliationCommitOutcome;
      try {
        outcome = await this.#commitStableResult(
          complete,
          result,
          () => state.barrier_open && state.barrier_state === "stale" && state.source_epoch === epoch,
          {
            workspace_id: this.#workspaceId,
            source_provider_binding_id: state.binding.source_provider_binding_id,
            state: "current",
            prior_snapshot_queryable: true,
            checkpoint_id: result.checkpoint_id,
          },
        );
      } catch (error) {
        this.#restorePrefix(state, hints);
        await this.#barrierFailed(state, error);
        return;
      }
      if (outcome === "stale") {
        this.#restorePrefix(state, hints);
        continue;
      }
      if (state.source_epoch !== epoch) {
        state.barrier_state_persisted = false;
        continue;
      }
      state.barrier_open = false;
      state.barrier_state = "current";
      state.barrier_attempts = 0;
      state.barrier_error_code = undefined;
      state.barrier_state_persisted = true;
    }
  }

  async #barrierFailed(state: BindingState, _cause: unknown): Promise<void> {
    state.barrier_attempts += 1;
    if (state.barrier_attempts >= this.#maximumBarrierAttempts) {
      state.barrier_state = "degraded";
      state.barrier_error_code = "engine:source_barrier_reconciliation_failed";
      try {
        await this.#setBarrierState(state, "degraded", undefined, state.barrier_error_code);
        state.barrier_state_persisted = true;
      } catch {
        state.barrier_error_code = "engine:source_barrier_state_write_failed";
        state.barrier_state_persisted = false;
      }
      return;
    }
    state.barrier_retry_timer = this.#clock.set_timeout(() => {
      state.barrier_retry_timer = undefined;
      this.#enqueue(() => this.#runSourceBarrier(state));
    }, this.#barrierRetryMs);
  }

  async #commitStableResult(
    request: ReconciliationRequest,
    result: ReconciliationResult,
    isCurrent: () => boolean,
    currentState?: SourceBarrierStateUpdate,
  ): Promise<ReconciliationCommitOutcome> {
    if (!result.equivalent) {
      if (!("target_state" in result)) {
        throw new EngineError("engine:reconciliation_target_state_required", "A changed stable reconciliation must provide one target state.");
      }
    }
    return this.#port.commit_reconciliation({
      request,
      result,
      ...(currentState === undefined ? {} : { current_state: currentState }),
      is_current: isCurrent,
    });
  }

  #request(
    state: BindingState,
    kind: ReconciliationKind,
    trigger: ReconciliationTrigger,
    hints: readonly WatcherHint[],
    sourceBarrier: boolean,
    sourceEpoch: number,
  ): ReconciliationRequest {
    return {
      workspace_id: this.#workspaceId,
      source_provider_binding_id: state.binding.source_provider_binding_id,
      source_provider: state.binding.source_provider,
      source_provider_version: state.binding.source_provider_version,
      ordering_domain: state.binding.ordering_domain,
      kind,
      trigger,
      hints,
      source_barrier: sourceBarrier,
      source_epoch: sourceEpoch,
    };
  }

  #restorePrefix(state: BindingState, hints: readonly WatcherHint[]): void {
    if (hints.length > 0) state.hints = [...hints, ...state.hints];
  }

  async #setBarrierState(
    state: BindingState,
    barrierState: "stale" | "current" | "degraded",
    checkpointId?: string,
    errorCode?: string,
  ): Promise<void> {
    await this.#port.set_source_barrier_state({
      workspace_id: this.#workspaceId,
      source_provider_binding_id: state.binding.source_provider_binding_id,
      state: barrierState,
      prior_snapshot_queryable: true,
      ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    });
  }

  #schedulePeriodic(state: BindingState): void {
    state.periodic_timer = this.#clock.set_timeout(() => {
      state.periodic_timer = undefined;
      if (this.#closed) return;
      this.#completeNow(state, "periodic", []);
      this.#schedulePeriodic(state);
    }, this.#completeIntervalMs);
  }

  #clearBatchTimers(state: BindingState): void {
    if (state.quiet_timer !== undefined) this.#clock.clear_timeout(state.quiet_timer);
    if (state.maximum_timer !== undefined) this.#clock.clear_timeout(state.maximum_timer);
    state.quiet_timer = undefined;
    state.maximum_timer = undefined;
    state.first_hint_at = undefined;
  }

  #clearAllTimers(state: BindingState): void {
    this.#clearBatchTimers(state);
    if (state.periodic_timer !== undefined) this.#clock.clear_timeout(state.periodic_timer);
    if (state.barrier_retry_timer !== undefined) this.#clock.clear_timeout(state.barrier_retry_timer);
    state.periodic_timer = undefined;
    state.barrier_retry_timer = undefined;
  }

  #enqueue(operation: () => Promise<void>): void {
    const running = this.#tail.then(operation);
    this.#tail = running.catch((error: unknown) => { this.#queuedError = error; });
  }

  #state(bindingId: string): BindingState {
    const state = this.#states.get(bindingId);
    if (!state) throw new EngineError("engine:reconciliation_binding_unknown", `Provider binding ${bindingId} is not registered.`);
    return state;
  }
}

export interface FreshnessTargetWatermark {
  readonly source_provider_binding_id: string;
  readonly ordering_domain: string;
  readonly watermark: string;
  readonly required_successor_watermark?: string;
}

export interface FreshnessWorkspaceTarget {
  readonly workspace_id: string;
  readonly watermarks: readonly FreshnessTargetWatermark[];
}

export interface FreshnessCheckpointWatermark {
  readonly source_provider_binding_id: string;
  readonly ordering_domain: string;
  readonly watermark: string;
  readonly represents_watermarks?: readonly string[];
}

export interface FreshnessCheckpoint {
  readonly workspace_id: string;
  readonly freshness_checkpoint_id: string;
  readonly verification_status: "equivalent" | "changes_pending" | "degraded";
  readonly watermarks: readonly FreshnessCheckpointWatermark[];
}

export interface FreshnessSnapshotBinding {
  readonly workspace_id: string;
  readonly snapshot_id: string;
  readonly freshness_checkpoint_id: string;
  readonly retention_lease_id: string;
}

export interface FreshnessBindingRequest {
  readonly workspace_id: string;
  readonly target: FreshnessWorkspaceTarget;
  readonly freshness_checkpoint_id: string;
}

export interface FreshnessOperationContext {
  readonly request_id: string;
  readonly deadline_ms: number;
  readonly is_cancelled: () => boolean;
}

export interface FreshnessBarrierPort {
  validate_workspaces(workspaceIds: readonly string[], context: FreshnessOperationContext): Promise<void>;
  capture_targets(workspaceIds: readonly string[], context: FreshnessOperationContext): Promise<readonly FreshnessWorkspaceTarget[]>;
  equivalent_checkpoint(workspaceId: string, context: FreshnessOperationContext): Promise<FreshnessCheckpoint | undefined>;
  acquire_bindings_atomically(requests: readonly FreshnessBindingRequest[], context: FreshnessOperationContext): Promise<readonly FreshnessSnapshotBinding[]>;
  release_bindings(bindings: readonly FreshnessSnapshotBinding[], context: FreshnessOperationContext): Promise<void>;
}

export interface FreshnessBarrierOptions {
  readonly port: FreshnessBarrierPort;
  readonly clock?: ReconciliationClock;
  readonly default_timeout_ms?: number;
  readonly maximum_timeout_ms?: number;
}

interface FreshnessOperation {
  readonly id: number;
  readonly timeout_ms: number;
  readonly context: FreshnessOperationContext;
  readonly resolve: (bindings: readonly FreshnessSnapshotBinding[]) => void;
  readonly reject: (error: unknown) => void;
  timeout: TimerHandle | undefined;
  targets: readonly FreshnessWorkspaceTarget[] | undefined;
  evaluating: Promise<void> | undefined;
  cancelled: boolean;
  settled: boolean;
}

const DEFAULT_FRESHNESS_TIMEOUT_MS = 5_000;
const MAXIMUM_FRESHNESS_TIMEOUT_MS = 60_000;

export class FreshnessBarrier {
  readonly #port: FreshnessBarrierPort;
  readonly #clock: ReconciliationClock;
  readonly #defaultTimeoutMs: number;
  readonly #maximumTimeoutMs: number;
  readonly #operations = new Map<number, FreshnessOperation>();
  readonly #setups = new Set<Promise<void>>();
  #nextId = 0;

  constructor(options: FreshnessBarrierOptions) {
    this.#port = options.port;
    this.#clock = options.clock ?? SYSTEM_RECONCILIATION_CLOCK;
    this.#maximumTimeoutMs = options.maximum_timeout_ms ?? MAXIMUM_FRESHNESS_TIMEOUT_MS;
    this.#defaultTimeoutMs = options.default_timeout_ms ?? DEFAULT_FRESHNESS_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#maximumTimeoutMs) || this.#maximumTimeoutMs <= 0 || this.#maximumTimeoutMs > MAXIMUM_FRESHNESS_TIMEOUT_MS
      || !Number.isSafeInteger(this.#defaultTimeoutMs) || this.#defaultTimeoutMs < 0 || this.#defaultTimeoutMs > this.#maximumTimeoutMs) {
      throw new EngineError("engine:freshness_timeout_invalid", "Freshness timeout policy is outside its safety bounds.");
    }
  }

  wait_for_current(workspaceIds: readonly string[], options: { readonly timeout_ms?: number } = {}): Promise<readonly FreshnessSnapshotBinding[]> {
    const timeout = options.timeout_ms ?? this.#defaultTimeoutMs;
    let resolveResult: (bindings: readonly FreshnessSnapshotBinding[]) => void = () => undefined;
    let rejectResult: (error: unknown) => void = () => undefined;
    const result = new Promise<readonly FreshnessSnapshotBinding[]>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const id = ++this.#nextId;
    const operation: FreshnessOperation = {
      id,
      timeout_ms: timeout,
      context: {
        request_id: `freshness:${id}`,
        deadline_ms: this.#clock.now() + Math.max(0, timeout),
        is_cancelled: () => operation.cancelled,
      },
      resolve: resolveResult,
      reject: rejectResult,
      timeout: undefined,
      targets: undefined,
      evaluating: undefined,
      cancelled: false,
      settled: false,
    };
    this.#operations.set(id, operation);
    if (Number.isSafeInteger(timeout) && timeout > 0 && timeout <= this.#maximumTimeoutMs) {
      operation.timeout = this.#clock.set_timeout(() => this.#expire(operation), timeout);
    }
    const setup = this.#setup(workspaceIds, operation)
      .catch((error: unknown) => this.#reject(operation, error))
      .finally(() => { this.#setups.delete(setup); });
    this.#setups.add(setup);
    return result;
  }

  async check(): Promise<void> {
    await Promise.all([...this.#setups]);
    await Promise.all([...this.#operations.values()].map((operation) => this.#evaluate(operation)));
  }

  async #setup(
    workspaceIds: readonly string[],
    operation: FreshnessOperation,
  ): Promise<void> {
    const timeout = operation.timeout_ms;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > this.#maximumTimeoutMs) {
      throw new EngineError("engine:freshness_timeout_invalid", `Freshness timeout must be between zero and ${this.#maximumTimeoutMs} milliseconds.`);
    }
    if (workspaceIds.length === 0 || new Set(workspaceIds).size !== workspaceIds.length || workspaceIds.some((id) => id.length === 0)) {
      throw new EngineError("engine:freshness_scope_invalid", "Freshness scope must contain unique workspace identifiers.");
    }
    await this.#port.validate_workspaces(workspaceIds, operation.context);
    if (operation.cancelled) return;
    const targets = await this.#port.capture_targets([...workspaceIds], operation.context);
    if (operation.cancelled) return;
    this.#validateTargets(workspaceIds, targets);
    operation.targets = targets;
    const immediate = await this.#tryAcquire(operation);
    if (immediate !== undefined) {
      this.#resolve(operation, immediate);
      return;
    }
    if (timeout === 0) {
      this.#expire(operation);
    }
  }

  async #evaluate(operation: FreshnessOperation): Promise<void> {
    if (operation.cancelled || operation.settled || operation.targets === undefined) return;
    if (operation.evaluating !== undefined) return operation.evaluating;
    const evaluating = (async () => {
      try {
        const bindings = await this.#tryAcquire(operation);
        if (bindings !== undefined) this.#resolve(operation, bindings);
      } catch (error) {
        this.#reject(operation, error);
      }
    })();
    operation.evaluating = evaluating;
    await evaluating;
    operation.evaluating = undefined;
  }

  async #tryAcquire(operation: FreshnessOperation): Promise<readonly FreshnessSnapshotBinding[] | undefined> {
    const targets = operation.targets;
    if (targets === undefined || operation.cancelled) return undefined;
    const checkpoints = await Promise.all(targets.map((target) => this.#port.equivalent_checkpoint(target.workspace_id, operation.context)));
    if (operation.cancelled) return undefined;
    if (checkpoints.some((checkpoint, index) => checkpoint === undefined || !this.#covers(targets[index]!, checkpoint))) return undefined;
    const requests = targets.map((target, index) => ({
      workspace_id: target.workspace_id,
      target,
      freshness_checkpoint_id: checkpoints[index]!.freshness_checkpoint_id,
    }));
    const bindings = await this.#port.acquire_bindings_atomically(requests, operation.context);
    if (operation.cancelled) {
      if (bindings.length > 0) await this.#port.release_bindings(bindings, operation.context);
      return undefined;
    }
    const expected = new Map(requests.map((request) => [request.workspace_id, request.freshness_checkpoint_id]));
    if (bindings.length !== requests.length || new Set(bindings.map((binding) => binding.workspace_id)).size !== bindings.length
      || bindings.some((binding) => expected.get(binding.workspace_id) !== binding.freshness_checkpoint_id
        || binding.snapshot_id.length === 0 || binding.retention_lease_id.length === 0)) {
      if (bindings.length > 0) await this.#port.release_bindings(bindings, operation.context);
      throw new EngineError("engine:freshness_atomic_binding_failed", "The snapshot binding port returned a partial or inconsistent multi-workspace result.");
    }
    return requests.map((request) => bindings.find((binding) => binding.workspace_id === request.workspace_id)!);
  }

  #resolve(operation: FreshnessOperation, bindings: readonly FreshnessSnapshotBinding[]): void {
    if (operation.settled || operation.cancelled) return;
    operation.settled = true;
    this.#operations.delete(operation.id);
    if (operation.timeout !== undefined) this.#clock.clear_timeout(operation.timeout);
    operation.resolve(bindings);
  }

  #reject(operation: FreshnessOperation, error: unknown): void {
    if (operation.settled) return;
    operation.cancelled = true;
    operation.settled = true;
    this.#operations.delete(operation.id);
    if (operation.timeout !== undefined) this.#clock.clear_timeout(operation.timeout);
    operation.reject(error);
  }

  #expire(operation: FreshnessOperation): void {
    this.#reject(operation, new EngineError("core:freshness_wait_timeout", `Freshness barrier timed out after ${operation.timeout_ms} milliseconds.`));
  }

  #covers(target: FreshnessWorkspaceTarget, checkpoint: FreshnessCheckpoint): boolean {
    if (checkpoint.workspace_id !== target.workspace_id || checkpoint.verification_status !== "equivalent") return false;
    return target.watermarks.every((watermark) => {
      const required = watermark.required_successor_watermark ?? watermark.watermark;
      return checkpoint.watermarks.some((covered) => covered.source_provider_binding_id === watermark.source_provider_binding_id
        && covered.ordering_domain === watermark.ordering_domain
        && (covered.watermark === required || covered.represents_watermarks?.includes(required) === true));
    });
  }

  #validateTargets(workspaceIds: readonly string[], targets: readonly FreshnessWorkspaceTarget[]): void {
    const expected = new Set(workspaceIds);
    if (targets.length !== expected.size || new Set(targets.map((target) => target.workspace_id)).size !== targets.length
      || targets.some((target) => !expected.has(target.workspace_id) || target.watermarks.length === 0
        || target.watermarks.some((watermark) => watermark.source_provider_binding_id.length === 0
          || watermark.ordering_domain.length === 0 || watermark.watermark.length === 0))) {
      throw new EngineError("engine:freshness_target_capture_invalid", "Freshness targets must cover every requested workspace exactly once.");
    }
  }
}
