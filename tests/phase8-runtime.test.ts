import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSha256,
  ClosedWorkerProtocol,
  PluginSdkError,
  RestrictedNodeSandbox,
  SupervisedPluginRuntime,
  WorkerProcessCrash,
  workerRequestDigest,
  type PluginWorkerCall,
  type PluginWorkerOutcome,
  type PrivateFailureSink,
  type PlatformIsolationAdapter,
  type PlatformIsolationAttestation,
  type PlatformIsolationRequest,
  type PortMaterializationLimits,
  type QuarantinePolicy,
  type QuarantineRecord,
  type QuarantineScope,
  type QuarantineStore,
  type RestrictedWorkerLaunch,
  type RestrictedNodeProcessPort,
  type RestrictedNodeProcessSpec,
  type SupervisedExecutionInput,
  type TrustedWorkerBuildAuthorityPort,
  type TrustedWorkerBuildMetadata,
  type WorkerResourceBudget,
  type WorkerSandboxPort,
  type WorkerTimer,
  type WorkerTimerHandle,
  type WorkerTransport,
  type WorkerKey,
  type WorkerPayloadValidator,
  type WorkerPoolPolicy,
  type WorkerRequestIdentityClaim,
  type WorkerRequestIdentityPort,
} from "@urdira/plugin-sdk";

const protocolMaterializationLimits: PortMaterializationLimits = Object.freeze({
  max_items: 256,
  max_depth: 16,
  max_nodes: 2_048,
  max_bytes: 65_536,
});

const metadataMaterializationLimits: PortMaterializationLimits = Object.freeze({
  max_items: 256,
  max_depth: 8,
  max_nodes: 1_024,
  max_bytes: 16_384,
});

const workerPoolPolicy: WorkerPoolPolicy = Object.freeze({
  max_pooled_workers: 32,
  max_worker_keys: 32,
  max_workers_per_key: 8,
});

const workerKey: WorkerKey = Object.freeze({
  package_digest: "sha256:package-a",
  runtime_contract_version: 8,
  executable_build_digest: "sha256:build-a",
});

const calls: Readonly<Record<PluginWorkerCall, unknown>> = Object.freeze({
  describe: Object.freeze({ plugin_id: "acme:plugin" }),
  discover_partitions: Object.freeze({ snapshot_id: "snapshot-1" }),
  analyze_artifact: Object.freeze({ artifact_id: "artifact-1" }),
  analyze_closure: Object.freeze({ owner_path: "src/index.ts" }),
  generate_projection: Object.freeze({ record_id: "record-1" }),
});

const outcomes: Readonly<Record<PluginWorkerOutcome, unknown>> = Object.freeze({
  success: Object.freeze({ result_id: "result-1" }),
  inputs_incomplete: Object.freeze({ missing: Object.freeze(["dependency-a"]) }),
  unsupported: Object.freeze({ reason_code: "unsupported_kind" }),
  cancelled: Object.freeze({}),
  resource_exhausted: Object.freeze({ resource: "memory_bytes" }),
  failed: Object.freeze({
    candidate_issue_code: "core:plugin_failed",
    retryability: "not_retryable",
    message: "Plugin analysis failed safely.",
    details: Object.freeze({ provider_detail_code: "PLUGIN_FAILED" }),
  }),
});

function authoritativeDigest(input: {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly call: PluginWorkerCall;
  readonly deadline: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}): string {
  return canonicalSha256(input);
}

function authoritativeRequest() {
  const identity = {
    protocol_version: "8",
    request_id: "request-authoritative-1",
    call: "describe" as const,
    deadline: "1970-01-01T00:00:10.000Z",
    cancellation_id: "cancel-authoritative-1",
    payload: calls.describe,
  };
  return {
    protocol_version: identity.protocol_version,
    request_id: identity.request_id,
    request_digest: authoritativeDigest(identity),
    call: identity.call,
    deadline: identity.deadline,
    cancellation_id: identity.cancellation_id,
    payload: identity.payload,
  };
}

function authoritativeResponse(request: {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
} = authoritativeRequest()) {
  return {
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call: request.call,
    outcome: "success" as const,
    payload: outcomes.success,
  };
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

const payloadValidator: WorkerPayloadValidator = {
  validate_call(call, payload) {
    const key = call === "describe" ? "plugin_id"
      : call === "discover_partitions" ? "snapshot_id"
        : call === "analyze_artifact" ? "artifact_id"
          : call === "analyze_closure" ? "owner_path" : "record_id";
    if (!exactObject(payload, [key]) || typeof payload[key] !== "string") throw new Error("invalid call payload");
    return payload;
  },
  validate_outcome(_call, outcome, payload) {
    const valid = outcome === "success" ? exactObject(payload, ["result_id"]) && typeof payload["result_id"] === "string"
      : outcome === "inputs_incomplete" ? exactObject(payload, ["missing"]) && Array.isArray(payload["missing"])
        : outcome === "unsupported" ? exactObject(payload, ["reason_code"]) && typeof payload["reason_code"] === "string"
          : outcome === "cancelled" ? exactObject(payload, [])
            : outcome === "resource_exhausted" ? exactObject(payload, ["resource"]) && typeof payload["resource"] === "string"
              : exactObject(payload, ["candidate_issue_code", "retryability", "message", "details"])
                && payload["candidate_issue_code"] === "core:plugin_failed"
                && payload["retryability"] === "not_retryable"
                && typeof payload["message"] === "string"
                && payload["message"].length > 0
                && payload["message"].length <= 240
                && !/[\r\n\t\0\\/]/u.test(payload["message"])
                && exactObject(payload["details"], ["provider_detail_code"])
                && typeof payload["details"]["provider_detail_code"] === "string"
                && /^[A-Z][A-Z0-9_]{0,63}$/u.test(payload["details"]["provider_detail_code"]);
    if (!valid) throw new Error("invalid outcome payload");
    return payload;
  },
};

function protocol(validator: WorkerPayloadValidator = payloadValidator): ClosedWorkerProtocol {
  return new ClosedWorkerProtocol(validator, protocolMaterializationLimits);
}

function callDigest(call: PluginWorkerCall, payload: unknown, deadline = 10_000, requestId = "request-1", protocolVersion = "8"): string {
  return canonicalSha256({
    protocol_version: protocolVersion,
    request_id: requestId,
    call,
    deadline: new Date(deadline).toISOString(),
    cancellation_id: `cancel-${requestId}`,
    payload,
  });
}

function callEnvelope(call: PluginWorkerCall = "describe", payload: unknown = calls.describe, requestId = "request-1", deadline = 10_000, protocolVersion = "8") {
  return {
    protocol_version: protocolVersion,
    request_id: requestId,
    request_digest: callDigest(call, payload, deadline, requestId, protocolVersion),
    call,
    deadline: new Date(deadline).toISOString(),
    cancellation_id: `cancel-${requestId}`,
    payload,
  };
}

const zeroMetrics = Object.freeze({
  memory_bytes: 0,
  output_bytes: 0,
  records: 0,
  dependencies: 0,
  context_operations: 0,
  context_bytes: 0,
  recursion_depth: 0,
});

function outcomeEnvelope(request: ReturnType<typeof callEnvelope>, outcome: PluginWorkerOutcome = "success", payload: unknown = outcomes.success) {
  return {
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call: request.call,
    outcome,
    payload,
  };
}

describe("closed worker protocol envelopes, calls, outcomes, correlation, and idempotency", () => {
  it("includes request_id in the authoritative request digest", () => {
    const first = {
      protocol_version: "8",
      request_id: "request-digest-first",
      call: "describe" as const,
      deadline: "1970-01-01T00:00:10.000Z",
      cancellation_id: "cancel-digest",
      payload: calls.describe,
    };
    const second = { ...first, request_id: "request-digest-second" };
    expect(workerRequestDigest(first)).toBe("sha256:e2b820f327da10c20343f6df84b2601b975bc45705c13207e6a686c63f26bab9");
    expect(workerRequestDigest(second)).toBe("sha256:055cd187fa091dd230ed7b4af125661bbee3f723f4dd073322c62f31a6e06bb5");
    expect(workerRequestDigest(first)).not.toBe(workerRequestDigest(second));
  });

  it("accepts the literal authoritative request and response envelopes", () => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    const request = protocol.accept_call(authoritativeRequest());
    expect(request).toEqual(authoritativeRequest());
    expect(protocol.accept_outcome(request, authoritativeResponse(request))).toEqual(authoritativeResponse(request));
  });

  it("rejects supervisor and transport metadata added to authoritative envelopes", () => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    expect(() => protocol.accept_call({ ...authoritativeRequest(), workspace_id: "workspace-a" })).toThrowError(PluginSdkError);
    expect(() => protocol.accept_call({ ...authoritativeRequest(), worker_key: workerKey })).toThrowError(PluginSdkError);
    expect(() => protocol.accept_call({ ...authoritativeRequest(), retry: "new" })).toThrowError(PluginSdkError);
    const request = protocol.accept_call(authoritativeRequest());
    expect(() => protocol.accept_outcome(request, { ...authoritativeResponse(request), metrics: zeroMetrics })).toThrowError(PluginSdkError);
  });

  it.each(Object.entries(calls) as [PluginWorkerCall, unknown][])("accepts the closed %s call envelope", (call, payload) => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    expect(protocol.accept_call(callEnvelope(call, payload, `request-${call}`))).toMatchObject({ call, payload });
  });

  it.each(Object.entries(outcomes) as [PluginWorkerOutcome, unknown][])("accepts the closed %s outcome envelope", (outcome, payload) => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    const request = protocol.accept_call(callEnvelope());
    expect(protocol.accept_outcome(request, outcomeEnvelope(request, outcome, payload))).toMatchObject({ outcome, payload });
  });

  it.each([
    ["extra call field", { ...callEnvelope(), future: true }],
    ["missing payload field", (({ payload: _payload, ...rest }) => rest)(callEnvelope())],
    ["missing deadline field", (({ deadline: _deadline, ...rest }) => rest)(callEnvelope())],
    ["missing cancellation field", (({ cancellation_id: _cancellation, ...rest }) => rest)(callEnvelope())],
    ["unknown call", { ...callEnvelope(), call: "execute_command" }],
    ["supervisor worker key", { ...callEnvelope(), worker_key: workerKey }],
    ["unsupported future field", { ...callEnvelope(), capabilities: ["future"] }],
  ])("rejects a call envelope with %s", (_name, value) => {
    expect(() => protocol().accept_call(value)).toThrowError(PluginSdkError);
  });

  it.each([
    ["extra outcome field", (request: ReturnType<typeof callEnvelope>) => ({ ...outcomeEnvelope(request), future: true })],
    ["missing outcome field", (request: ReturnType<typeof callEnvelope>) => (({ payload: _payload, ...rest }) => rest)(outcomeEnvelope(request))],
    ["unknown outcome", (request: ReturnType<typeof callEnvelope>) => ({ ...outcomeEnvelope(request), outcome: "partial_success" })],
    ["extra metric field", (request: ReturnType<typeof callEnvelope>) => ({ ...outcomeEnvelope(request), metrics: { ...zeroMetrics, cpu: 1 } })],
  ])("rejects an outcome envelope with %s", (_name, mutate) => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    const request = protocol.accept_call(callEnvelope());
    expect(() => protocol.accept_outcome(request, mutate(request))).toThrowError(PluginSdkError);
  });

  it("rejects invalid call and outcome payload unions", () => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    expect(() => protocol.accept_call(callEnvelope("describe", { artifact_id: "wrong-union" }))).toThrowError(PluginSdkError);
    const request = protocol.accept_call(callEnvelope());
    expect(() => protocol.accept_outcome(request, outcomeEnvelope(request, "cancelled", { result_id: "partial" }))).toThrowError(PluginSdkError);
  });

  it("accepts authoritative PluginFailed and rejects stale or unsafe failed payloads through the injected validator", () => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    const request = protocol.accept_call(callEnvelope());
    expect(protocol.accept_outcome(request, outcomeEnvelope(request, "failed", outcomes.failed))).toMatchObject({
      outcome: "failed",
      payload: outcomes.failed,
    });
    expect(() => protocol.accept_outcome(request, outcomeEnvelope(request, "failed", {
      code: "PLUGIN_FAILED",
      message: "Plugin analysis failed safely.",
    }))).toThrowError(PluginSdkError);
    expect(() => protocol.accept_outcome(request, outcomeEnvelope(request, "failed", {
      candidate_issue_code: "core:plugin_failed",
      retryability: "not_retryable",
      message: "Error at /Users/private/workspace/token.txt\n    at secret stack",
      details: { provider_detail_code: "PLUGIN_FAILED" },
    }))).toThrowError(PluginSdkError);
    expect(() => protocol.accept_outcome(request, outcomeEnvelope(request, "failed", {
      candidate_issue_code: "core:plugin_failed",
      retryability: "not_retryable",
      message: "Plugin analysis failed safely.",
      details: { provider_detail_code: "X".repeat(65) },
    }))).toThrowError(PluginSdkError);
  });

  it.each([
    ["protocol", (value: ReturnType<typeof outcomeEnvelope>) => ({ ...value, protocol_version: "9" })],
    ["request ID", (value: ReturnType<typeof outcomeEnvelope>) => ({ ...value, request_id: "request-other" })],
    ["request digest", (value: ReturnType<typeof outcomeEnvelope>) => ({ ...value, request_digest: "sha256:other" })],
    ["call", (value: ReturnType<typeof outcomeEnvelope>) => ({ ...value, call: "analyze_artifact" })],
  ])("rejects a correlation mismatch in the repeated %s", (_name, mutate) => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    const request = protocol.accept_call(callEnvelope());
    expect(() => protocol.accept_outcome(request, mutate(outcomeEnvelope(request)))).toThrowError(PluginSdkError);
  });

  it("recomputes request digests before accepting the wire request", () => {
    const protocol = new ClosedWorkerProtocol(payloadValidator, protocolMaterializationLimits);
    expect(() => protocol.accept_call({ ...callEnvelope(), request_digest: "sha256:forged" })).toThrowError(PluginSdkError);
    expect(protocol.accept_call(callEnvelope())).toMatchObject({ request_id: "request-1" });
  });
});

