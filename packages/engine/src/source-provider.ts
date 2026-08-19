import type {
  JsonValue,
  SourceProviderError,
  SourceProviderRequestEnvelope,
  SourceProviderResourceBudget,
  SourceProviderResponseEnvelope,
} from "@urdira/contracts";
import { canonicalBytes, digestBytes } from "@urdira/canonical";

export type SourceProviderCall = "describe" | "enumerate" | "read" | "watch" | "reconcile";
export type SourceProviderOutcome = "success" | "source_changed" | "unavailable" | "deadline_exceeded" | "resource_exhausted" | "cancelled" | "failed";

export interface SourceProvider {
  readonly component_id: string;
  readonly component_version: string;
  describe(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope>;
  enumerate(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope>;
  read(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope>;
  watch(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope>;
  reconcile(request: SourceProviderRequestEnvelope): Promise<SourceProviderResponseEnvelope>;
}

export interface SourceProviderRequestExpectations {
  readonly protocol_version: "1";
  readonly workspace_id: string;
  readonly source_provider_binding_id: string;
  readonly component_id: string;
  readonly component_version: string;
}

export interface SourceProviderRuntime {
  readonly now: () => string;
  readonly monotonic_now: () => number;
  readonly is_cancelled: (cancellationId: string) => boolean;
}

export class SourceProviderOutcomeError extends Error {
  readonly outcome: Exclude<SourceProviderOutcome, "success">;
  readonly provider_error: SourceProviderError;

  constructor(outcome: Exclude<SourceProviderOutcome, "success">, errorCode: string, retryability: string, message: string, detailCode?: string) {
    super(message);
    this.name = "SourceProviderOutcomeError";
    this.outcome = outcome;
    this.provider_error = { error_code: errorCode, retryability, ...(detailCode === undefined ? {} : { detail_code: detailCode }) };
  }
}

export function parseProviderPayload<T>(request: SourceProviderRequestEnvelope): T {
  if (request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", "The provider payload must be an object.");
  }
  return request.payload as T;
}

function parseBudget(serialized: string): SourceProviderResourceBudget {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new SourceProviderOutcomeError("failed", "core:source_provider_budget_invalid", "never", "The resource budget is not valid JSON."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_budget_invalid", "never", "The resource budget must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const field of ["max_duration_ms", "max_response_bytes", "max_observations", "max_watch_events"] as const) {
    const candidate = record[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new SourceProviderOutcomeError("failed", "core:source_provider_budget_invalid", "never", `The resource budget field ${field} is invalid.`);
    }
  }
  return record as unknown as SourceProviderResourceBudget;
}

export function sourceProviderRequestDigest(request: Pick<SourceProviderRequestEnvelope,
  "protocol_version" | "call" | "workspace_id" | "source_provider_binding_id" | "component_id" | "component_version" | "resource_budget" | "payload"
>): string {
  return digestBytes(canonicalBytes({
    protocol_version: request.protocol_version,
    call: request.call,
    workspace_id: request.workspace_id,
    source_provider_binding_id: request.source_provider_binding_id,
    component_id: request.component_id,
    component_version: request.component_version,
    resource_budget: request.resource_budget,
    payload: request.payload,
  }));
}

export function sourceProviderArtifactId(workspaceId: string, normalizedUri: string): string {
  return digestBytes(canonicalBytes({ workspace_id: workspaceId, normalized_uri: normalizedUri }));
}

function validateEnvelope(
  request: SourceProviderRequestEnvelope,
  call: SourceProviderCall,
  expectations: SourceProviderRequestExpectations,
  runtime: SourceProviderRuntime,
): SourceProviderResourceBudget {
  for (const field of ["protocol_version", "request_id", "request_digest", "workspace_id", "source_provider_binding_id", "component_id", "component_version", "deadline_at", "cancellation_id"] as const) {
    if (typeof request[field] !== "string" || request[field].length === 0) {
      throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", `The request field ${field} is required.`);
    }
  }
  if (request.protocol_version !== expectations.protocol_version || request.call !== call
    || request.workspace_id !== expectations.workspace_id
    || request.source_provider_binding_id !== expectations.source_provider_binding_id
    || request.component_id !== expectations.component_id
    || request.component_version !== expectations.component_version) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", "The protocol, binding, or component coordinate is invalid.");
  }
  let expectedDigest: string;
  try { expectedDigest = sourceProviderRequestDigest(request); }
  catch {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", "The request digest input is invalid.");
  }
  if (request.request_digest !== expectedDigest) {
    throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", "The request digest does not match the canonical request payload.");
  }
  const deadline = Date.parse(request.deadline_at);
  if (!Number.isFinite(deadline)) throw new SourceProviderOutcomeError("failed", "core:source_provider_request_invalid", "never", "The deadline is invalid.");
  if (Date.parse(runtime.now()) >= deadline) throw new SourceProviderOutcomeError("deadline_exceeded", "core:source_provider_deadline_exceeded", "retryable", "The provider deadline elapsed.");
  if (runtime.is_cancelled(request.cancellation_id)) throw new SourceProviderOutcomeError("cancelled", "core:source_provider_cancelled", "conditional", "The provider request was cancelled.");
  return parseBudget(request.resource_budget);
}

function responseBase(request: SourceProviderRequestEnvelope): Omit<SourceProviderResponseEnvelope, "outcome"> {
  return {
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    request_digest: request.request_digest,
    call: request.call,
    workspace_id: request.workspace_id,
    source_provider_binding_id: request.source_provider_binding_id,
    component_id: request.component_id,
    component_version: request.component_version,
  };
}

function failure(request: SourceProviderRequestEnvelope, error: SourceProviderOutcomeError): SourceProviderResponseEnvelope {
  return { ...responseBase(request), outcome: error.outcome, error: JSON.stringify(error.provider_error) };
}

// Exact UTF-8 byte length of JSON.stringify(value) computed without materializing
// the serialized string: enumeration payloads embed the whole batch as one giant
// pre-serialized string, and re-stringifying it (escaping every quote) just for a
// size check doubles the peak allocation of the entire scan payload.
function jsonStringBytes(value: string): number {
  let extra = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) extra += 1;
    else if (code < 0x20) extra += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 1 : 5;
  }
  return 2 + Buffer.byteLength(value, "utf8") + extra;
}

function jsonByteLength(value: JsonValue): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return JSON.stringify(value).length;
  if (typeof value === "string") return jsonStringBytes(value);
  if (Array.isArray(value)) {
    let total = value.length === 0 ? 2 : 1 + value.length;
    for (const item of value) total += jsonByteLength(item);
    return total;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  let total = entries.length === 0 ? 2 : 1 + entries.length;
  for (const [key, item] of entries) total += jsonStringBytes(key) + 1 + jsonByteLength(item as JsonValue);
  return total;
}

export async function executeProviderCall(
  request: SourceProviderRequestEnvelope,
  call: SourceProviderCall,
  expectations: SourceProviderRequestExpectations,
  runtime: SourceProviderRuntime,
  operation: (budget: SourceProviderResourceBudget) => Promise<JsonValue>,
): Promise<SourceProviderResponseEnvelope> {
  const started = runtime.monotonic_now();
  try {
    const budget = validateEnvelope(request, call, expectations, runtime);
    const payload = await operation(budget);
    if (runtime.is_cancelled(request.cancellation_id)) throw new SourceProviderOutcomeError("cancelled", "core:source_provider_cancelled", "conditional", "The provider request was cancelled.");
    if (Date.parse(runtime.now()) >= Date.parse(request.deadline_at)) throw new SourceProviderOutcomeError("deadline_exceeded", "core:source_provider_deadline_exceeded", "retryable", "The provider deadline elapsed.");
    if (runtime.monotonic_now() - started > budget.max_duration_ms) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_duration_exhausted", "retryable", "The provider duration budget was exhausted.");
    if (jsonByteLength(payload) > budget.max_response_bytes) throw new SourceProviderOutcomeError("resource_exhausted", "core:source_provider_response_exhausted", "retryable", "The provider response budget was exhausted.");
    return { ...responseBase(request), outcome: "success", payload };
  } catch (error) {
    if (error instanceof SourceProviderOutcomeError) return failure(request, error);
    const message = error instanceof Error ? error.message : "The source provider failed.";
    return failure(request, new SourceProviderOutcomeError("failed", "core:source_provider_failed", "conditional", message));
  }
}

export function providerRuntime(options: {
  readonly now?: () => string;
  readonly monotonic_now?: () => number;
  readonly is_cancelled?: (cancellationId: string) => boolean;
}): SourceProviderRuntime {
  return {
    now: options.now ?? (() => new Date().toISOString()),
    monotonic_now: options.monotonic_now ?? (() => performance.now()),
    is_cancelled: options.is_cancelled ?? (() => false),
  };
}
