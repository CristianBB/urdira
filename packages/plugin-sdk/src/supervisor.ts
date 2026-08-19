import { canonicalSha256, hasExactKeys } from "./canonical.js";
import { PluginSdkError } from "./errors.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";
import {
  ClosedWorkerProtocol,
  type PluginWorkerRequestEnvelope,
  type PluginWorkerResponseEnvelope,
  type WorkerKey,
  type WorkerPayloadValidator,
  type WorkerRetryMode,
} from "./protocol.js";

export interface RestrictedWorkerLaunch {
  readonly worker_key: WorkerKey;
}

export interface WorkerTransport {
  invoke(request: PluginWorkerRequestEnvelope): Promise<unknown>;
  cancel(input: { readonly cancellation_id: string }): Promise<void>;
  reset(): Promise<unknown>;
  terminate(): Promise<void>;
}

export interface WorkerSandboxPort {
  launch(input: RestrictedWorkerLaunch): Promise<WorkerTransport>;
}

export interface WorkerTimerHandle { cancel(): void; }
export interface WorkerClock { now(): number; }
export interface WorkerTimer { set(delay_ms: number, callback: () => void): WorkerTimerHandle; }

export interface WorkerResourceBudget {
  readonly deadline_at_ms: number;
  readonly max_memory_bytes: number;
  readonly max_output_bytes: number;
  readonly max_records: number;
  readonly max_dependencies: number;
  readonly max_context_operations: number;
  readonly max_context_bytes: number;
  readonly max_recursion_depth: number;
}

export interface WorkerExecutionMetrics {
  readonly memory_bytes: number;
  readonly output_bytes: number;
  readonly records: number;
  readonly dependencies: number;
  readonly context_operations: number;
  readonly context_bytes: number;
  readonly recursion_depth: number;
}

export interface WorkerTransportResult {
  readonly response: unknown;
  readonly metrics: WorkerExecutionMetrics;
}

export interface QuarantineScope {
  readonly workspace_id: string;
  readonly package_digest: string;
  readonly runtime_contract_version: number;
  readonly executable_build_digest: string;
}

export interface QuarantineRecord {
  readonly crash_times_ms: readonly number[];
  readonly quarantine_until_ms?: number;
}

export interface QuarantinePolicy {
  evaluate(crash_times_ms: readonly number[], now_ms: number): QuarantineRecord;
}

export interface QuarantineStore {
  load(scope: QuarantineScope): Promise<QuarantineRecord | undefined>;
  record_crash(scope: QuarantineScope, now_ms: number, policy: QuarantinePolicy): Promise<QuarantineRecord>;
}

export interface PrivateFailureSink {
  capture(input: { readonly summary: string }): Promise<string>;
}

export interface WorkerRequestIdentityClaim {
  readonly request_id: string;
  readonly identity_digest: string;
  readonly retry: WorkerRetryMode;
}

export interface WorkerRequestIdentityPort {
  claim(input: WorkerRequestIdentityClaim): Promise<"accepted" | "conflict">;
}

export interface WorkerPoolPolicy {
  readonly max_pooled_workers: number;
  readonly max_worker_keys: number;
  readonly max_workers_per_key: number;
}

export interface SupervisedExecutionInput {
  readonly request_envelope: unknown;
  readonly workspace_id: string;
  readonly worker_key: WorkerKey;
  readonly retry: WorkerRetryMode;
  readonly cancellation_signal: AbortSignal;
  readonly budget: WorkerResourceBudget;
  readonly max_response_bytes: number;
}

export type WorkerResourceDimension = "deadline" | "memory_bytes" | "output_bytes" | "records" | "dependencies" | "context_operations" | "context_bytes" | "recursion_depth";