class ManualTime implements WorkerTimer {
  now_ms = 1_000;
  readonly #timers = new Set<{ readonly at: number; readonly callback: () => void; active: boolean }>();

  now(): number { return this.now_ms; }
  activeTimers(): number { return [...this.#timers].filter((timer) => timer.active).length; }

  set(delay_ms: number, callback: () => void): WorkerTimerHandle {
    const timer = { at: this.now_ms + delay_ms, callback, active: true };
    this.#timers.add(timer);
    return { cancel: () => { timer.active = false; } };
  }

  advance(milliseconds: number): void {
    this.now_ms += milliseconds;
    for (const timer of this.#timers) {
      if (timer.active && timer.at <= this.now_ms) {
        timer.active = false;
        timer.callback();
      }
    }
  }
}

type InvokeHandler = (request: ReturnType<typeof callEnvelope>) => Promise<unknown>;

class DeterministicTransport implements WorkerTransport {
  readonly requests: ReturnType<typeof callEnvelope>[] = [];
  readonly cancellations: { readonly cancellation_id: string }[] = [];
  resets = 0;
  terminations = 0;

  constructor(
    private readonly handler: InvokeHandler,
    private readonly resetAttestation: unknown = Object.freeze({ state_reset: true }),
  ) {}

  async invoke(request: ReturnType<typeof callEnvelope>): Promise<unknown> {
    this.requests.push(request);
    return this.handler(request);
  }

  async cancel(input: { readonly cancellation_id: string }): Promise<void> {
    this.cancellations.push(input);
  }

  async reset(): Promise<unknown> {
    this.resets += 1;
    return this.resetAttestation;
  }

  async terminate(): Promise<void> { this.terminations += 1; }
}

class QueueSandbox implements WorkerSandboxPort {
  readonly launches: RestrictedWorkerLaunch[] = [];
  readonly #transports: WorkerTransport[];

  constructor(transports: readonly WorkerTransport[]) { this.#transports = [...transports]; }

  async launch(input: RestrictedWorkerLaunch): Promise<WorkerTransport> {
    this.launches.push(input);
    const transport = this.#transports.shift();
    if (transport === undefined) throw new Error("No scripted transport");
    return transport;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settledValue<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  let value!: T;
  let failure: unknown;
  promise.then(
    (result) => { value = result; settled = true; },
    (error: unknown) => { failure = error; settled = true; },
  );
  await waitUntil(() => settled);
  if (failure !== undefined) throw failure;
  return value;
}

class MemoryQuarantineStore implements QuarantineStore {
  readonly records = new Map<string, QuarantineRecord>();
  loads = 0;
  atomicUpdates = 0;

  private key(scope: QuarantineScope): string { return JSON.stringify(scope); }
  async load(scope: QuarantineScope): Promise<QuarantineRecord | undefined> { this.loads += 1; return this.records.get(this.key(scope)); }
  async record_crash(scope: QuarantineScope, now_ms: number, policy: QuarantinePolicy): Promise<QuarantineRecord> {
    this.atomicUpdates += 1;
    const current = this.records.get(this.key(scope));
    const record = policy.evaluate([...(current?.crash_times_ms ?? []), now_ms], now_ms);
    this.records.set(this.key(scope), record);
    return record;
  }
}

class ThresholdQuarantinePolicy implements QuarantinePolicy {
  constructor(readonly threshold: number, readonly window_ms: number, readonly duration_ms: number) {}
  evaluate(crash_times_ms: readonly number[], now_ms: number): QuarantineRecord {
    const retained = crash_times_ms.filter((time) => time >= now_ms - this.window_ms);
    return retained.length >= this.threshold
      ? { crash_times_ms: retained, quarantine_until_ms: now_ms + this.duration_ms }
      : { crash_times_ms: retained };
  }
}

class MemoryWorkerRequestIdentityPort implements WorkerRequestIdentityPort {
  readonly #identities = new Map<string, string>();
  claims = 0;

  get retained_count(): number { return this.#identities.size; }

  async claim(input: WorkerRequestIdentityClaim): Promise<"accepted" | "conflict"> {
    this.claims += 1;
    const prior = this.#identities.get(input.request_id);
    if (prior === undefined) {
      if (input.retry !== "new") return "conflict";
      this.#identities.set(input.request_id, input.identity_digest);
      return "accepted";
    }
    return input.retry === "retry_same" && prior === input.identity_digest ? "accepted" : "conflict";
  }
}

class RecordingFailureSink implements PrivateFailureSink {
  readonly failures: { readonly summary: string }[] = [];
  async capture(input: { readonly summary: string }): Promise<string> {
    this.failures.push(input);
    return `failure-${this.failures.length}`;
  }
}

function rejectedProxyError(marker: string): {
  readonly value: Error;
  readonly reads: Readonly<Record<"name" | "message" | "stack" | "toString", number>>;
} {
  const reads = { name: 0, message: 0, stack: 0, toString: 0 };
  const value = new Proxy(new Error("unobservable"), {
    get(target, property, receiver) {
      if (property === "name" || property === "message" || property === "stack" || property === "toString") {
        reads[property] += 1;
        throw new Error(marker);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { value, reads };
}

function rejectedNonErrorThenable(marker: string): {
  readonly value: object;
  readonly reads: Readonly<Record<"prototype" | "then" | "name" | "message" | "stack" | "toString", number>>;
} {
  const reads = { prototype: 0, then: 0, name: 0, message: 0, stack: 0, toString: 0 };
  const target = Object.create(null) as object;
  const value = new Proxy(target, {
    getPrototypeOf() {
      reads.prototype += 1;
      throw new Error(marker);
    },
    get(_target, property) {
      if (property === "then" || property === "name" || property === "message" || property === "stack" || property === "toString") {
        reads[property] += 1;
        throw new Error(marker);
      }
      return undefined;
    },
  });
  return { value, reads };
}

function launch(key: WorkerKey = workerKey): RestrictedWorkerLaunch {
  return { worker_key: key };
}

function resourceBudget(overrides: Partial<WorkerResourceBudget> = {}): WorkerResourceBudget {
  return {
    deadline_at_ms: 10_000,
    max_memory_bytes: 100,
    max_output_bytes: 10_000,
    max_records: 100,
    max_dependencies: 100,
    max_context_operations: 100,
    max_context_bytes: 100,
    max_recursion_depth: 10,
    ...overrides,
  };
}

function execution(
  requestId: string,
  options: {
    readonly workspace_id?: string;
    readonly key?: WorkerKey;
    readonly signal?: AbortSignal;
    readonly budget?: WorkerResourceBudget;
    readonly retry?: "new" | "retry_same";
  } = {},
): SupervisedExecutionInput {
  const key = options.key ?? workerKey;
  const workspace = options.workspace_id ?? "workspace-a";
  const payload = calls.describe;
  const candidateBudget = Object.hasOwn(options, "budget") ? options.budget : resourceBudget();
  const deadline = candidateBudget !== null
    && typeof candidateBudget === "object"
    && Number.isSafeInteger((candidateBudget as { readonly deadline_at_ms?: unknown }).deadline_at_ms)
    ? (candidateBudget as { readonly deadline_at_ms: number }).deadline_at_ms
    : 10_000;
  const request = callEnvelope("describe", payload, requestId, deadline, String(key.runtime_contract_version));
  return {
    request_envelope: request,
    workspace_id: workspace,
    worker_key: key,
    retry: options.retry ?? "new",
    cancellation_signal: options.signal ?? new AbortController().signal,
    budget: Object.hasOwn(options, "budget") ? options.budget as WorkerResourceBudget : resourceBudget(),
    max_response_bytes: 16_384,
  };
}

function responseHandler(metrics = zeroMetrics, payload: unknown = outcomes.success): InvokeHandler {
  return async (request) => ({ response: outcomeEnvelope(request, "success", payload), metrics });
}

function runtimeWith(
  sandbox: WorkerSandboxPort,
  options: {
    readonly time?: ManualTime;
    readonly store?: QuarantineStore;
    readonly policy?: QuarantinePolicy;
    readonly sink?: PrivateFailureSink;
    readonly validator?: WorkerPayloadValidator;
    readonly identities?: WorkerRequestIdentityPort;
    readonly pool_policy?: WorkerPoolPolicy;
    readonly protocol_limits?: PortMaterializationLimits;
    readonly metadata_limits?: PortMaterializationLimits;
  } = {},
) {
  const time = options.time ?? new ManualTime();
  const store = options.store ?? new MemoryQuarantineStore();
  const sink = options.sink ?? new RecordingFailureSink();
  return {
    runtime: new SupervisedPluginRuntime({
      sandbox,
      payload_validator: options.validator ?? payloadValidator,
      clock: time,
      timer: time,
      quarantine_policy: options.policy ?? new ThresholdQuarantinePolicy(2, 1_000, 5_000),
      quarantine_store: store,
      private_failure_sink: sink,
      request_identity_port: options.identities ?? new MemoryWorkerRequestIdentityPort(),
      worker_pool_policy: options.pool_policy ?? workerPoolPolicy,
      protocol_materialization_limits: options.protocol_limits ?? protocolMaterializationLimits,
      metadata_materialization_limits: options.metadata_limits ?? metadataMaterializationLimits,
    }),
    time,
    store,
    sink,
  };
}

describe("supervised worker pool, cancel, timeout, budget, crash, quarantine, and drain", () => {
  it("requires explicit identity, pool, and materialization authorities at construction", () => {
    const time = new ManualTime();
    const common = {
      sandbox: new QueueSandbox([]),
      payload_validator: payloadValidator,
      clock: time,
      timer: time,
      quarantine_policy: new ThresholdQuarantinePolicy(2, 1_000, 5_000),
      quarantine_store: new MemoryQuarantineStore(),
      private_failure_sink: new RecordingFailureSink(),
      request_identity_port: new MemoryWorkerRequestIdentityPort(),
      worker_pool_policy: workerPoolPolicy,
      protocol_materialization_limits: protocolMaterializationLimits,
      metadata_materialization_limits: metadataMaterializationLimits,
    };
    expect(() => new SupervisedPluginRuntime({ ...common, request_identity_port: undefined } as never)).toThrowError(PluginSdkError);
    expect(() => new SupervisedPluginRuntime({ ...common, worker_pool_policy: undefined } as never)).toThrowError(PluginSdkError);
    expect(() => new SupervisedPluginRuntime({ ...common, protocol_materialization_limits: undefined } as never)).toThrowError(PluginSdkError);
    expect(() => new SupervisedPluginRuntime({ ...common, metadata_materialization_limits: undefined } as never)).toThrowError(PluginSdkError);
    expect(() => new SupervisedPluginRuntime({
      ...common,
      worker_pool_policy: { ...workerPoolPolicy, max_worker_keys: 0 },
    })).toThrowError(PluginSdkError);
    expect(() => new SupervisedPluginRuntime({
      ...common,
      worker_pool_policy: { ...workerPoolPolicy, future_limit: 1 },
    } as never)).toThrowError(PluginSdkError);
  });

  it("delegates permanent new and retry_same identity claims to the atomic authority", async () => {
    const identities = new MemoryWorkerRequestIdentityPort();
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { identities });
    expect(await runtime.execute(execution("request-durable-identity"))).toMatchObject({ accepted: true });
    expect(await runtime.execute(execution("request-durable-identity", { retry: "retry_same" }))).toMatchObject({ accepted: true });
    const conflict = execution("request-durable-identity", { retry: "retry_same" });
    expect(await runtime.execute({
      ...conflict,
      request_envelope: callEnvelope("analyze_artifact", calls.analyze_artifact, "request-durable-identity"),
    })).toEqual({ accepted: false, code: "plugin-sdk:request_identity_conflict" });
    expect(await runtime.execute(execution("request-durable-identity"))).toEqual({
      accepted: false,
      code: "plugin-sdk:request_identity_conflict",
    });
    expect(identities.claims).toBe(4);
    expect(transport.requests).toHaveLength(2);
  });

  it("contains hostile atomic identity authority failures as closed worker failures", async () => {
    const rejected = rejectedProxyError("secret /private/HOSTILE_IDENTITY_AUTHORITY");
    const identities: WorkerRequestIdentityPort = { async claim() { throw rejected.value; } };
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox, { identities });
    const result = await runtime.execute(execution("request-hostile-identity-authority"));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed", failure_id: "failure-1" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(sandbox.launches).toEqual([]);
  });

  it.each(["cancel", "deadline"] as const)("supervises deferred atomic identity claims through %s", async (mode) => {
    const claimGate = deferred<"accepted" | "conflict">();
    const time = new ManualTime();
    const controller = new AbortController();
    let claims = 0;
    const identities: WorkerRequestIdentityPort = {
      async claim() { claims += 1; return claimGate.promise; },
    };
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox, { identities, time });
    const resultPromise = runtime.execute(execution(`request-identity-${mode}`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    await waitUntil(() => claims === 1);
    if (mode === "cancel") controller.abort(); else time.advance(10);
    expect(await settledValue(resultPromise)).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(sandbox.launches).toEqual([]);
    claimGate.resolve("accepted");
    await Promise.resolve();
    expect(sandbox.launches).toEqual([]);
  });

  it("keeps high-cardinality request identity storage outside runtime memory", async () => {
    const count = 40;
    const keys = Array.from({ length: count }, (_value, index): WorkerKey => ({
      ...workerKey,
      package_digest: `sha256:high-cardinality-${index}`,
    }));
    const transports = keys.map(() => new DeterministicTransport(responseHandler()));
    const sandbox = new QueueSandbox(transports);
    const identities = new MemoryWorkerRequestIdentityPort();
    const { runtime } = runtimeWith(sandbox, {
      identities,
      pool_policy: { max_pooled_workers: 0, max_worker_keys: 2, max_workers_per_key: 1 },
    });
    for (const [index, key] of keys.entries()) {
      expect((await runtime.execute(execution(`request-high-cardinality-${index}`, { key }))).accepted).toBe(true);
    }
    expect(identities.retained_count).toBe(40);
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 0, pooled_workers: 0 });
    expect(sandbox.launches).toHaveLength(40);
    expect(transports.every((transport) => transport.terminations === 1)).toBe(true);
  });

  it("deterministically evicts oldest pooled keys under high-cardinality pressure", async () => {
    const count = 20;
    const keys = Array.from({ length: count }, (_value, index): WorkerKey => ({
      ...workerKey,
      package_digest: `sha256:pooled-high-cardinality-${index}`,
    }));
    const transports = keys.map(() => new DeterministicTransport(responseHandler()));
    const { runtime } = runtimeWith(new QueueSandbox(transports), {
      pool_policy: { max_pooled_workers: 2, max_worker_keys: 2, max_workers_per_key: 1 },
    });
    for (const [index, key] of keys.entries()) {
      expect(await runtime.execute(execution(`request-pooled-high-${index}`, { key }))).toMatchObject({ accepted: true });
      expect(runtime.bookkeeping().worker_key_states).toBeLessThanOrEqual(2);
    }
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 2, pooled_workers: 2 });
    expect(transports.slice(0, -2).every((transport) => transport.terminations === 1)).toBe(true);
    expect(transports.slice(-2).map((transport) => transport.terminations)).toEqual([0, 0]);
  });

  it("rejects same-key concurrency beyond the injected worker limit without launching", async () => {
    const invokeGate = deferred<void>();
    const transport = new DeterministicTransport(async (request) => {
      await invokeGate.promise;
      return { response: outcomeEnvelope(request), metrics: zeroMetrics };
    });
    const sandbox = new QueueSandbox([transport]);
    const { runtime } = runtimeWith(sandbox, {
      pool_policy: { max_pooled_workers: 1, max_worker_keys: 2, max_workers_per_key: 1 },
    });
    const first = runtime.execute(execution("request-worker-limit-first"));
    await waitUntil(() => transport.requests.length === 1);
    expect(await runtime.execute(execution("request-worker-limit-second"))).toEqual({
      accepted: false,
      code: "plugin-sdk:worker_resource_exhausted",
    });
    expect(sandbox.launches).toHaveLength(1);
    invokeGate.resolve(undefined);
    expect(await first).toMatchObject({ accepted: true });
  });

  it("returns cancellation before saturated same-key admission without leaking a reservation", async () => {
    const invokeGate = deferred<void>();
    const controller = new AbortController();
    const identities = new MemoryWorkerRequestIdentityPort();
    const transport = new DeterministicTransport(async (request) => {
      await invokeGate.promise;
      return { response: outcomeEnvelope(request), metrics: zeroMetrics };
    });
    const sandbox = new QueueSandbox([transport]);
    const { runtime } = runtimeWith(sandbox, {
      identities,
      pool_policy: { max_pooled_workers: 1, max_worker_keys: 2, max_workers_per_key: 1 },
    });
    const first = runtime.execute(execution("request-admission-cancel-first"));
    await waitUntil(() => transport.requests.length === 1);
    controller.abort();

    expect(await runtime.execute(execution("request-admission-cancel-second", { signal: controller.signal }))).toEqual({
      accepted: false,
      code: "plugin-sdk:cancelled",
    });
    expect(identities.claims).toBe(1);
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 1, pooled_workers: 0 });
    invokeGate.resolve(undefined);
    expect(await first).toMatchObject({ accepted: true });
    await runtime.drain(workerKey);
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 0, pooled_workers: 0 });
  });

  it("rejects a new active key when no pooled key can be evicted", async () => {
    const invokeGate = deferred<void>();
    const firstKey = { ...workerKey, package_digest: "sha256:active-key-first" };
    const secondKey = { ...workerKey, package_digest: "sha256:active-key-second" };
    const transport = new DeterministicTransport(async (request) => {
      await invokeGate.promise;
      return { response: outcomeEnvelope(request), metrics: zeroMetrics };
    });
    const sandbox = new QueueSandbox([transport]);
    const { runtime } = runtimeWith(sandbox, {
      pool_policy: { max_pooled_workers: 1, max_worker_keys: 1, max_workers_per_key: 1 },
    });
    const first = runtime.execute(execution("request-active-key-first", { key: firstKey }));
    await waitUntil(() => transport.requests.length === 1);
    expect(await runtime.execute(execution("request-active-key-second", { key: secondKey }))).toEqual({
      accepted: false,
      code: "plugin-sdk:worker_resource_exhausted",
    });
    expect(runtime.bookkeeping().worker_key_states).toBe(1);
    invokeGate.resolve(undefined);
    expect(await first).toMatchObject({ accepted: true });
  });

  it("returns deadline exhaustion before saturated key admission without leaking a reservation", async () => {
    const invokeGate = deferred<void>();
    const time = new ManualTime();
    const identities = new MemoryWorkerRequestIdentityPort();
    const firstKey: WorkerKey = { ...workerKey, package_digest: "sha256:deadline-key-first" };
    const secondKey: WorkerKey = { ...workerKey, package_digest: "sha256:deadline-key-second" };
    const transport = new DeterministicTransport(async (request) => {
      await invokeGate.promise;
      return { response: outcomeEnvelope(request), metrics: zeroMetrics };
    });
    const sandbox = new QueueSandbox([transport]);
    const { runtime } = runtimeWith(sandbox, {
      identities,
      time,
      pool_policy: { max_pooled_workers: 1, max_worker_keys: 1, max_workers_per_key: 1 },
    });
    const first = runtime.execute(execution("request-admission-deadline-first", {
      key: firstKey,
      budget: resourceBudget({ deadline_at_ms: 20_000 }),
    }));
    await waitUntil(() => transport.requests.length === 1);
    time.advance(10_000);

    expect(await runtime.execute(execution("request-admission-deadline-second", { key: secondKey }))).toEqual({
      accepted: false,
      code: "plugin-sdk:worker_resource_exhausted",
      resource: "deadline",
    });
    expect(identities.claims).toBe(1);
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 1, pooled_workers: 0 });
    invokeGate.resolve(undefined);
    expect(await first).toMatchObject({ accepted: true });
    await runtime.drain(firstKey);
    expect(runtime.bookkeeping()).toEqual({ worker_key_states: 0, pooled_workers: 0 });
  });

  it("keeps supervisor metadata and execution metrics outside the closed worker envelopes", async () => {
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const result = await runtime.execute(execution("request-boundary"));
    expect(result).toMatchObject({ accepted: true, response: { outcome: "success" } });
    expect(Object.keys(transport.requests[0] ?? {}).sort()).toEqual([
      "call", "cancellation_id", "deadline", "payload", "protocol_version", "request_digest", "request_id",
    ]);
    if (!result.accepted) throw new Error("expected accepted response");
    expect(Object.keys(result.response).sort()).toEqual([
      "call", "outcome", "payload", "protocol_version", "request_digest", "request_id",
    ]);
    expect(result.response).not.toHaveProperty("metrics");
    expect(transport.cancellations).toEqual([]);
  });

  it("binds the wire protocol version to the exact worker runtime contract version", async () => {
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox);
    const input = execution("request-version-mismatch");
    const current = input.request_envelope as ReturnType<typeof callEnvelope>;
    const identity = {
      protocol_version: "9",
      request_id: current.request_id,
      call: current.call,
      deadline: current.deadline,
      cancellation_id: current.cancellation_id,
      payload: current.payload,
    };
    const request_envelope = { ...current, ...identity, request_digest: authoritativeDigest(identity) };
    expect(await runtime.execute({ ...input, request_envelope })).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
    expect(sandbox.launches).toEqual([]);
  });

  it("requires the envelope and budget to name the same absolute deadline", async () => {
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox);
    const input = execution("request-deadline-mismatch");
    const request_envelope = callEnvelope("describe", calls.describe, "request-deadline-mismatch", 10_001);
    expect(await runtime.execute({ ...input, request_envelope })).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
    expect(sandbox.launches).toEqual([]);
  });

  it.each([
    ["missing metrics", async (request: ReturnType<typeof callEnvelope>) => ({ response: outcomeEnvelope(request) })],
    ["extra transport field", async (request: ReturnType<typeof callEnvelope>) => ({ response: outcomeEnvelope(request), metrics: zeroMetrics, logs: [] })],
    ["metrics inside response", async (request: ReturnType<typeof callEnvelope>) => ({ response: { ...outcomeEnvelope(request), metrics: zeroMetrics }, metrics: zeroMetrics })],
  ] as const)("rejects transport metadata with %s", async (_kind, handler) => {
    const transport = new DeterministicTransport(handler);
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    expect(await runtime.execute(execution(`request-transport-${_kind}`))).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
    expect(transport.terminations).toBe(1);
  });

  it.each([
    ["wrapper response", (request: ReturnType<typeof callEnvelope>) => {
      let reads = 0;
      return {
        reads: () => reads,
        value: {
          get response() {
            reads += 1;
            if (reads > 1) throw new Error("REJECTED LATE_RESPONSE_GETTER");
            return outcomeEnvelope(request);
          },
          metrics: zeroMetrics,
        },
      };
    }],
    ["wrapper metrics", (request: ReturnType<typeof callEnvelope>) => {
      let reads = 0;
      return {
        reads: () => reads,
        value: {
          response: outcomeEnvelope(request),
          get metrics() {
            reads += 1;
            if (reads > 1) throw new Error("REJECTED LATE_METRICS_GETTER");
            return zeroMetrics;
          },
        },
      };
    }],
    ["nested response payload", (request: ReturnType<typeof callEnvelope>) => {
      let reads = 0;
      const response = { ...outcomeEnvelope(request) };
      Object.defineProperty(response, "payload", {
        enumerable: true,
        get() {
          reads += 1;
          if (reads > 1) throw new Error("REJECTED LATE_PAYLOAD_GETTER");
          return outcomes.success;
        },
      });
      return { reads: () => reads, value: { response, metrics: zeroMetrics } };
    }],
    ["nested metric", (request: ReturnType<typeof callEnvelope>) => {
      let reads = 0;
      const metrics = { ...zeroMetrics };
      Object.defineProperty(metrics, "memory_bytes", {
        enumerable: true,
        get() {
          reads += 1;
          if (reads > 1) throw new Error("REJECTED LATE_METRIC_GETTER");
          return 0;
        },
      });
      return { reads: () => reads, value: { response: outcomeEnvelope(request), metrics } };
    }],
  ] as const)("snapshots a fulfilled transport result once before reading a stateful %s getter", async (_kind, fixture) => {
    let reads = () => 0;
    const transport = new DeterministicTransport(async (request) => {
      const foreign = fixture(request);
      reads = foreign.reads;
      return foreign.value;
    });
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    await expect(runtime.execute(execution(`request-stateful-${_kind}`))).resolves.toMatchObject({ accepted: true });
    expect(reads()).toBe(1);
  });

  it("maps a transport getter that throws during its first boundary read to a safe protocol result", async () => {
    const transport = new DeterministicTransport(async (request) => ({
      response: outcomeEnvelope(request),
      get metrics() { throw new Error("secret /private/REJECTED_FIRST_METRICS_GETTER\nstack"); },
    }));
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    await expect(runtime.execute(execution("request-hostile-first-getter"))).resolves.toEqual({
      accepted: false,
      code: "plugin-sdk:worker_protocol_invalid",
    });
    expect(transport.terminations).toBe(1);
  });

  it.each([
    ["workspace", { workspace_id: "workspace-b" }],
    ["worker build", { key: { ...workerKey, executable_build_digest: "sha256:build-b" } }],
  ] as const)("rejects retry_same when supervisor %s identity changes", async (_kind, changed) => {
    const first = new DeterministicTransport(responseHandler());
    const second = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([first, second]));
    expect((await runtime.execute(execution(`request-retry-${_kind}`))).accepted).toBe(true);
    expect(await runtime.execute(execution(`request-retry-${_kind}`, { ...changed, retry: "retry_same" }))).toMatchObject({
      accepted: false,
      code: "plugin-sdk:request_identity_conflict",
    });
  });

  it("pools only the exact worker key and reuses it after stateless reset attestation", async () => {
    const keys = [
      workerKey,
      { ...workerKey, package_digest: "sha256:package-b" },
      { ...workerKey, runtime_contract_version: 9 },
      { ...workerKey, executable_build_digest: "sha256:build-b" },
    ];
    const transports = keys.map(() => new DeterministicTransport(responseHandler()));
    const sandbox = new QueueSandbox(transports);
    const { runtime } = runtimeWith(sandbox);
    for (const [index, key] of keys.entries()) expect((await runtime.execute(execution(`request-key-${index}`, { key }))).accepted).toBe(true);
    expect(sandbox.launches).toHaveLength(4);

    expect((await runtime.execute(execution("request-reuse", { workspace_id: "workspace-b" }))).accepted).toBe(true);
    expect(sandbox.launches).toHaveLength(4);
    expect(transports[0]?.resets).toBe(2);
  });

  it("terminates a worker whose pool reset does not attest cleared workspace state", async () => {
    const first = new DeterministicTransport(responseHandler(), { state_reset: false });
    const second = new DeterministicTransport(responseHandler());
    const sandbox = new QueueSandbox([first, second]);
    const { runtime } = runtimeWith(sandbox);
    expect((await runtime.execute(execution("request-reset-1"))).accepted).toBe(true);
    expect(first.terminations).toBe(1);
    expect((await runtime.execute(execution("request-reset-2"))).accepted).toBe(true);
    expect(sandbox.launches).toHaveLength(2);
  });

  it("maps sandbox launch faults to closed safe results without crash quarantine", async () => {
    const store = new MemoryQuarantineStore();
    const sink = new RecordingFailureSink();
    const unsupportedSandbox: WorkerSandboxPort = {
      async launch() { throw new PluginSdkError("plugin-sdk:sandbox_unsupported", "Sandbox unavailable."); },
    };
    const unsupported = runtimeWith(unsupportedSandbox, { store, sink }).runtime;
    await expect(unsupported.execute(execution("request-launch-unsupported"))).resolves.toMatchObject({
      accepted: false,
      code: "plugin-sdk:sandbox_unsupported",
    });

    const brokenSandbox: WorkerSandboxPort = {
      async launch() { throw new Error("secret /private/launch stack"); },
    };
    const broken = runtimeWith(brokenSandbox, { store, sink }).runtime;
    await expect(broken.execute(execution("request-launch-failed"))).resolves.toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_failed",
      failure_id: "failure-1",
    });
    expect(store.atomicUpdates).toBe(0);
  });

  it("sends cooperative cancellation once and discards late worker output", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    const transport = new DeterministicTransport(async () => pending);
    const controller = new AbortController();
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const resultPromise = runtime.execute(execution("request-cancel", { signal: controller.signal }));
    await waitUntil(() => transport.requests.length === 1);
    controller.abort();
    controller.abort();
    const result = await resultPromise;
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:cancelled" });
    expect(transport.cancellations).toEqual([{ cancellation_id: "cancel-request-cancel" }]);
    resolve(outcomeEnvelope(callEnvelope("describe", calls.describe, "request-cancel")));
    await Promise.resolve();
    expect(result).not.toHaveProperty("response");
    expect(transport.terminations).toBe(1);
  });

  it("times out at the injected deadline, cancels once, and rejects late output", async () => {
    const time = new ManualTime();
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => { resolve = done; });
    const transport = new DeterministicTransport(async () => pending);
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time });
    const resultPromise = runtime.execute(execution("request-timeout", { budget: resourceBudget({ deadline_at_ms: 1_010 }) }));
    await waitUntil(() => transport.requests.length === 1);
    time.advance(10);
    const result = await resultPromise;
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(transport.cancellations).toHaveLength(1);
    resolve(outcomeEnvelope(callEnvelope("describe", calls.describe, "request-timeout")));
    expect(result).not.toHaveProperty("response");
  });

  it("observes cancellation that occurs while a worker is being launched", async () => {
    const controller = new AbortController();
    const transport = new DeterministicTransport(responseHandler());
    const sandbox: WorkerSandboxPort = {
      async launch() {
        controller.abort();
        return transport;
      },
    };
    const { runtime } = runtimeWith(sandbox);
    const result = await runtime.execute(execution("request-cancel-during-launch", { signal: controller.signal }));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:cancelled" });
    expect(transport.cancellations).toHaveLength(1);
    expect(transport.terminations).toBe(1);
  });

  it("observes deadline exhaustion that occurs while a worker is being launched", async () => {
    const time = new ManualTime();
    const transport = new DeterministicTransport(responseHandler());
    const sandbox: WorkerSandboxPort = {
      async launch() {
        time.advance(11);
        return transport;
      },
    };
    const { runtime } = runtimeWith(sandbox, { time });
    const result = await runtime.execute(execution("request-deadline-during-launch", { budget: resourceBudget({ deadline_at_ms: 1_010 }) }));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(transport.cancellations).toHaveLength(1);
    expect(transport.terminations).toBe(1);
  });

  it.each(["cancel", "deadline"] as const)("covers deferred quarantine load with %s", async (mode) => {
    const time = new ManualTime();
    const controller = new AbortController();
    const gate = deferred<QuarantineRecord | undefined>();
    let loadStarted = false;
    const store: QuarantineStore = {
      async load() { loadStarted = true; return gate.promise; },
      async record_crash() { throw new Error("must not update"); },
    };
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox, { time, store });
    const resultPromise = runtime.execute(execution(`request-${mode}-quarantine-load`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    await waitUntil(() => loadStarted);
    if (mode === "cancel") controller.abort(); else time.advance(10);
    const result = await settledValue(resultPromise);
    expect(result).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(sandbox.launches).toEqual([]);
    gate.resolve(undefined);
  });

  it.each(["cancel", "deadline"] as const)("covers deferred sandbox launch with %s and terminates a late worker", async (mode) => {
    const time = new ManualTime();
    const controller = new AbortController();
    const gate = deferred<WorkerTransport>();
    let launchStarted = false;
    const transport = new DeterministicTransport(responseHandler());
    const sandbox: WorkerSandboxPort = {
      async launch() { launchStarted = true; return gate.promise; },
    };
    const { runtime } = runtimeWith(sandbox, { time });
    const resultPromise = runtime.execute(execution(`request-${mode}-deferred-launch`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    await waitUntil(() => launchStarted);
    if (mode === "cancel") controller.abort(); else time.advance(10);
    const result = await settledValue(resultPromise);
    expect(result).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    gate.resolve(transport);
    await waitUntil(() => transport.terminations === 1);
    expect(transport.requests).toEqual([]);
  });

  it.each(["cancel", "deadline"] as const)("checks %s after outcome validation before accepting success", async (mode) => {
    const time = new ManualTime();
    const controller = new AbortController();
    const validator: WorkerPayloadValidator = {
      validate_call: payloadValidator.validate_call.bind(payloadValidator),
      validate_outcome(call, outcome, payload) {
        const validated = payloadValidator.validate_outcome(call, outcome, payload);
        if (mode === "cancel") controller.abort(); else time.advance(10);
        return validated;
      },
    };
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time, validator });
    const result = await runtime.execute(execution(`request-${mode}-validation`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    expect(result).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(result).not.toHaveProperty("response");
    expect(transport.resets).toBe(0);
    expect(transport.terminations).toBe(1);
  });

  it.each(["cancel", "deadline"] as const)("covers deferred stateless reset with %s and never repools late reset", async (mode) => {
    const time = new ManualTime();
    const controller = new AbortController();
    const resetGate = deferred<unknown>();
    const transport = new DeterministicTransport(responseHandler());
    transport.reset = async () => {
      transport.resets += 1;
      return resetGate.promise;
    };
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time });
    const resultPromise = runtime.execute(execution(`request-${mode}-reset`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    await waitUntil(() => transport.resets === 1);
    if (mode === "cancel") controller.abort(); else time.advance(10);
    const result = await settledValue(resultPromise);
    expect(result).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(result).not.toHaveProperty("response");
    resetGate.resolve({ state_reset: true });
    await waitUntil(() => transport.terminations === 1);
  });

  it.each(["cancel", "deadline"] as const)("returns promptly for %s when termination never settles", async (mode) => {
    const time = new ManualTime();
    const controller = new AbortController();
    const invokeGate = deferred<unknown>();
    const transport = new DeterministicTransport(async () => invokeGate.promise);
    transport.terminate = async () => {
      transport.terminations += 1;
      return new Promise<void>(() => undefined);
    };
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time });
    const resultPromise = runtime.execute(execution(`request-${mode}-stuck-terminate`, {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    await waitUntil(() => transport.requests.length === 1);
    if (mode === "cancel") controller.abort(); else time.advance(10);
    const result = await settledValue(resultPromise);
    expect(result).toMatchObject(mode === "cancel"
      ? { accepted: false, code: "plugin-sdk:cancelled" }
      : { accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: "deadline" });
    expect(transport.terminations).toBe(1);
  });

  it("maps a synchronous invoke throw safely and removes deadline/cancellation hooks", async () => {
    const time = new ManualTime();
    const controller = new AbortController();
    let cancellations = 0;
    const transport: WorkerTransport = {
      invoke() { throw new WorkerProcessCrash("synchronous private stack"); },
      async cancel() { cancellations += 1; },
      async reset() { return { state_reset: true }; },
      async terminate() {},
    };
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time });
    const result = await runtime.execute(execution("request-sync-invoke-throw", {
      signal: controller.signal,
      budget: resourceBudget({ deadline_at_ms: 1_010 }),
    }));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
    expect(time.activeTimers()).toBe(0);
    controller.abort();
    time.advance(10);
    expect(cancellations).toBe(0);
  });

  it.each([
    ["memory_bytes", "max_memory_bytes", 101],
    ["output_bytes", "max_output_bytes", 10_001],
    ["records", "max_records", 101],
    ["dependencies", "max_dependencies", 101],
    ["context_operations", "max_context_operations", 101],
    ["context_bytes", "max_context_bytes", 101],
    ["recursion_depth", "max_recursion_depth", 11],
  ] as const)("enforces the independent %s budget without partial success", async (metric, _limit, usage) => {
    const metrics = { ...zeroMetrics, [metric]: usage };
    const { runtime } = runtimeWith(new QueueSandbox([new DeterministicTransport(responseHandler(metrics, { result_id: "must-discard" }))]));
    const result = await runtime.execute(execution(`request-budget-${metric}`));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_resource_exhausted", resource: metric });
    expect(result).not.toHaveProperty("response");
  });

  it("rejects every missing worker budget dimension before launch", async () => {
    const required = Object.keys(resourceBudget()) as (keyof WorkerResourceBudget)[];
    for (const [index, missing] of required.entries()) {
      const value = { ...resourceBudget() } as Record<string, unknown>;
      delete value[missing];
      const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
      const { runtime } = runtimeWith(sandbox);
      await expect(runtime.execute(execution(`request-budget-missing-${index}`, {
        budget: value as unknown as WorkerResourceBudget,
      }))).resolves.toMatchObject({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
      expect(sandbox.launches).toEqual([]);
    }
  });

  it.each([
    ["extra field", { ...resourceBudget(), future_limit: 1 }],
    ["null", null],
    ["array", []],
    ["string", "unbounded"],
    ["fraction", { ...resourceBudget(), max_records: 1.5 }],
    ["string value", { ...resourceBudget(), max_dependencies: "100" }],
  ])("rejects a closed worker budget with %s safely", async (_name, budgetValue) => {
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox);
    await expect(runtime.execute(execution(`request-budget-invalid-${_name}`, {
      budget: budgetValue as unknown as WorkerResourceBudget,
    }))).resolves.toMatchObject({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    expect(sandbox.launches).toEqual([]);
  });

  it.each([
    "deadline_at_ms",
    "max_memory_bytes",
    "max_output_bytes",
    "max_records",
    "max_dependencies",
    "max_recursion_depth",
  ] as const)("requires a positive %s budget", async (field) => {
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox);
    await expect(runtime.execute(execution(`request-budget-zero-${field}`, {
      budget: resourceBudget({ [field]: 0 }),
    }))).resolves.toMatchObject({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    expect(sandbox.launches).toEqual([]);
  });

  it("allows zero only for context operation and context byte limits", async () => {
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const result = await runtime.execute(execution("request-zero-context-budgets", {
      budget: resourceBudget({ max_context_operations: 0, max_context_bytes: 0 }),
    }));
    expect(result).toMatchObject({ accepted: true });
  });

  it("derives safe response materialization limits from the largest valid recursion budget", async () => {
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const result = await runtime.execute(execution("request-max-recursion-budget", {
      budget: resourceBudget({ max_recursion_depth: Number.MAX_SAFE_INTEGER }),
    }));
    expect(result).toMatchObject({ accepted: true });
  });

  it.each<readonly [string, InvokeHandler]>([
    ["malformed", async () => "{"],
    ["truncated", async () => "{\"protocol_version\":1"],
    ["oversized", async () => JSON.stringify({ padding: "x".repeat(20_000) })],
  ])("rejects and terminates a %s worker response", async (_kind, handler) => {
    const transport = new DeterministicTransport(handler);
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const result = await runtime.execute(execution(`request-${_kind}`));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_protocol_invalid" });
    expect(transport.terminations).toBe(1);
  });

  it("maps worker loss to an opaque bounded private failure ID", async () => {
    const sink = new RecordingFailureSink();
    const transport = new DeterministicTransport(async () => { throw new WorkerProcessCrash("secret /private/token\nstack trace".repeat(500)); });
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { sink });
    const result = await runtime.execute(execution("request-loss"));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost", failure_id: "failure-1" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(sink.failures[0]?.summary.length).toBeLessThanOrEqual(2_048);
  });

  it("replaces an unsafe private-sink failure ID with a bounded opaque ID", async () => {
    const sink: PrivateFailureSink = { capture: async () => "unsafe /private/token\nstack" };
    const transport = new DeterministicTransport(async () => { throw new WorkerProcessCrash("private failure"); });
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { sink });
    const result = await runtime.execute(execution("request-unsafe-failure-id"));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
    if (result.accepted) throw new Error("expected worker loss");
    expect(result.failure_id).toMatch(/^failure-[0-9a-f]{24}$/u);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not count a valid plugin-declared failure as a process crash", async () => {
    const store = new MemoryQuarantineStore();
    const handler: InvokeHandler = async (request) => ({
      response: outcomeEnvelope(request, "failed", outcomes.failed),
      metrics: zeroMetrics,
    });
    const transport = new DeterministicTransport(handler);
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { store, policy: new ThresholdQuarantinePolicy(1, 1_000, 5_000) });
    expect(await runtime.execute(execution("request-plugin-failed"))).toMatchObject({
      accepted: true,
      response: { outcome: "failed", payload: outcomes.failed },
    });
    expect(store.atomicUpdates).toBe(0);
  });

  it("quarantines only the crashing exact build in the affected workspace under injected policy", async () => {
    const crashA = new DeterministicTransport(async () => { throw new WorkerProcessCrash("crash-a"); });
    const crashB = new DeterministicTransport(async () => { throw new WorkerProcessCrash("crash-b"); });
    const otherWorkspace = new DeterministicTransport(responseHandler());
    const otherBuild = new DeterministicTransport(responseHandler());
    const sandbox = new QueueSandbox([crashA, crashB, otherWorkspace, otherBuild]);
    const { runtime } = runtimeWith(sandbox, { policy: new ThresholdQuarantinePolicy(2, 100, 5_000) });
    await runtime.execute(execution("request-crash-1"));
    await runtime.execute(execution("request-crash-2"));
    expect(await runtime.execute(execution("request-quarantined"))).toMatchObject({ accepted: false, code: "plugin-sdk:worker_quarantined" });
    expect((await runtime.execute(execution("request-other-workspace", { workspace_id: "workspace-b" }))).accepted).toBe(true);
    expect((await runtime.execute(execution("request-other-build", { key: { ...workerKey, executable_build_digest: "sha256:other-build" } }))).accepted).toBe(true);
  });

  it("honors the injected crash window rather than an architectural threshold", async () => {
    const time = new ManualTime();
    const crashes = [1, 2, 3].map(() => new DeterministicTransport(async () => { throw new WorkerProcessCrash("crash"); }));
    const { runtime } = runtimeWith(new QueueSandbox(crashes), { time, policy: new ThresholdQuarantinePolicy(2, 5, 100) });
    await runtime.execute(execution("request-window-1"));
    time.advance(6);
    await runtime.execute(execution("request-window-2"));
    const result = await runtime.execute(execution("request-window-3"));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
  });

  it("records the crash occurrence time rather than the pre-launch time", async () => {
    const time = new ManualTime();
    const store = new MemoryQuarantineStore();
    const transport = new DeterministicTransport(async () => {
      time.advance(25);
      throw new WorkerProcessCrash("later crash");
    });
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { time, store });
    await runtime.execute(execution("request-crash-time"));
    expect([...store.records.values()][0]?.crash_times_ms).toEqual([1_025]);
  });

  it("atomically records concurrent crashes so the injected threshold cannot lose an update", async () => {
    const crashGate = deferred<void>();
    const crash = () => new DeterministicTransport(async () => {
      await crashGate.promise;
      throw new WorkerProcessCrash("concurrent crash");
    });
    const first = crash();
    const second = crash();
    const unexpectedLaunch = new DeterministicTransport(responseHandler());
    const sandbox = new QueueSandbox([first, second, unexpectedLaunch]);
    const store = new MemoryQuarantineStore();
    const { runtime } = runtimeWith(sandbox, { store, policy: new ThresholdQuarantinePolicy(2, 1_000, 5_000) });
    const one = runtime.execute(execution("request-concurrent-crash-1"));
    const two = runtime.execute(execution("request-concurrent-crash-2"));
    await waitUntil(() => first.requests.length + second.requests.length === 2);
    crashGate.resolve();
    await Promise.all([one, two]);

    expect(store.atomicUpdates).toBe(2);
    expect([...store.records.values()][0]).toMatchObject({ crash_times_ms: [1_000, 1_000], quarantine_until_ms: 6_000 });
    expect(await runtime.execute(execution("request-after-concurrent-crashes"))).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_quarantined",
    });
    expect(sandbox.launches).toHaveLength(2);
  });

  it("sanitizes hostile quarantine load and atomic-update failures", async () => {
    const sink = new RecordingFailureSink();
    const loadFailure: QuarantineStore = {
      async load() { throw new Error("secret /private/quarantine-load\nstack"); },
      async record_crash() { throw new Error("must not update"); },
    };
    const loadRuntime = runtimeWith(new QueueSandbox([new DeterministicTransport(responseHandler())]), { store: loadFailure, sink }).runtime;
    const loadResult = await loadRuntime.execute(execution("request-hostile-quarantine-load"));
    expect(loadResult).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed", failure_id: "failure-1" });
    expect(JSON.stringify(loadResult)).not.toContain("private");

    const updateFailure: QuarantineStore = {
      async load() { return undefined; },
      async record_crash() { throw new Error("secret /private/quarantine-update\nstack"); },
    };
    const crash = new DeterministicTransport(async () => { throw new WorkerProcessCrash("process crash"); });
    const updateRuntime = runtimeWith(new QueueSandbox([crash]), { store: updateFailure, sink }).runtime;
    const updateResult = await updateRuntime.execute(execution("request-hostile-quarantine-update"));
    expect(updateResult).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost" });
    expect(JSON.stringify(updateResult)).not.toContain("private");
  });

  it("enforces the injected metadata materialization limit on quarantine records", async () => {
    const store: QuarantineStore = {
      async load() { return { crash_times_ms: [], quarantine_until_ms: 0 }; },
      async record_crash() { throw new Error("must not update"); },
    };
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox, {
      store,
      metadata_limits: { max_items: 0, max_depth: 0, max_nodes: 1, max_bytes: 0 },
    });
    expect(await runtime.execute(execution("request-metadata-limit"))).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_failed",
      failure_id: "failure-1",
    });
    expect(sandbox.launches).toEqual([]);
  });

  it("contains a rejected proxy Error from quarantine load without rereading hostile metadata", async () => {
    const rejected = rejectedProxyError("secret /private/HOSTILE_LOAD_ERROR_GETTER");
    const sink = new RecordingFailureSink();
    const store: QuarantineStore = {
      async load() { throw rejected.value; },
      async record_crash() { throw new Error("must not update"); },
    };
    const { runtime } = runtimeWith(new QueueSandbox([new DeterministicTransport(responseHandler())]), { store, sink });

    const result = await runtime.execute(execution("request-proxy-error-load"));
    expect(result).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_failed",
      failure_id: "failure-1",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(rejected.reads).toEqual({ name: 1, message: 0, stack: 0, toString: 0 });
    expect(sink.failures).toEqual([{ summary: "Worker transport failure." }]);
  });

  it("contains a rejected proxy Error from atomic crash recording without rereading hostile metadata", async () => {
    const rejected = rejectedProxyError("secret /private/HOSTILE_ATOMIC_ERROR_GETTER");
    const sink = new RecordingFailureSink();
    const store: QuarantineStore = {
      async load() { return undefined; },
      async record_crash() { throw rejected.value; },
    };
    const crash = new DeterministicTransport(async () => { throw new WorkerProcessCrash("process crash"); });
    const { runtime } = runtimeWith(new QueueSandbox([crash]), { store, sink });

    const result = await runtime.execute(execution("request-proxy-error-atomic"));
    expect(result).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_lost",
      failure_id: "failure-1",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(rejected.reads).toEqual({ name: 1, message: 0, stack: 0, toString: 0 });
    expect(sink.failures).toEqual([{ summary: "Worker transport failure." }]);
  });

  it("contains a rejected non-Error thenable from quarantine load without inspecting it twice", async () => {
    const rejected = rejectedNonErrorThenable("secret /private/HOSTILE_LOAD_THENABLE");
    const sink = new RecordingFailureSink();
    const store: QuarantineStore = {
      async load() { throw rejected.value; },
      async record_crash() { throw new Error("must not update"); },
    };
    const { runtime } = runtimeWith(new QueueSandbox([new DeterministicTransport(responseHandler())]), { store, sink });

    const result = await runtime.execute(execution("request-thenable-load"));
    expect(result).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_failed",
      failure_id: "failure-1",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(rejected.reads).toEqual({ prototype: 1, then: 0, name: 0, message: 0, stack: 0, toString: 0 });
    expect(sink.failures).toEqual([{ summary: "Worker transport failure." }]);
  });

  it("contains a rejected non-Error thenable from atomic crash recording without inspecting it twice", async () => {
    const rejected = rejectedNonErrorThenable("secret /private/HOSTILE_ATOMIC_THENABLE");
    const sink = new RecordingFailureSink();
    const store: QuarantineStore = {
      async load() { return undefined; },
      async record_crash() { throw rejected.value; },
    };
    const crash = new DeterministicTransport(async () => { throw new WorkerProcessCrash("process crash"); });
    const { runtime } = runtimeWith(new QueueSandbox([crash]), { store, sink });

    const result = await runtime.execute(execution("request-thenable-atomic"));
    expect(result).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_lost",
      failure_id: "failure-1",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(rejected.reads).toEqual({ prototype: 1, then: 0, name: 0, message: 0, stack: 0, toString: 0 });
    expect(sink.failures).toEqual([{ summary: "Worker transport failure." }]);
  });

  it("snapshots a fulfilled quarantine load once before reading stateful fields", async () => {
    let crashReads = 0;
    let untilReads = 0;
    const store: QuarantineStore = {
      async load() {
        return {
          get crash_times_ms() {
            crashReads += 1;
            if (crashReads > 1) throw new Error("secret /private/LATE_QUARANTINE_CRASHES_GETTER");
            return [];
          },
          get quarantine_until_ms() {
            untilReads += 1;
            if (untilReads > 1) throw new Error("secret /private/LATE_QUARANTINE_UNTIL_GETTER");
            return 0;
          },
        };
      },
      async record_crash() { throw new Error("must not update"); },
    };
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { store });
    await expect(runtime.execute(execution("request-stateful-quarantine-load"))).resolves.toMatchObject({ accepted: true });
    expect({ crashReads, untilReads }).toEqual({ crashReads: 1, untilReads: 1 });
  });

  it("contains a hostile nested getter in a fulfilled quarantine load", async () => {
    const crashTimes: number[] = [];
    Object.defineProperty(crashTimes, 0, {
      enumerable: true,
      get() { throw new Error("secret /private/HOSTILE_NESTED_QUARANTINE_GETTER\nstack"); },
    });
    Object.defineProperty(crashTimes, "length", { value: 1 });
    const store: QuarantineStore = {
      async load() { return { crash_times_ms: crashTimes }; },
      async record_crash() { throw new Error("must not update"); },
    };
    const sink = new RecordingFailureSink();
    const sandbox = new QueueSandbox([new DeterministicTransport(responseHandler())]);
    const { runtime } = runtimeWith(sandbox, { store, sink });
    const result = await runtime.execute(execution("request-hostile-nested-quarantine"));
    expect(result).toMatchObject({
      accepted: false,
      code: "plugin-sdk:worker_failed",
      failure_id: "failure-1",
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(sandbox.launches).toEqual([]);
  });

  it("snapshots a fulfilled atomic quarantine result before reading stateful fields", async () => {
    let crashReads = 0;
    let untilReads = 0;
    const store: QuarantineStore = {
      async load() { return undefined; },
      async record_crash() {
        return {
          get crash_times_ms() {
            crashReads += 1;
            if (crashReads > 1) throw new Error("secret /private/LATE_ATOMIC_CRASHES_GETTER");
            return [1_000];
          },
          get quarantine_until_ms() {
            untilReads += 1;
            if (untilReads > 1) throw new Error("secret /private/LATE_ATOMIC_UNTIL_GETTER");
            return 6_000;
          },
        };
      },
    };
    const sink = new RecordingFailureSink();
    const crash = new DeterministicTransport(async () => { throw new WorkerProcessCrash("process crash"); });
    const { runtime } = runtimeWith(new QueueSandbox([crash]), { store, sink });
    const result = await runtime.execute(execution("request-stateful-atomic-quarantine"));
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_lost", failure_id: "failure-1" });
    expect({ crashReads, untilReads }).toEqual({ crashReads: 1, untilReads: 1 });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("drains exact-key pooled workers without touching quarantine state", async () => {
    const transport = new DeterministicTransport(responseHandler());
    const store = new MemoryQuarantineStore();
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { store });
    await runtime.execute(execution("request-drain"));
    const updates = store.atomicUpdates;
    await runtime.drain(workerKey);
    expect(transport.terminations).toBe(1);
    expect(store.atomicUpdates).toBe(updates);
  });

  it("invalidates a pending launch generation across drain", async () => {
    const launchGate = deferred<WorkerTransport>();
    let launchStarted = false;
    const transport = new DeterministicTransport(responseHandler());
    const sandbox: WorkerSandboxPort = {
      async launch() { launchStarted = true; return launchGate.promise; },
    };
    const { runtime } = runtimeWith(sandbox);
    const executionPromise = runtime.execute(execution("request-drain-pending-launch"));
    await waitUntil(() => launchStarted);
    await runtime.drain(workerKey);
    launchGate.resolve(transport);
    const result = await settledValue(executionPromise);
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed" });
    expect(transport.requests).toEqual([]);
    expect(transport.terminations).toBe(1);
  });

  it("retains drain generation through a pre-launch quarantine load and cleans it afterward", async () => {
    const loadGate = deferred<QuarantineRecord | undefined>();
    let loadStarted = false;
    const store: QuarantineStore = {
      async load() { loadStarted = true; return loadGate.promise; },
      async record_crash() { throw new Error("must not update"); },
    };
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]), { store });
    const resultPromise = runtime.execute(execution("request-drain-during-quarantine"));
    await waitUntil(() => loadStarted);
    await runtime.drain(workerKey);
    loadGate.resolve(undefined);

    expect(await settledValue(resultPromise)).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed" });
    expect(transport.requests).toEqual([]);
    expect(transport.terminations).toBe(1);
    expect(runtime.bookkeeping().worker_key_states).toBe(0);
  });

  it("invalidates active invocation output across drain", async () => {
    const invokeGate = deferred<unknown>();
    const transport = new DeterministicTransport(async () => invokeGate.promise);
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    const executionPromise = runtime.execute(execution("request-drain-active"));
    await waitUntil(() => transport.requests.length === 1);
    await runtime.drain(workerKey);
    invokeGate.resolve(outcomeEnvelope(callEnvelope("describe", calls.describe, "request-drain-active")));
    const result = await settledValue(executionPromise);
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed" });
    expect(result).not.toHaveProperty("response");
    expect(transport.resets).toBe(0);
    expect(transport.terminations).toBe(1);
  });

  it("invalidates a resetting worker across drain and never repools its late attestation", async () => {
    const resetGate = deferred<unknown>();
    const first = new DeterministicTransport(responseHandler());
    first.reset = async () => { first.resets += 1; return resetGate.promise; };
    const second = new DeterministicTransport(responseHandler());
    const sandbox = new QueueSandbox([first, second]);
    const { runtime } = runtimeWith(sandbox);
    const executionPromise = runtime.execute(execution("request-drain-resetting"));
    await waitUntil(() => first.resets === 1);
    await runtime.drain(workerKey);
    resetGate.resolve({ state_reset: true });
    const result = await settledValue(executionPromise);
    expect(result).toMatchObject({ accepted: false, code: "plugin-sdk:worker_failed" });
    expect(first.terminations).toBe(1);
    expect((await runtime.execute(execution("request-after-drain-reset"))).accepted).toBe(true);
    expect(sandbox.launches).toHaveLength(2);
  });

  it("returns from drain after excluding a pooled worker whose terminate never settles", async () => {
    const transport = new DeterministicTransport(responseHandler());
    const { runtime } = runtimeWith(new QueueSandbox([transport]));
    await runtime.execute(execution("request-pool-before-stuck-drain"));
    transport.terminate = async () => {
      transport.terminations += 1;
      return new Promise<void>(() => undefined);
    };
    await settledValue(runtime.drain(workerKey));
    expect(transport.terminations).toBe(1);
  });
});

