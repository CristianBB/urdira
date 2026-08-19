import { canonicalSha256, deepFreeze, hasExactKeys } from "./canonical.js";
import { sdkError } from "./errors.js";
import { materializePortResult, type PortMaterializationLimits } from "./port-boundary.js";

/**
 * `analyze_closure` (Phase 5.1): a plugin-specific whole-project-analysis
 * query that returns per-file dependency closures (which of the corpus's own
 * scanned files a given file transitively imports) without producing a
 * `FactDelta`. It runs/reuses the same cached whole-project analysis
 * `analyze_artifact` does (see `packages/plugin-javascript-typescript/src/worker.ts`),
 * so a caller can fetch closures once per scan and then narrow each owner's
 * `analyze_artifact` request (both its access manifest and its `files`
 * payload) to just that owner's closure.
 */
export type PluginWorkerCall = "describe" | "discover_partitions" | "analyze_artifact" | "analyze_closure" | "generate_projection";
export type PluginWorkerOutcome = "success" | "inputs_incomplete" | "unsupported" | "cancelled" | "resource_exhausted" | "failed";
export type WorkerRetryMode = "new" | "retry_same";

export interface WorkerKey {
  readonly package_digest: string;
  readonly runtime_contract_version: number;
  readonly executable_build_digest: string;
}

export interface PluginWorkerRequestEnvelope {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
  readonly deadline: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}

export interface PluginWorkerResponseEnvelope {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly request_digest: string;
  readonly call: PluginWorkerCall;
  readonly outcome: PluginWorkerOutcome;
  readonly payload: unknown;
}

// Compatibility aliases name the same authoritative wire models; they do not
// preserve the former non-authoritative fields.
export type PluginWorkerCallEnvelope = PluginWorkerRequestEnvelope;
export type PluginWorkerOutcomeEnvelope = PluginWorkerResponseEnvelope;

export interface WorkerPayloadValidator {
  validate_call(call: PluginWorkerCall, payload: unknown): unknown;
  validate_outcome(call: PluginWorkerCall, outcome: PluginWorkerOutcome, payload: unknown): unknown;
}

const CALLS = new Set<PluginWorkerCall>(["describe", "discover_partitions", "analyze_artifact", "analyze_closure", "generate_projection"]);
const OUTCOMES = new Set<PluginWorkerOutcome>(["success", "inputs_incomplete", "unsupported", "cancelled", "resource_exhausted", "failed"]);

function invalid(message: string): never {
  throw sdkError("plugin-sdk:worker_protocol_invalid", message);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\r\n\t\0]/u.test(value);
}

function isCanonicalDeadline(value: unknown): value is string {
  if (!isNonemptyString(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validatedPayload<T extends PluginWorkerCall | PluginWorkerOutcome>(
  operation: () => unknown,
  kind: T,
  limits: PortMaterializationLimits,
): unknown {
  try {
    return deepFreeze(materializePortResult(operation(), limits));
  } catch {
    return invalid(`Worker ${CALLS.has(kind as PluginWorkerCall) ? "call" : "outcome"} payload is invalid.`);
  }
}

export function workerRequestDigest(input: {
  readonly protocol_version: string;
  readonly request_id: string;
  readonly call: PluginWorkerCall;
  readonly deadline: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}): string {
  return canonicalSha256({
    protocol_version: input.protocol_version,
    request_id: input.request_id,
    call: input.call,
    deadline: input.deadline,
    cancellation_id: input.cancellation_id,
    payload: input.payload,
  });
}

export class ClosedWorkerProtocol {
  constructor(
    private readonly validator: WorkerPayloadValidator,
    private readonly materialization_limits: PortMaterializationLimits,
  ) {
    try {
      materializePortResult(null, materialization_limits);
    } catch {
      invalid("Worker protocol materialization limits are invalid.");
    }
  }

  accept_call(foreignValue: unknown): PluginWorkerRequestEnvelope {
    let value: unknown;
    try {
      value = materializePortResult(foreignValue, this.materialization_limits);
    } catch {
      return invalid("Worker call envelope is malformed.");
    }
    if (!hasExactKeys(value, ["protocol_version", "request_id", "request_digest", "call", "deadline", "cancellation_id", "payload"])
      || !isNonemptyString(value["protocol_version"])
      || !isNonemptyString(value["request_id"])
      || !isNonemptyString(value["request_digest"])
      || typeof value["call"] !== "string"
      || !CALLS.has(value["call"] as PluginWorkerCall)
      || !isCanonicalDeadline(value["deadline"])
      || !isNonemptyString(value["cancellation_id"])) invalid("Worker call envelope is invalid.");
    const call = value["call"] as PluginWorkerCall;
    const payload = validatedPayload(() => this.validator.validate_call(call, value["payload"]), call, this.materialization_limits);
    const expectedDigest = workerRequestDigest({
      protocol_version: value["protocol_version"],
      request_id: value["request_id"],
      call,
      deadline: value["deadline"],
      cancellation_id: value["cancellation_id"],
      payload,
    });
    if (value["request_digest"] !== expectedDigest) invalid("Worker request digest is invalid.");
    return deepFreeze({
      protocol_version: value["protocol_version"],
      request_id: value["request_id"],
      request_digest: expectedDigest,
      call,
      deadline: value["deadline"],
      cancellation_id: value["cancellation_id"],
      payload,
    });
  }

  accept_outcome(request: PluginWorkerRequestEnvelope, foreignValue: unknown): PluginWorkerResponseEnvelope {
    let value: unknown;
    try {
      value = materializePortResult(foreignValue, this.materialization_limits);
    } catch {
      return invalid("Worker outcome envelope is malformed.");
    }
    if (!hasExactKeys(value, ["protocol_version", "request_id", "request_digest", "call", "outcome", "payload"])
      || !isNonemptyString(value["protocol_version"])
      || !isNonemptyString(value["request_id"])
      || !isNonemptyString(value["request_digest"])
      || typeof value["call"] !== "string"
      || !CALLS.has(value["call"] as PluginWorkerCall)
      || typeof value["outcome"] !== "string"
      || !OUTCOMES.has(value["outcome"] as PluginWorkerOutcome)) invalid("Worker outcome envelope is invalid.");
    if (value["protocol_version"] !== request.protocol_version
      || value["request_id"] !== request.request_id
      || value["request_digest"] !== request.request_digest
      || value["call"] !== request.call) invalid("Worker outcome correlation is invalid.");
    const outcome = value["outcome"] as PluginWorkerOutcome;
    const payload = validatedPayload(
      () => this.validator.validate_outcome(request.call, outcome, value["payload"]),
      outcome,
      this.materialization_limits,
    );
    return deepFreeze({
      protocol_version: request.protocol_version,
      request_id: request.request_id,
      request_digest: request.request_digest,
      call: request.call,
      outcome,
      payload,
    });
  }
}
