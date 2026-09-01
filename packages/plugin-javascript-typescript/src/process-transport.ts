import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { decodeRustWorkerMessage, encodeRustWorkerMessage, MAX_RUST_WORKER_MESSAGE_BYTES, RustWorkerFrameDecoder } from "./rust-protocol.js";
import { createRustSyntaxCommitAnalysisRequest, createRustSyntaxFactsGroupRequest, createRustSyntaxFactsRequest, createRustSyntaxHandshake, type RustSyntaxAnalysisResult, type RustSyntaxAnalyzeRequest, type RustSyntaxFactsGroupResult, type RustSyntaxFactsResult, type RustSyntaxWorkerMessage, validateRustSyntaxWorkerMessage } from "./syntax-protocol.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const AUTOMATIC_CANCEL_TIMEOUT_MS = 5_000;

export interface JavascriptTypescriptProcessDescriptor {
  readonly command: string;
  readonly args?: readonly string[];
  readonly expected_build_identity: string;
  readonly handshake_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  readonly max_message_bytes?: number;
  readonly scratch_directory?: string;
}

export interface JavascriptTypescriptProcessRequestOptions {
  /** Absolute Unix time in milliseconds. The descriptor timeout remains the upper bound. */
  readonly deadline_ms?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

type RustSyntaxFactsInput = Omit<Parameters<typeof createRustSyntaxFactsRequest>[0], "request_id">;
type RustSyntaxFactsGroupInput = Omit<Parameters<typeof createRustSyntaxFactsGroupRequest>[0], "request_id">;
type RustSyntaxCommitAnalysisInput = Omit<Parameters<typeof createRustSyntaxCommitAnalysisRequest>[0], "request_id">;

export interface JavascriptTypescriptProcessTransport {
  readonly process_id: number;
  ready(): Promise<void>;
  is_healthy(): boolean;
  analyze(request: RustSyntaxAnalyzeRequest, options?: JavascriptTypescriptProcessRequestOptions): Promise<RustSyntaxAnalysisResult>;
  readFacts(input: RustSyntaxFactsInput, options?: JavascriptTypescriptProcessRequestOptions): Promise<RustSyntaxFactsResult>;
  readFactsGroup(input: RustSyntaxFactsGroupInput, options?: JavascriptTypescriptProcessRequestOptions): Promise<RustSyntaxFactsGroupResult>;
  commitAnalysis(input: RustSyntaxCommitAnalysisInput, options?: JavascriptTypescriptProcessRequestOptions): Promise<void>;
  cancel(cancellationId: string, options?: JavascriptTypescriptProcessRequestOptions): Promise<void>;
  reset(projectKey?: string, options?: JavascriptTypescriptProcessRequestOptions): Promise<number>;
  shutdown(options?: JavascriptTypescriptProcessRequestOptions): Promise<void>;
  terminate(): Promise<void>;
}

interface PendingResponse {
  readonly resolve: (message: RustSyntaxWorkerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
  readonly timer: NodeJS.Timeout;
}

interface SendOptions extends JavascriptTypescriptProcessRequestOptions {
  readonly byteBudget?: number;
  readonly cancellationId?: string;
  readonly label: string;
  readonly timeoutMs?: number;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(label: string, reason: unknown): Error {
  const suffix = reason === undefined ? "" : `: ${errorOf(reason).message}`;
  const error = new Error(`Rust syntax worker ${label} request was aborted${suffix}.`);
  error.name = "AbortError";
  return error;
}

function boundedTimeout(value: number | undefined, fallback: number, field: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`${field} must be a positive integer no greater than ${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  return timeout;
}

export function createJavascriptTypescriptProcessTransport(descriptor: JavascriptTypescriptProcessDescriptor): JavascriptTypescriptProcessTransport {
  if (descriptor.command.length === 0 || descriptor.expected_build_identity.length === 0) throw new Error("Rust process command and expected build identity are required.");
  const maxMessageBytes = descriptor.max_message_bytes ?? MAX_RUST_WORKER_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0 || maxMessageBytes > MAX_RUST_WORKER_MESSAGE_BYTES) throw new Error("Rust process max_message_bytes is invalid.");
  const handshakeTimeoutMs = boundedTimeout(descriptor.handshake_timeout_ms, DEFAULT_HANDSHAKE_TIMEOUT_MS, "handshake_timeout_ms");
  const requestTimeoutMs = boundedTimeout(descriptor.request_timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS, "request_timeout_ms");
  const child = spawn(descriptor.command, [...(descriptor.args ?? [])], {
    cwd: descriptor.scratch_directory ?? tmpdir(),
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  if (child.pid === undefined) {
    child.kill();
    throw new Error("Rust syntax worker did not expose a process identity.");
  }
  const processId = child.pid;
  const decoder = new RustWorkerFrameDecoder(maxMessageBytes);
  const pending = new Map<string, PendingResponse>();
  const discardedRequestIds = new Set<string>();
  let nextRequest = 1;
  let nextStream = 1;
  let healthy = true;
  let terminationRequested = false;
  let exited = false;
  let handshakeComplete = false;
  let shutdownAcknowledged = false;
  let shutdownRequestId: string | undefined;
  let stdoutFinished = false;
  let terminalError: Error | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });

  const killWorker = (): void => {
    terminationRequested = true;
    if (!exited && !child.killed) child.kill();
  };

  const cleanupPending = (response: PendingResponse): void => {
    clearTimeout(response.timer);
    if (response.signal !== undefined && response.abortListener !== undefined) {
      response.signal.removeEventListener("abort", response.abortListener);
    }
  };

  const rejectPending = (error: Error): void => {
    for (const response of pending.values()) {
      cleanupPending(response);
      response.reject(error);
    }
    pending.clear();
  };

  const failClosed = (cause: unknown): Error => {
    terminalError ??= errorOf(cause);
    healthy = false;
    rejectPending(terminalError);
    killWorker();
    return terminalError;
  };

  const finishStdout = (): void => {
    if (stdoutFinished) return;
    stdoutFinished = true;
    try {
      decoder.finish();
    } catch (error) {
      failClosed(error);
      return;
    }
    if (!shutdownAcknowledged && !terminationRequested) {
      failClosed(new Error("Rust syntax worker stdout ended before clean termination."));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const message = validateRustSyntaxWorkerMessage(decodeRustWorkerMessage(frame.payload));
        if ("cancellation_id" in message && message.cancellation_id !== frame.cancellation_id) throw new Error("Rust syntax worker frame and response cancellation identities differ.");
        const requestId = "request_id" in message ? message.request_id : undefined;
        if (requestId === undefined) throw new Error("Rust syntax worker response has no request identity.");
        if (discardedRequestIds.delete(requestId)) continue;
        const response = pending.get(requestId);
        if (response === undefined) throw new Error("Rust syntax worker returned an unknown or duplicate request identity.");
        if (message.kind === "shutdown_ack" && requestId === shutdownRequestId) shutdownAcknowledged = true;
        pending.delete(requestId);
        cleanupPending(response);
        response.resolve(message);
      }
    } catch (error) {
      failClosed(error);
    }
  });
  child.stdout.once("end", finishStdout);
  child.stdout.once("close", finishStdout);
  child.stdout.on("error", failClosed);

  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 64 * 1024) failClosed(new Error("Rust syntax worker exceeded its bounded stderr allowance."));
  });
  child.stdin.on("error", failClosed);
  child.on("error", failClosed);
  child.on("exit", (code, signal) => {
    exited = true;
    resolveExit();
    if (!shutdownAcknowledged && !terminationRequested) failClosed(new Error(`Rust syntax worker exited before shutdown (${code ?? signal ?? "unknown"}).`));
  });

  const timeoutFor = (options: SendOptions): number => {
    const configuredTimeout = options.timeoutMs ?? requestTimeoutMs;
    if (options.deadline_ms === undefined) return configuredTimeout;
    if (!Number.isSafeInteger(options.deadline_ms) || options.deadline_ms <= 0) throw new Error("deadline_ms must be a positive integer Unix timestamp in milliseconds.");
    return Math.min(configuredTimeout, options.deadline_ms - Date.now());
  };

  let sendBestEffortCancel: (cancellationId: string) => void = () => undefined;
  const send = <T extends { readonly request_id: string; readonly cancellation_id?: string }>(message: T, options: SendOptions): Promise<RustSyntaxWorkerMessage> => {
    if (!healthy || terminationRequested || exited) return Promise.reject(terminalError ?? new Error("Rust syntax worker process is unavailable."));
    if (pending.has(message.request_id) || discardedRequestIds.has(message.request_id)) return Promise.reject(failClosed(new Error("Rust syntax worker request identity is already in flight.")));
    if (options.signal?.aborted === true) return Promise.reject(abortError(options.label, options.signal.reason));
    const timeoutMs = timeoutFor(options);
    if (timeoutMs <= 0) return Promise.reject(new Error(`Rust syntax worker ${options.label} request deadline has expired.`));
    const byteBudget = options.byteBudget ?? maxMessageBytes;
    let frames: readonly Buffer[];
    try {
      frames = encodeRustWorkerMessage(message, {
        stream_id: nextStream++,
        cancellation_id: message.cancellation_id ?? "",
        byte_budget: byteBudget,
        in_flight_budget: byteBudget,
      });
    } catch (error) {
      return Promise.reject(errorOf(error));
    }
    return new Promise<RustSyntaxWorkerMessage>((resolve, reject) => {
      const abortListener = options.signal === undefined ? undefined : (): void => {
        const response = pending.get(message.request_id);
        if (response === undefined) return;
        pending.delete(message.request_id);
        discardedRequestIds.add(message.request_id);
        cleanupPending(response);
        response.reject(abortError(options.label, options.signal?.reason));
        if (options.cancellationId !== undefined) sendBestEffortCancel(options.cancellationId);
        else failClosed(new Error(`Rust syntax worker ${options.label} request was aborted without a cancellation identity.`));
      };
      const timer = setTimeout(() => {
        failClosed(new Error(`Rust syntax worker ${options.label} request timed out.`));
      }, timeoutMs);
      const response: PendingResponse = {
        resolve,
        reject,
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abortListener === undefined ? {} : { abortListener }),
      };
      pending.set(message.request_id, response);
      options.signal?.addEventListener("abort", abortListener!, { once: true });
      if (options.signal?.aborted === true) {
        abortListener!();
        return;
      }
      try {
        for (const frame of frames) {
          child.stdin.write(frame, (error) => {
            if (error !== null && error !== undefined) failClosed(error);
          });
        }
      } catch (error) {
        failClosed(error);
      }
    });
  };

  sendBestEffortCancel = (cancellationId: string): void => {
    if (!healthy || terminationRequested || exited || !handshakeComplete) return;
    const requestId = `cancel:${nextRequest++}`;
    void send({ kind: "cancel", request_id: requestId, cancellation_id: cancellationId } as const, {
      cancellationId,
      label: "automatic cancellation",
      timeoutMs: Math.min(requestTimeoutMs, AUTOMATIC_CANCEL_TIMEOUT_MS),
    }).then((message) => {
      if (message.kind !== "cancel_ack" || message.request_id !== requestId || message.cancellation_id !== cancellationId) {
        throw failClosed(new Error("Rust syntax worker cancellation acknowledgement is invalid."));
      }
    }).catch(() => undefined);
  };

  const handshakeId = `handshake:${nextRequest++}`;
  const handshake = send(createRustSyntaxHandshake(handshakeId, descriptor.expected_build_identity), {
    label: "handshake",
    timeoutMs: handshakeTimeoutMs,
  }).then((message) => {
    if (message.kind !== "handshake_ack") throw new Error("Rust syntax worker did not acknowledge the handshake.");
    if (message.worker_build_identity !== descriptor.expected_build_identity) throw new Error("Rust syntax worker build identity does not match the installed build.");
    if (message.max_frame_chunk_bytes !== 256 * 1024 || message.max_message_bytes < maxMessageBytes) throw new Error("Rust syntax worker advertised incompatible transport budgets.");
    handshakeComplete = true;
  }).catch((error) => { throw failClosed(error); });

  const requireHandshake = async (): Promise<void> => {
    await handshake;
    if (!handshakeComplete || !healthy || terminationRequested || exited) throw terminalError ?? new Error("Rust syntax worker handshake was not accepted.");
  };

  return {
    process_id: processId,
    ready: requireHandshake,
    is_healthy: () => healthy && !terminationRequested && !exited && handshakeComplete,
    async analyze(request, options): Promise<RustSyntaxAnalysisResult> {
      await requireHandshake();
      const message = await send(request, {
        ...options,
        byteBudget: Math.min(0xffff_ffff, Math.max(maxMessageBytes, request.budgets.max_source_bytes * 2)),
        cancellationId: request.cancellation_id,
        label: "analyze",
      });
      if (message.kind === "error") throw new Error(`${message.code}: ${message.message}`);
      if (message.kind === "cancelled") throw abortError("analyze", undefined);
      if (message.kind !== "analysis_result" || message.request_id !== request.request_id || message.cancellation_id !== request.cancellation_id || message.project_key !== request.project_key) {
        throw failClosed(new Error("Rust syntax worker analysis response identity is invalid."));
      }
      return message;
    },
    async readFacts(input, options): Promise<RustSyntaxFactsResult> {
      await requireHandshake();
      const requestId = `facts:${nextRequest++}`;
      const request = createRustSyntaxFactsRequest({ request_id: requestId, ...input });
      const message = await send(request, {
        ...options,
        byteBudget: request.max_output_bytes,
        cancellationId: request.cancellation_id,
        label: "read_facts",
      });
      if (message.kind === "error") throw new Error(`${message.code}: ${message.message}`);
      if (message.kind === "cancelled") throw abortError("read_facts", undefined);
      if (message.kind !== "facts_result" || message.request_id !== request.request_id || message.cancellation_id !== request.cancellation_id || message.project_key !== request.project_key || message.path !== request.path) {
        throw failClosed(new Error("Rust syntax worker facts response identity is invalid."));
      }
      return message;
    },
    async readFactsGroup(input, options): Promise<RustSyntaxFactsGroupResult> {
      await requireHandshake();
      const requestId = `facts-group:${nextRequest++}`;
      const request = createRustSyntaxFactsGroupRequest({ request_id: requestId, ...input });
      const message = await send(request, {
        ...options,
        byteBudget: request.max_output_bytes,
        cancellationId: request.cancellation_id,
        label: "read_facts_group",
      });
      if (message.kind === "error") throw new Error(`${message.code}: ${message.message}`);
      if (message.kind === "cancelled") throw abortError("read_facts_group", undefined);
      if (message.kind !== "facts_group_result" || message.request_id !== request.request_id || message.cancellation_id !== request.cancellation_id || message.project_key !== request.project_key) {
        throw failClosed(new Error("Rust syntax worker fact-group response identity is invalid."));
      }
      return message;
    },
    async commitAnalysis(input, options): Promise<void> {
      await requireHandshake();
      const requestId = `commit:${nextRequest++}`;
      const request = createRustSyntaxCommitAnalysisRequest({ request_id: requestId, ...input });
      const message = await send(request, {
        ...options,
        label: "commit_analysis",
      });
      if (message.kind === "error") throw new Error(`${message.code}: ${message.message}`);
      if (message.kind !== "commit_analysis_ack" || message.request_id !== request.request_id || message.project_key !== request.project_key || message.analysis_token !== request.analysis_token) {
        throw failClosed(new Error("Rust syntax worker commit acknowledgement is invalid."));
      }
    },
    async cancel(cancellationId, options): Promise<void> {
      await requireHandshake();
      const requestId = `cancel:${nextRequest++}`;
      const message = await send({ kind: "cancel", request_id: requestId, cancellation_id: cancellationId } as const, {
        ...options,
        label: "cancel",
      });
      if (message.kind !== "cancel_ack" || message.request_id !== requestId || message.cancellation_id !== cancellationId) throw failClosed(new Error("Rust syntax worker cancellation acknowledgement is invalid."));
    },
    async reset(projectKey, options): Promise<number> {
      await requireHandshake();
      const requestId = `reset:${nextRequest++}`;
      const message = await send({ kind: "reset", request_id: requestId, ...(projectKey === undefined ? {} : { project_key: projectKey }) }, {
        ...options,
        label: "reset",
      });
      if (message.kind !== "reset_ack" || message.request_id !== requestId) throw failClosed(new Error("Rust syntax worker reset acknowledgement is invalid."));
      return message.reset_projects;
    },
    async shutdown(options): Promise<void> {
      await requireHandshake();
      const requestId = `shutdown:${nextRequest++}`;
      shutdownRequestId = requestId;
      const operationDeadlineMs = Math.min(options?.deadline_ms ?? Number.MAX_SAFE_INTEGER, Date.now() + requestTimeoutMs);
      const message = await send({ kind: "shutdown", request_id: requestId }, {
        ...options,
        deadline_ms: operationDeadlineMs,
        label: "shutdown",
      });
      if (message.kind !== "shutdown_ack" || message.request_id !== requestId) throw failClosed(new Error("Rust syntax worker shutdown acknowledgement is invalid."));
      healthy = false;
      terminationRequested = true;
      child.stdin.end();
      const exitTimeoutMs = operationDeadlineMs - Date.now();
      if (exitTimeoutMs <= 0) throw failClosed(new Error("Rust syntax worker shutdown did not terminate the process before its deadline."));
      let exitTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(() => reject(failClosed(new Error("Rust syntax worker shutdown did not terminate the process."))), exitTimeoutMs);
        }),
      ]).finally(() => { if (exitTimer !== undefined) clearTimeout(exitTimer); });
    },
    async terminate(): Promise<void> {
      if (exited) return;
      healthy = false;
      const error = new Error("Rust syntax worker process was terminated.");
      rejectPending(error);
      killWorker();
      await exit;
    },
  };
}