class RecordingNodeProcessPort implements RestrictedNodeProcessPort {
  readonly node_executable = "/configured/runtime/node";
  readonly specifications: RestrictedNodeProcessSpec[] = [];
  readonly transport = new DeterministicTransport(responseHandler());

  async launch(specification: RestrictedNodeProcessSpec): Promise<WorkerTransport> {
    this.specifications.push(specification);
    return this.transport;
  }
}

class RecordingIsolation implements PlatformIsolationAdapter {
  readonly requests: PlatformIsolationRequest[] = [];
  constructor(private readonly attestation: PlatformIsolationAttestation = {
    supported: true,
    network_isolated: true,
    workspace_hidden: true,
    isolation_handle: "isolation-1",
  }) {}

  async attest(request: PlatformIsolationRequest): Promise<PlatformIsolationAttestation> {
    this.requests.push(request);
    return this.attestation;
  }
}

class RecordingBuildAuthority implements TrustedWorkerBuildAuthorityPort {
  readonly keys: WorkerKey[] = [];
  constructor(private readonly metadata: unknown) {}

  async resolve(worker_key: WorkerKey): Promise<TrustedWorkerBuildMetadata> {
    this.keys.push(worker_key);
    return this.metadata as TrustedWorkerBuildMetadata;
  }
}