export type SupervisedExecutionResult =
  | { readonly accepted: true; readonly response: PluginWorkerResponseEnvelope }
  | {
    readonly accepted: false;
    readonly code: "plugin-sdk:cancelled" | "plugin-sdk:worker_protocol_invalid" | "plugin-sdk:request_identity_conflict" | "plugin-sdk:worker_lost" | "plugin-sdk:worker_quarantined" | "plugin-sdk:worker_resource_exhausted" | "plugin-sdk:worker_failed" | "plugin-sdk:sandbox_unsupported";
    readonly resource?: WorkerResourceDimension;
    readonly failure_id?: string;
  };

export interface SupervisedPluginRuntimeDependencies {
  readonly sandbox: WorkerSandboxPort;
  readonly payload_validator: WorkerPayloadValidator;
  readonly clock: WorkerClock;
  readonly timer: WorkerTimer;
  readonly quarantine_policy: QuarantinePolicy;
  readonly quarantine_store: QuarantineStore;
  readonly private_failure_sink: PrivateFailureSink;
  readonly request_identity_port: WorkerRequestIdentityPort;
  readonly worker_pool_policy: WorkerPoolPolicy;
  readonly protocol_materialization_limits: PortMaterializationLimits;
  readonly metadata_materialization_limits: PortMaterializationLimits;
}

export class WorkerProcessCrash extends Error {
  constructor(message = "Worker process crashed.") {
    super(message);
    this.name = "WorkerProcessCrash";
  }
}

const BUDGET_TO_METRIC = [
  ["max_memory_bytes", "memory_bytes"],
  ["max_output_bytes", "output_bytes"],
  ["max_records", "records"],
  ["max_dependencies", "dependencies"],
  ["max_context_operations", "context_operations"],
  ["max_context_bytes", "context_bytes"],
  ["max_recursion_depth", "recursion_depth"],
] as const;
const BUDGET_KEYS = [
  "deadline_at_ms",
  "max_memory_bytes",
  "max_output_bytes",
  "max_records",
  "max_dependencies",
  "max_context_operations",
  "max_context_bytes",
  "max_recursion_depth",
] as const;
const METRIC_KEYS = ["memory_bytes", "output_bytes", "records", "dependencies", "context_operations", "context_bytes", "recursion_depth"] as const;

function validatePoolPolicy(value: unknown): value is WorkerPoolPolicy {
  return hasExactKeys(value, ["max_pooled_workers", "max_worker_keys", "max_workers_per_key"])
    && Number.isSafeInteger(value["max_pooled_workers"])
    && (value["max_pooled_workers"] as number) >= 0
    && Number.isSafeInteger(value["max_worker_keys"])
    && (value["max_worker_keys"] as number) > 0
    && Number.isSafeInteger(value["max_workers_per_key"])
    && (value["max_workers_per_key"] as number) > 0;
}

function validateMaterializationLimits(value: PortMaterializationLimits | undefined): value is PortMaterializationLimits {
  try {
    materializePortResult(null, value);
    return true;
  } catch {
    return false;
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\r\n\t\0]/u.test(value);
}

function validateWorkerKey(value: unknown): WorkerKey | undefined {
  if (!hasExactKeys(value, ["package_digest", "runtime_contract_version", "executable_build_digest"])
    || !isNonemptyString(value["package_digest"])
    || !Number.isSafeInteger(value["runtime_contract_version"])
    || (value["runtime_contract_version"] as number) <= 0
    || !isNonemptyString(value["executable_build_digest"])) return undefined;
  return value as unknown as WorkerKey;
}

function validateMetrics(value: unknown): WorkerExecutionMetrics | undefined {
  if (!hasExactKeys(value, METRIC_KEYS)) return undefined;
  for (const key of METRIC_KEYS) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) return undefined;
  }
  return value as unknown as WorkerExecutionMetrics;
}

function workerKeyId(key: WorkerKey): string {
  return `${key.package_digest}\u0000${key.runtime_contract_version}\u0000${key.executable_build_digest}`;
}

function sameKey(left: WorkerKey, right: WorkerKey): boolean {
  return workerKeyId(left) === workerKeyId(right);
}