interface SandboxFixture {
  readonly root: string;
  readonly launch: RestrictedWorkerLaunch;
  readonly metadata: TrustedWorkerBuildMetadata;
}

async function sandboxFixture(): Promise<SandboxFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "urdira-sandbox-")));
  const packageRoot = join(root, "package");
  const scratchPrivateRoot = join(root, "private-scratch");
  const scratchRoot = join(scratchPrivateRoot, "run-1");
  const workspaceRoot = join(root, "workspace");
  const homeRoot = join(root, "home");
  const credentialRoot = join(root, "credentials");
  await mkdir(packageRoot);
  await mkdir(scratchRoot, { recursive: true });
  await mkdir(workspaceRoot);
  await mkdir(homeRoot);
  await mkdir(credentialRoot);
  const entrypoint = join(packageRoot, "worker.mjs");
  await writeFile(entrypoint, "export {};", "utf8");
  return {
    root,
    launch: { worker_key: workerKey },
    metadata: {
      worker_key: workerKey,
      package_read_root: packageRoot,
      package_entrypoint: entrypoint,
      scratch_private_root: scratchPrivateRoot,
      scratch_root: scratchRoot,
      workspace_root: workspaceRoot,
      home_root: homeRoot,
      credential_roots: [credentialRoot],
    },
  };
}