function scopeFor(workspaceId: string, workerKey: WorkerKey): QuarantineScope {
  return {
    workspace_id: workspaceId,
    package_digest: workerKey.package_digest,
    runtime_contract_version: workerKey.runtime_contract_version,
    executable_build_digest: workerKey.executable_build_digest,
  };
}

function validateBudget(value: unknown, maxResponseBytes: unknown): WorkerResourceBudget | undefined {
  if (!Number.isSafeInteger(maxResponseBytes) || (maxResponseBytes as number) <= 0 || !hasExactKeys(value, BUDGET_KEYS)) return undefined;
  for (const key of BUDGET_KEYS) {
    const item = value[key];
    const mayBeZero = key === "max_context_operations" || key === "max_context_bytes";
    if (!Number.isSafeInteger(item) || (item as number) < (mayBeZero ? 0 : 1)) return undefined;
  }
  return value as unknown as WorkerResourceBudget;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function responseMaterializationLimits(
  frameLimit: number,
  budget: WorkerResourceBudget,
): PortMaterializationLimits {
  return Object.freeze({
    max_items: frameLimit,
    max_depth: budget.max_recursion_depth > Number.MAX_SAFE_INTEGER - 4
      ? Number.MAX_SAFE_INTEGER
      : budget.max_recursion_depth + 4,
    max_nodes: frameLimit,
    max_bytes: frameLimit,
  });
}

function decodeResponse(
  foreignValue: unknown,
  frameLimit: number,
  outputLimit: number,
  budget: WorkerResourceBudget,
): { readonly value?: unknown; readonly resource?: "output_bytes"; readonly invalid?: true } {
  let value: unknown;
  let serialized: string;
  if (typeof foreignValue === "string") {
    serialized = foreignValue;
  } else {
    try {
      value = materializePortResult(foreignValue, responseMaterializationLimits(frameLimit, budget));
      serialized = JSON.stringify(value);
    } catch {
      return { invalid: true };
    }
    if (serialized === undefined) return { invalid: true };
  }
  const size = byteLength(serialized);
  if (size > frameLimit) return { invalid: true };
  if (size > outputLimit) return { resource: "output_bytes" };
  if (typeof foreignValue !== "string") return { value };
  try {
    return { value: JSON.parse(foreignValue) as unknown };
  } catch {
    return { invalid: true };
  }
}

const SAFE_PRIVATE_FAILURE_SUMMARY = "Worker transport failure.";

function safePrivateSummary(error: unknown): string {
  try {
    if (!(error instanceof Error)) return SAFE_PRIVATE_FAILURE_SUMMARY;
    const name = error.name;
    const message = error.message;
    if (typeof name !== "string" || typeof message !== "string") return SAFE_PRIVATE_FAILURE_SUMMARY;
    return `${name}: ${message}`.replace(/[\0\r\n\t]/gu, " ").slice(0, 2_048);
  } catch {
    return SAFE_PRIVATE_FAILURE_SUMMARY;
  }
}

function safeFailureId(candidate: string, summary: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(candidate)
    ? candidate
    : `failure-${canonicalSha256(summary).slice(7, 31)}`;
}

function validateQuarantineRecord(value: unknown): QuarantineRecord | undefined {
  if (!hasExactKeys(value, ["crash_times_ms"], ["quarantine_until_ms"])
    || !Array.isArray(value["crash_times_ms"])
    || value["crash_times_ms"].some((time) => !Number.isSafeInteger(time) || time < 0)
    || (value["quarantine_until_ms"] !== undefined
      && (!Number.isSafeInteger(value["quarantine_until_ms"]) || (value["quarantine_until_ms"] as number) < 0))) return undefined;
  return value as unknown as QuarantineRecord;
}

type ControlReason = "cancelled" | "deadline";
type PhaseResult<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "control"; readonly reason: ControlReason };