describe("restricted Node sandbox and mandatory platform isolation", () => {
  it("resolves all paths from exact-key trusted build authority and constructs a closed Node specification", async () => {
    const fixture = await sandboxFixture();
    try {
      const processPort = new RecordingNodeProcessPort();
      const isolation = new RecordingIsolation();
      const authority = new RecordingBuildAuthority(fixture.metadata);
      await new RestrictedNodeSandbox(processPort, isolation, authority, metadataMaterializationLimits).launch(fixture.launch);

      expect(processPort.specifications).toEqual([{
        runtime: "node",
        executable: "/configured/runtime/node",
        arguments: [
          "--permission",
          `--allow-fs-read=${fixture.metadata.package_read_root}`,
          `--allow-fs-write=${fixture.metadata.scratch_root}`,
          fixture.metadata.package_entrypoint,
        ],
        shell: false,
        cwd: fixture.metadata.scratch_root,
        environment: {
          NODE_ENV: "production",
          LANG: "C",
          TZ: "UTC",
          URDIRA_WORKER_PROTOCOL_VERSION: "8",
        },
        package_read_roots: [fixture.metadata.package_read_root],
        scratch_write_root: fixture.metadata.scratch_root,
        permissions: {
          child_process: false,
          native_addons: false,
          worker_threads: false,
        },
        isolation: {
          network_isolated: true,
          workspace_hidden: true,
          isolation_handle: "isolation-1",
        },
      }]);
      expect(isolation.requests).toEqual([{
        package_read_root: fixture.metadata.package_read_root,
        scratch_root: fixture.metadata.scratch_root,
        deny_network: true,
        hide_workspace: true,
      }]);
      expect(authority.keys).toEqual([workerKey]);
      expect(JSON.stringify(processPort.specifications[0])).not.toMatch(/\/private\/workspace|credential|token|password/iu);
      expect(processPort.specifications[0]).not.toHaveProperty("command");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["arbitrary executable", { executable: "/bin/sh" }],
    ["arbitrary arguments", { arguments: ["-c", "id"] }],
    ["environment injection", { environment: { HOME: "/private" } }],
    ["workspace path", { workspace_root: "/private/workspace" }],
    ["package root", { package_read_root: "/caller/package" }],
    ["scratch root", { scratch_root: "/caller/scratch" }],
  ])("rejects %s injection in the closed sandbox launch", async (_name, injected) => {
    const fixture = await sandboxFixture();
    try {
      const processPort = new RecordingNodeProcessPort();
      await expect(new RestrictedNodeSandbox(processPort, new RecordingIsolation(), new RecordingBuildAuthority(fixture.metadata), metadataMaterializationLimits)
        .launch({ ...fixture.launch, ...injected } as RestrictedWorkerLaunch))
        .rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
      expect(processPort.specifications).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects the legacy caller-path shape even when every caller-chosen path exists", async () => {
    const fixture = await sandboxFixture();
    const workspaceEntrypoint = join(fixture.metadata.workspace_root, "worker.mjs");
    await writeFile(workspaceEntrypoint, "export {};", "utf8");
    try {
      const processPort = new RecordingNodeProcessPort();
      const legacyCallerInput = {
        worker_key: workerKey,
        package_read_root: fixture.metadata.workspace_root,
        package_entrypoint: workspaceEntrypoint,
        scratch_private_root: fixture.metadata.scratch_private_root,
        scratch_root: fixture.metadata.scratch_root,
      } as unknown as RestrictedWorkerLaunch;
      await expect(new RestrictedNodeSandbox(
        processPort,
        new RecordingIsolation(),
        new RecordingBuildAuthority(fixture.metadata),
        metadataMaterializationLimits,
      ).launch(legacyCallerInput)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
      expect(processPort.specifications).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects package entrypoint path escape and symlink escape", async () => {
    const fixture = await sandboxFixture();
    const outside = join(fixture.root, "outside.mjs");
    await writeFile(outside, "export {};", "utf8");
    const linked = join(fixture.metadata.package_read_root, "linked.mjs");
    await symlink(outside, linked);
    try {
      const escaped = new RestrictedNodeSandbox(new RecordingNodeProcessPort(), new RecordingIsolation(), new RecordingBuildAuthority({
        ...fixture.metadata,
        package_entrypoint: outside,
      }), metadataMaterializationLimits);
      const symlinked = new RestrictedNodeSandbox(new RecordingNodeProcessPort(), new RecordingIsolation(), new RecordingBuildAuthority({
        ...fixture.metadata,
        package_entrypoint: linked,
      }), metadataMaterializationLimits);
      await expect(escaped.launch(fixture.launch)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
      await expect(symlinked.launch(fixture.launch)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects scratch path and symlink escape from its private root", async () => {
    const fixture = await sandboxFixture();
    const outsideScratch = join(fixture.root, "outside-scratch");
    await mkdir(outsideScratch);
    const linked = join(fixture.metadata.scratch_private_root, "linked");
    await symlink(outsideScratch, linked);
    try {
      const escaped = new RestrictedNodeSandbox(new RecordingNodeProcessPort(), new RecordingIsolation(), new RecordingBuildAuthority({
        ...fixture.metadata,
        scratch_root: outsideScratch,
      }), metadataMaterializationLimits);
      const symlinked = new RestrictedNodeSandbox(new RecordingNodeProcessPort(), new RecordingIsolation(), new RecordingBuildAuthority({
        ...fixture.metadata,
        scratch_root: linked,
      }), metadataMaterializationLimits);
      await expect(escaped.launch(fixture.launch)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
      await expect(symlinked.launch(fixture.launch)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects package and scratch roots that overlap by equality, ancestor, or descendant", async () => {
    const fixture = await sandboxFixture();
    try {
      const nestedScratch = join(fixture.metadata.package_read_root, "scratch");
      await mkdir(nestedScratch);
      const nestedPackage = join(fixture.metadata.scratch_private_root, "package");
      await mkdir(nestedPackage);
      const nestedEntrypoint = join(nestedPackage, "worker.mjs");
      await writeFile(nestedEntrypoint, "export {};", "utf8");
      const cases: TrustedWorkerBuildMetadata[] = [
        { ...fixture.metadata, scratch_private_root: fixture.metadata.package_read_root, scratch_root: nestedScratch },
        { ...fixture.metadata, package_read_root: nestedPackage, package_entrypoint: nestedEntrypoint },
        { ...fixture.metadata, scratch_private_root: fixture.metadata.package_read_root, scratch_root: fixture.metadata.package_read_root },
      ];
      for (const metadata of cases) {
        const processPort = new RecordingNodeProcessPort();
        await expect(new RestrictedNodeSandbox(processPort, new RecordingIsolation(), new RecordingBuildAuthority(metadata), metadataMaterializationLimits).launch(fixture.launch))
          .rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
        expect(processPort.specifications).toEqual([]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects root, broad non-root, workspace, home, and credential authority roots", async () => {
    const fixture = await sandboxFixture();
    try {
      const broadEntrypoint = join(fixture.root, "broad-worker.mjs");
      await writeFile(broadEntrypoint, "export {};", "utf8");
      const protectedEntrypoints: string[] = [];
      for (const root of [fixture.metadata.workspace_root, fixture.metadata.home_root, ...fixture.metadata.credential_roots]) {
        const entrypoint = join(root, "worker.mjs");
        await writeFile(entrypoint, "export {};", "utf8");
        protectedEntrypoints.push(entrypoint);
      }
      const cases: TrustedWorkerBuildMetadata[] = [
        { ...fixture.metadata, package_read_root: "/", package_entrypoint: broadEntrypoint },
        { ...fixture.metadata, package_read_root: fixture.root, package_entrypoint: broadEntrypoint },
        { ...fixture.metadata, package_read_root: fixture.metadata.workspace_root, package_entrypoint: protectedEntrypoints[0]! },
        { ...fixture.metadata, package_read_root: fixture.metadata.home_root, package_entrypoint: protectedEntrypoints[1]! },
        { ...fixture.metadata, package_read_root: fixture.metadata.credential_roots[0]!, package_entrypoint: protectedEntrypoints[2]! },
        { ...fixture.metadata, scratch_private_root: fixture.metadata.workspace_root, scratch_root: fixture.metadata.workspace_root },
      ];
      for (const metadata of cases) {
        const processPort = new RecordingNodeProcessPort();
        await expect(new RestrictedNodeSandbox(processPort, new RecordingIsolation(), new RecordingBuildAuthority(metadata), metadataMaterializationLimits).launch(fixture.launch))
          .rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
        expect(processPort.specifications).toEqual([]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["unsupported", { supported: false, reason_code: "platform_missing" }],
    ["network", { supported: true, network_isolated: false, workspace_hidden: true, isolation_handle: "bad" }],
    ["workspace", { supported: true, network_isolated: true, workspace_hidden: false, isolation_handle: "bad" }],
    ["extra attestation field", { supported: true, network_isolated: true, workspace_hidden: true, isolation_handle: "bad", weakened: true }],
  ] as const)("returns sandbox unsupported when mandatory %s isolation cannot be attested", async (_name, attestation) => {
    const fixture = await sandboxFixture();
    try {
      const processPort = new RecordingNodeProcessPort();
      const sandbox = new RestrictedNodeSandbox(
        processPort,
        new RecordingIsolation(attestation as PlatformIsolationAttestation),
        new RecordingBuildAuthority(fixture.metadata),
        metadataMaterializationLimits,
      );
      await expect(sandbox.launch(fixture.launch)).rejects.toMatchObject({ code: "plugin-sdk:sandbox_unsupported" });
      expect(processPort.specifications).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