class ExecutionControl {
  readonly #promise: Promise<ControlReason>;
  readonly #onAbort: () => void;
  readonly #timer: WorkerTimerHandle;
  #settle!: (reason: ControlReason) => void;
  #reason: ControlReason | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly deadline_at_ms: number,
    private readonly clock: WorkerClock,
    timer: WorkerTimer,
    private readonly on_control: () => void,
  ) {
    this.#promise = new Promise<ControlReason>((resolve) => { this.#settle = resolve; });
    this.#onAbort = () => { this.#trigger("cancelled"); };
    signal.addEventListener("abort", this.#onAbort, { once: true });
    this.#timer = timer.set(Math.max(0, deadline_at_ms - clock.now()), () => { this.#trigger("deadline"); });
    this.check();
  }

  get reason(): ControlReason | undefined { return this.#reason; }

  check(): ControlReason | undefined {
    if (this.signal.aborted) this.#trigger("cancelled");
    else if (this.clock.now() >= this.deadline_at_ms) this.#trigger("deadline");
    return this.#reason;
  }

  async race<T>(operation: () => Promise<T> | T): Promise<PhaseResult<T>> {
    const before = this.check();
    if (before !== undefined) return { kind: "control", reason: before };
    let phase: Promise<T>;
    try {
      phase = Promise.resolve(operation());
    } catch (error) {
      return { kind: "error", error };
    }
    const winner = await Promise.race<PhaseResult<T>>([
      phase.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      this.#promise.then((reason) => ({ kind: "control" as const, reason })),
    ]);
    if (winner.kind !== "control") {
      const after = this.check();
      if (after !== undefined) return { kind: "control", reason: after };
    }
    return winner;
  }

  close(): void {
    this.signal.removeEventListener("abort", this.#onAbort);
    this.#timer.cancel();
  }

  #trigger(reason: ControlReason): void {
    if (this.#reason !== undefined) return;
    this.#reason = reason;
    this.on_control();
    this.#settle(reason);
  }
}

interface WorkerLease {
  readonly transport: WorkerTransport;
  readonly generation: number;
  terminated: boolean;
}

class WorkerDrainedError extends Error {}

export class SupervisedPluginRuntime {
  readonly #protocol: ClosedWorkerProtocol;
  readonly #pool = new Map<string, WorkerLease[]>();
  readonly #pooledOrder: { readonly poolKey: string; readonly lease: WorkerLease }[] = [];
  readonly #active = new Map<string, Set<WorkerLease>>();
  readonly #generation = new Map<string, number>();
  readonly #inflight = new Map<string, number>();
  readonly #keyOrder = new Map<string, true>();

  constructor(private readonly dependencies: SupervisedPluginRuntimeDependencies) {
    if (dependencies.request_identity_port === undefined
      || typeof dependencies.request_identity_port.claim !== "function"
      || !validatePoolPolicy(dependencies.worker_pool_policy)
      || !validateMaterializationLimits(dependencies.protocol_materialization_limits)
      || !validateMaterializationLimits(dependencies.metadata_materialization_limits)) {
      throw new PluginSdkError("plugin-sdk:worker_protocol_invalid", "Worker runtime authorities are invalid.");
    }
    this.#protocol = new ClosedWorkerProtocol(
      dependencies.payload_validator,
      dependencies.protocol_materialization_limits,
    );
  }

  bookkeeping(): { readonly worker_key_states: number; readonly pooled_workers: number } {
    return Object.freeze({
      worker_key_states: this.#keyOrder.size,
      pooled_workers: this.#pooledOrder.length,
    });
  }

  async execute(input: SupervisedExecutionInput): Promise<SupervisedExecutionResult> {
    let request: PluginWorkerRequestEnvelope;
    try {
      request = this.#protocol.accept_call(input.request_envelope);
    } catch (error) {
      return this.#protocolFailure(error);
    }
    const budget = validateBudget(input.budget, input.max_response_bytes);
    const workerKey = validateWorkerKey(input.worker_key);
    const deadlineAtMs = Date.parse(request.deadline);
    if (budget === undefined
      || workerKey === undefined
      || !isNonemptyString(input.workspace_id)
      || (input.retry !== "new" && input.retry !== "retry_same")
      || request.protocol_version !== String(workerKey.runtime_contract_version)
      || deadlineAtMs !== budget.deadline_at_ms) {
      return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
    }
    const poolKey = workerKeyId(workerKey);
    let lease: WorkerLease | undefined;
    let reserved = false;
    let cancellationSent = false;
    const sendCancel = (): void => {
      if (lease === undefined || cancellationSent) return;
      cancellationSent = true;
      try {
        void Promise.resolve(lease.transport.cancel({ cancellation_id: request.cancellation_id })).catch(() => undefined);
      } catch {
        // Cooperative cancellation is best effort; termination remains authoritative.
      }
    };
    const control = new ExecutionControl(
      input.cancellation_signal,
      budget.deadline_at_ms,
      this.dependencies.clock,
      this.dependencies.timer,
      sendCancel,
    );

    try {
      const initialControl = control.check();
      if (initialControl !== undefined) return this.#controlResult(initialControl);
      if (!this.#reserveExecution(poolKey)) {
        return { accepted: false, code: "plugin-sdk:worker_resource_exhausted" };
      }
      reserved = true;
      const generation = this.#generation.get(poolKey) ?? 0;

      const claimed = await control.race(async () => this.dependencies.request_identity_port.claim(Object.freeze({
        request_id: request.request_id,
        identity_digest: canonicalSha256({
          request_digest: request.request_digest,
          workspace_id: input.workspace_id,
          worker_key: workerKey,
        }),
        retry: input.retry,
      })));
      if (claimed.kind === "control") return this.#controlResult(claimed.reason);
      if (claimed.kind === "error") return await this.#safeFailure(control, "plugin-sdk:worker_failed", claimed.error);
      if (claimed.value === "conflict") return { accepted: false, code: "plugin-sdk:request_identity_conflict" };
      if (claimed.value !== "accepted") {
        return await this.#safeFailure(control, "plugin-sdk:worker_failed", new Error("Invalid request identity authority result."));
      }

      const scope = scopeFor(input.workspace_id, workerKey);
      const loaded = await control.race(async () => {
        const value = await this.dependencies.quarantine_store.load(scope);
        return value === undefined ? undefined : materializePortResult(value, this.dependencies.metadata_materialization_limits);
      });
      if (loaded.kind === "control") return this.#controlResult(loaded.reason);
      if (loaded.kind === "error") return await this.#safeFailure(control, "plugin-sdk:worker_failed", loaded.error);
      const quarantine = loaded.value === undefined ? undefined : validateQuarantineRecord(loaded.value);
      if (loaded.value !== undefined && quarantine === undefined) {
        return await this.#safeFailure(control, "plugin-sdk:worker_failed", new Error("Invalid quarantine record."));
      }
      if (quarantine?.quarantine_until_ms !== undefined && quarantine.quarantine_until_ms > this.dependencies.clock.now()) {
        return { accepted: false, code: "plugin-sdk:worker_quarantined" };
      }

      const acquirePromise = this.#acquire(poolKey, { worker_key: workerKey }, generation);
      const acquired = await control.race(async () => acquirePromise);
      if (acquired.kind === "control") {
        void acquirePromise.then(
          (lateLease) => {
            lease = lateLease;
            sendCancel();
            this.#discard(poolKey, lateLease);
          },
          () => undefined,
        );
        return this.#controlResult(acquired.reason);
      }
      if (acquired.kind === "error") {
        if (acquired.error instanceof WorkerDrainedError) return { accepted: false, code: "plugin-sdk:worker_failed" };
        if (acquired.error instanceof PluginSdkError && acquired.error.code === "plugin-sdk:sandbox_unsupported") {
          return { accepted: false, code: "plugin-sdk:sandbox_unsupported" };
        }
        return await this.#safeFailure(control, "plugin-sdk:worker_failed", acquired.error);
      }
      lease = acquired.value;
      const afterAcquire = control.check();
      if (afterAcquire !== undefined) {
        this.#discard(poolKey, lease);
        return this.#controlResult(afterAcquire);
      }
      if (!this.#leaseCurrent(poolKey, lease)) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_failed" };
      }

      const invoked = await control.race(async () => lease!.transport.invoke(request));
      if (invoked.kind === "control") {
        this.#discard(poolKey, lease);
        return this.#controlResult(invoked.reason);
      }
      if (invoked.kind === "error") {
        this.#discard(poolKey, lease);
        if (invoked.error instanceof WorkerProcessCrash) {
          const recorded = await control.race(async () => materializePortResult(await this.dependencies.quarantine_store.record_crash(
            scope,
            this.dependencies.clock.now(),
            this.dependencies.quarantine_policy,
          ), this.dependencies.metadata_materialization_limits));
          if (recorded.kind === "control") return this.#controlResult(recorded.reason);
          if (recorded.kind === "error") return await this.#safeFailure(control, "plugin-sdk:worker_lost", recorded.error);
          if (validateQuarantineRecord(recorded.value) === undefined) {
            return await this.#safeFailure(control, "plugin-sdk:worker_lost", new Error("Invalid atomic quarantine record."));
          }
        }
        return await this.#safeFailure(control, "plugin-sdk:worker_lost", invoked.error);
      }
      if (!this.#leaseCurrent(poolKey, lease)) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_failed" };
      }

      const decoded = decodeResponse(invoked.value, input.max_response_bytes, budget.max_output_bytes, budget);
      const afterDecode = control.check();
      if (afterDecode !== undefined) {
        this.#discard(poolKey, lease);
        return this.#controlResult(afterDecode);
      }
      if (decoded.resource !== undefined) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: decoded.resource };
      }
      if (decoded.invalid === true) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
      }
      if (!hasExactKeys(decoded.value, ["response", "metrics"])) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
      }
      const metrics = validateMetrics(decoded.value["metrics"]);
      if (metrics === undefined) {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
      }
      let response: PluginWorkerResponseEnvelope;
      try {
        response = this.#protocol.accept_outcome(request, decoded.value["response"]);
      } catch {
        this.#discard(poolKey, lease);
        return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
      }
      const afterValidation = control.check();
      if (afterValidation !== undefined) {
        this.#discard(poolKey, lease);
        return this.#controlResult(afterValidation);
      }
      for (const [limit, metric] of BUDGET_TO_METRIC) {
        if (metrics[metric] > budget[limit]) {
          this.#discard(poolKey, lease);
          return { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: metric };
        }
      }
      const afterMetrics = control.check();
      if (afterMetrics !== undefined) {
        this.#discard(poolKey, lease);
        return this.#controlResult(afterMetrics);
      }

      const releasePromise = this.#release(poolKey, lease, () => control.reason === undefined);
      const released = await control.race(async () => releasePromise);
      if (released.kind === "control") {
        this.#discard(poolKey, lease);
        return this.#controlResult(released.reason);
      }
      if (released.kind === "error") {
        this.#discard(poolKey, lease);
        return await this.#safeFailure(control, "plugin-sdk:worker_failed", released.error);
      }
      if (released.value === "drained") return { accepted: false, code: "plugin-sdk:worker_failed" };
      const afterRelease = control.check();
      if (afterRelease !== undefined) {
        this.#removeFromPool(poolKey, lease);
        this.#discard(poolKey, lease);
        return this.#controlResult(afterRelease);
      }
      return { accepted: true, response };
    } finally {
      control.close();
      if (reserved) this.#removeInflight(poolKey);
    }
  }

  async drain(key: WorkerKey): Promise<void> {
    const poolKey = workerKeyId(key);
    this.#generation.set(poolKey, (this.#generation.get(poolKey) ?? 0) + 1);
    const targets = new Set<WorkerLease>([...(this.#pool.get(poolKey) ?? []), ...(this.#active.get(poolKey) ?? [])]);
    this.#pool.delete(poolKey);
    for (const lease of targets) {
      this.#removePooledOrder(lease);
      this.#terminate(lease);
    }
    this.#cleanupKey(poolKey);
  }

  #protocolFailure(error: unknown): SupervisedExecutionResult {
    if (error instanceof PluginSdkError && error.code === "plugin-sdk:request_identity_conflict") {
      return { accepted: false, code: "plugin-sdk:request_identity_conflict" };
    }
    return { accepted: false, code: "plugin-sdk:worker_protocol_invalid" };
  }

  async #acquire(poolKey: string, launch: RestrictedWorkerLaunch, generation: number): Promise<WorkerLease> {
    const available = this.#pool.get(poolKey);
    const pooled = available?.pop();
    if (available?.length === 0) this.#pool.delete(poolKey);
    if (pooled !== undefined) {
      this.#removePooledOrder(pooled);
      if (!this.#leaseCurrent(poolKey, pooled) || pooled.generation !== generation) {
        this.#terminate(pooled);
        throw new WorkerDrainedError();
      }
      const active = this.#active.get(poolKey) ?? new Set<WorkerLease>();
      active.add(pooled);
      this.#active.set(poolKey, active);
      return pooled;
    }
    const transport = await this.dependencies.sandbox.launch(launch);
    const lease: WorkerLease = { transport, generation, terminated: false };
    if ((this.#generation.get(poolKey) ?? 0) !== generation) {
      this.#terminate(lease);
      throw new WorkerDrainedError();
    }
    const active = this.#active.get(poolKey) ?? new Set<WorkerLease>();
    active.add(lease);
    this.#active.set(poolKey, active);
    return lease;
  }

  async #release(poolKey: string, lease: WorkerLease, canPool: () => boolean): Promise<"released" | "drained"> {
    let attestation: unknown;
    try {
      attestation = await lease.transport.reset();
    } catch {
      this.#removeActive(poolKey, lease);
      this.#terminate(lease);
      this.#cleanupKey(poolKey);
      return "released";
    }
    this.#removeActive(poolKey, lease);
    if (!this.#leaseCurrent(poolKey, lease) || !canPool()) {
      this.#terminate(lease);
      this.#cleanupKey(poolKey);
      return "drained";
    }
    if (!hasExactKeys(attestation, ["state_reset"]) || attestation["state_reset"] !== true) {
      this.#terminate(lease);
      this.#cleanupKey(poolKey);
      return "released";
    }
    if (this.dependencies.worker_pool_policy.max_pooled_workers === 0) {
      this.#terminate(lease);
      this.#cleanupKey(poolKey);
      return "released";
    }
    const available = this.#pool.get(poolKey) ?? [];
    if (available.length >= this.dependencies.worker_pool_policy.max_workers_per_key) {
      this.#terminate(lease);
      this.#cleanupKey(poolKey);
      return "released";
    }
    while (this.#pooledOrder.length >= this.dependencies.worker_pool_policy.max_pooled_workers) {
      const oldest = this.#pooledOrder.shift();
      if (oldest === undefined) break;
      this.#removeFromPool(oldest.poolKey, oldest.lease, false);
      this.#terminate(oldest.lease);
      this.#cleanupKey(oldest.poolKey);
    }
    available.push(lease);
    this.#pool.set(poolKey, available);
    this.#pooledOrder.push({ poolKey, lease });
    return "released";
  }

  #discard(poolKey: string, lease: WorkerLease): void {
    this.#removeActive(poolKey, lease);
    this.#removeFromPool(poolKey, lease);
    this.#terminate(lease);
    this.#cleanupKey(poolKey);
  }

  #terminate(lease: WorkerLease): void {
    if (lease.terminated) return;
    lease.terminated = true;
    try {
      void Promise.resolve(lease.transport.terminate()).catch(() => undefined);
    } catch {
      // A throwing termination port is contained at the boundary.
    }
  }

  #leaseCurrent(poolKey: string, lease: WorkerLease): boolean {
    return !lease.terminated && lease.generation === (this.#generation.get(poolKey) ?? 0);
  }

  #removeFromPool(poolKey: string, lease: WorkerLease, removeOrder = true): void {
    const available = this.#pool.get(poolKey);
    if (available !== undefined) {
      const index = available.indexOf(lease);
      if (index >= 0) available.splice(index, 1);
      if (available.length === 0) this.#pool.delete(poolKey);
    }
    if (removeOrder) this.#removePooledOrder(lease);
  }

  #reserveExecution(poolKey: string): boolean {
    if ((this.#inflight.get(poolKey) ?? 0) >= this.dependencies.worker_pool_policy.max_workers_per_key) return false;
    if (!this.#keyOrder.has(poolKey)) {
      while (this.#keyOrder.size >= this.dependencies.worker_pool_policy.max_worker_keys) {
        if (!this.#evictOldestPooledKey()) return false;
      }
      this.#keyOrder.set(poolKey, true);
    }
    this.#inflight.set(poolKey, (this.#inflight.get(poolKey) ?? 0) + 1);
    return true;
  }

  #evictOldestPooledKey(): boolean {
    for (const candidate of this.#keyOrder.keys()) {
      if (this.#inflight.has(candidate) || this.#active.has(candidate)) continue;
      const pooled = this.#pool.get(candidate);
      if (pooled === undefined) continue;
      this.#pool.delete(candidate);
      for (const lease of pooled) {
        this.#removePooledOrder(lease);
        this.#terminate(lease);
      }
      this.#cleanupKey(candidate);
      return true;
    }
    return false;
  }

  #removePooledOrder(lease: WorkerLease): void {
    const index = this.#pooledOrder.findIndex((entry) => entry.lease === lease);
    if (index >= 0) this.#pooledOrder.splice(index, 1);
  }

  #removeInflight(poolKey: string): void {
    const remaining = (this.#inflight.get(poolKey) ?? 1) - 1;
    if (remaining > 0) this.#inflight.set(poolKey, remaining);
    else this.#inflight.delete(poolKey);
    this.#cleanupKey(poolKey);
  }

  #removeActive(poolKey: string, lease: WorkerLease): void {
    const active = this.#active.get(poolKey);
    active?.delete(lease);
    if (active?.size === 0) this.#active.delete(poolKey);
  }

  #cleanupKey(poolKey: string): void {
    if (!this.#pool.has(poolKey) && !this.#active.has(poolKey) && !this.#inflight.has(poolKey)) {
      this.#generation.delete(poolKey);
      this.#keyOrder.delete(poolKey);
    }
  }

  #controlResult(reason: ControlReason): SupervisedExecutionResult {
    return reason === "cancelled"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" };
  }

  async #safeFailure(
    control: ExecutionControl,
    code: "plugin-sdk:worker_failed" | "plugin-sdk:worker_lost",
    error: unknown,
  ): Promise<SupervisedExecutionResult> {
    const summary = safePrivateSummary(error);
    const failure = await control.race(async () => this.#failureId(summary));
    if (failure.kind === "control") return this.#controlResult(failure.reason);
    if (failure.kind === "error") return { accepted: false, code, failure_id: safeFailureId("", summary) };
    return { accepted: false, code, failure_id: failure.value };
  }

  async #failureId(summary: string): Promise<string> {
    let captured: string;
    try {
      captured = await this.dependencies.private_failure_sink.capture({ summary });
    } catch {
      captured = "";
    }
    return safeFailureId(captured, summary);
  }
}
