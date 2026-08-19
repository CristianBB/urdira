import { createServer, connect, type Server, type Socket } from "node:net";
import { DaemonError } from "./errors.js";

export const UCE_PROTOCOL_VERSION = 1;
export const UCE_DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface UceRequest {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly call: string;
  readonly deadline_at: string;
  readonly cancellation_id: string;
  readonly payload: unknown;
}

export interface UceResponse {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> };
}

export interface UceProgress {
  readonly protocol_version: number;
  readonly request_id: string;
  readonly event: "progress";
  readonly progress: { readonly phase: string; readonly completed: number; readonly total?: number; readonly message?: string };
}

export type UceFrame = UceRequest | UceResponse | UceProgress;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Namespaced registered error codes, e.g. `storage:repair_source_missing`, `core:execution_failed`, `jsts:unresolved_call`. */
const REGISTERED_CODE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z0-9_]+$/;

/**
 * If a value the handler threw already carries a registered namespaced
 * `code` (from a `StorageError`, `EngineError`, or similar cross-package
 * error), preserve that code, message, and any plain-object `details` as-is
 * on the wire. Returns `undefined` for anything else -- including plain
 * `Error`s and Node system errors like `ENOENT`/`EACCES`, whose bare `code`
 * is not namespaced and must not leak onto the wire.
 */
function foreignWireError(error: unknown): { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> } | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !REGISTERED_CODE_PATTERN.test(code)) return undefined;
  const details = (error as { details?: unknown }).details;
  return { code, message: error.message, details: record(details) ? details : {} };
}

function scheduleAt(deadline: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const schedule = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { callback(); return; }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}

function validateFrame(value: unknown): UceFrame {
  if (!record(value) || value["protocol_version"] !== UCE_PROTOCOL_VERSION || typeof value["request_id"] !== "string" || value["request_id"].length === 0) throw new DaemonError("core:ipc_frame_invalid", "UCE frame has invalid protocol or correlation claims.");
  if (value["event"] === "progress") {
    const progress = value["progress"];
    if (!record(progress) || typeof progress["phase"] !== "string" || typeof progress["completed"] !== "number") throw new DaemonError("core:ipc_frame_invalid", "UCE progress frame is incomplete.");
    return value as unknown as UceProgress;
  }
  if (typeof value["call"] === "string" && typeof value["deadline_at"] === "string" && typeof value["cancellation_id"] === "string" && "payload" in value) return value as unknown as UceRequest;
  if (value["outcome"] === "success" || value["outcome"] === "error" || value["outcome"] === "cancelled") return value as unknown as UceResponse;
  throw new DaemonError("core:ipc_frame_invalid", "UCE frame kind is not registered.");
}

export function encodeUceFrame(frame: UceFrame, maxFrameBytes = UCE_DEFAULT_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.byteLength > maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `UCE frame is ${body.byteLength} bytes; maximum is ${maxFrameBytes}.`);
  const encoded = Buffer.allocUnsafe(body.byteLength + 4);
  encoded.writeUInt32BE(body.byteLength, 0);
  body.copy(encoded, 4);
  return encoded;
}

export function decodeUceFrame(encoded: Uint8Array, maxFrameBytes = UCE_DEFAULT_MAX_FRAME_BYTES): UceFrame {
  if (encoded.byteLength < 4) throw new DaemonError("core:ipc_frame_invalid", "UCE frame is missing its length prefix.");
  const length = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).readUInt32BE(0);
  if (length > maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `UCE frame is ${length} bytes; maximum is ${maxFrameBytes}.`);
  if (encoded.byteLength !== length + 4) throw new DaemonError("core:ipc_frame_invalid", "UCE frame length does not match its payload.");
  try { return validateFrame(JSON.parse(Buffer.from(encoded.buffer, encoded.byteOffset + 4, length).toString("utf8"))); }
  catch (error) { if (error instanceof DaemonError) throw error; throw new DaemonError("core:ipc_frame_invalid", "UCE payload is not valid JSON."); }
}

export class LengthPrefixedDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly maxFrameBytes = UCE_DEFAULT_MAX_FRAME_BYTES) {}
  push(chunk: Uint8Array): UceFrame[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const frames: UceFrame[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > this.maxFrameBytes) throw new DaemonError("core:ipc_frame_too_large", `UCE frame is ${length} bytes; maximum is ${this.maxFrameBytes}.`);
      if (this.pending.byteLength < length + 4) break;
      frames.push(decodeUceFrame(this.pending.subarray(0, length + 4), this.maxFrameBytes));
      this.pending = this.pending.subarray(length + 4);
    }
    return frames;
  }
}

export interface UceRequestContext {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: UceProgress["progress"]) => void;
}
export type UceRequestHandler = (request: UceRequest, context: UceRequestContext) => Promise<unknown>;

export interface LocalIpcServerOptions {
  readonly endpoint: string;
  readonly handler: UceRequestHandler;
  readonly max_frame_bytes?: number;
}

export class LocalIpcServer {
  private readonly server: Server;
  private readonly controllers = new Map<string, AbortController>();
  private readonly maxFrameBytes: number;
  constructor(private readonly options: LocalIpcServerOptions) {
    this.maxFrameBytes = options.max_frame_bytes ?? UCE_DEFAULT_MAX_FRAME_BYTES;
    this.server = createServer((socket) => this.handleSocket(socket));
  }
  async listen(): Promise<void> { await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.options.endpoint, () => { this.server.removeListener("error", reject); resolve(); }); }); }
  async close(): Promise<void> { for (const controller of this.controllers.values()) controller.abort(); await new Promise<void>((resolve) => this.server.close(() => resolve())); }
  private handleSocket(socket: Socket): void {
    const decoder = new LengthPrefixedDecoder(this.maxFrameBytes);
    const seenRequestIds = new Set<string>();
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      try { for (const frame of decoder.push(chunk)) void this.handleFrame(socket, frame, seenRequestIds); }
      catch (error) { socket.destroy(error instanceof Error ? error : undefined); }
    });
  }
  private async handleFrame(socket: Socket, frame: UceFrame, seenRequestIds: Set<string>): Promise<void> {
    if (!("call" in frame)) return;
    const request = frame;
    if (seenRequestIds.has(request.request_id)) { this.write(socket, { protocol_version: UCE_PROTOCOL_VERSION, request_id: request.request_id, outcome: "error", error: { code: "core:ipc_request_invalid", message: "UCE request id was already used on this connection." } }); return; }
    seenRequestIds.add(request.request_id);
    const cancelId = request.call === "core:cancel" && record(request.payload) && typeof request.payload["cancellation_id"] === "string" ? request.payload["cancellation_id"] : undefined;
    if (cancelId) { this.controllers.get(cancelId)?.abort(); this.write(socket, { protocol_version: UCE_PROTOCOL_VERSION, request_id: request.request_id, outcome: "success", payload: { cancelled: true } }, request.call); return; }
    const controller = new AbortController();
    this.controllers.set(request.cancellation_id, controller);
    const reportProgress = (progress: UceProgress["progress"]): void => this.write(socket, { protocol_version: UCE_PROTOCOL_VERSION, request_id: request.request_id, event: "progress", progress }, request.call);
    const deadline = Date.parse(request.deadline_at); let timedOut = false;
    const cancelTimeout = Number.isFinite(deadline) && deadline > Date.now() ? scheduleAt(deadline, () => { timedOut = true; controller.abort(); }) : undefined;
    try {
      if (!Number.isFinite(deadline)) throw new DaemonError("core:ipc_request_invalid", "UCE request deadline is not a valid timestamp.");
      if (deadline <= Date.now()) throw new DaemonError("core:ipc_timeout", "UCE request deadline has expired.");
      const payload = await this.options.handler(request, { signal: controller.signal, reportProgress });
      if (timedOut) throw new DaemonError("core:ipc_timeout", "UCE request exceeded its deadline.");
      this.write(socket, { protocol_version: UCE_PROTOCOL_VERSION, request_id: request.request_id, outcome: controller.signal.aborted ? "cancelled" : "success", ...(controller.signal.aborted ? {} : { payload }) }, request.call);
    } catch (error) {
      const wireError = timedOut
        ? { code: "core:ipc_timeout", message: "UCE request exceeded its deadline.", details: {} }
        : error instanceof DaemonError
        ? { code: error.code, message: error.message, details: error.details }
        : foreignWireError(error) ?? { code: "core:execution_failed", message: error instanceof Error ? error.message : "UCE request failed.", details: {} };
      this.write(socket, { protocol_version: UCE_PROTOCOL_VERSION, request_id: request.request_id, outcome: timedOut ? "error" : controller.signal.aborted ? "cancelled" : "error", error: wireError }, request.call);
    } finally { cancelTimeout?.(); this.controllers.delete(request.cancellation_id); }
  }
  /**
   * `encodeUceFrame` throws `core:ipc_frame_too_large` (a registered
   * `DaemonError`) when a frame's JSON-encoded body exceeds `maxFrameBytes`
   * -- reachable in practice whenever a handler's result embeds a large
   * value (e.g. `core:find_records` returning a record whose body is huge).
   * The old behavior swallowed that error into a bare `socket.destroy()`,
   * which orphaned the request: the client had no error frame to key its
   * rejection on and could only ever discover the failure by hitting its own
   * request-timeout deadline (`LocalIpcClient`'s `cancelTimeout`), long after
   * the daemon already knew what went wrong. Every other write failure
   * (frame-invalid encode errors, a socket that's already gone, etc.) keeps
   * the original destroy-and-give-up behavior -- those aren't a size problem
   * a smaller frame can route around.
   *
   * `call` (the originating request's `call` name, when known -- omitted
   * only for internal frames that were never routed through a request) lets
   * the compact fallback error name which operation's response overflowed,
   * not just that some response somewhere did.
   */
  private write(socket: Socket, frame: UceFrame, call?: string): void {
    if (socket.destroyed) return;
    try {
      socket.write(encodeUceFrame(frame, this.maxFrameBytes));
      return;
    } catch (error) {
      const response: UceResponse | undefined = "outcome" in frame ? frame : undefined;
      const isFrameTooLarge = error instanceof DaemonError && error.code === "core:ipc_frame_too_large";
      if (!response || !isFrameTooLarge) {
        socket.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const operation = call ?? response.request_id;
      const fallback: UceResponse = {
        protocol_version: UCE_PROTOCOL_VERSION,
        request_id: response.request_id,
        outcome: "error",
        error: { code: "core:ipc_frame_too_large", message: `The response for "${operation}" exceeded the maximum IPC frame size (${error.message})`, details: {} },
      };
      try { socket.write(encodeUceFrame(fallback, this.maxFrameBytes)); }
      catch { socket.destroy(); }
    }
  }
}

export interface LocalIpcClientOptions { readonly endpoint: string; readonly max_frame_bytes?: number; readonly request_timeout_ms?: number; }
export interface LocalIpcRequestOptions { readonly signal?: AbortSignal; readonly on_progress?: (progress: UceProgress["progress"]) => void; }

export class LocalIpcClient {
  private sequence = 0;
  constructor(private readonly options: LocalIpcClientOptions) {}
  async request(call: string, payload: unknown, options: LocalIpcRequestOptions = {}): Promise<UceResponse> {
    const max = this.options.max_frame_bytes ?? UCE_DEFAULT_MAX_FRAME_BYTES;
    const requestId = `ipc-${process.pid}-${this.sequence++}`;
    const cancellationId = `${requestId}:cancel`;
    const deadline = new Date(Date.now() + (this.options.request_timeout_ms ?? 30_000)).toISOString();
    return new Promise<UceResponse>((resolve, reject) => {
      const socket = connect(this.options.endpoint);
      const decoder = new LengthPrefixedDecoder(max);
      let settled = false; let requestSent = false; let cancelRequested = options.signal?.aborted ?? false;
      let cancelTimeout: (() => void) | undefined;
      const finish = (response: UceResponse): void => {
        if (settled) return;
        settled = true;
        cancelTimeout?.();
        socket.end();
        if (response.outcome === "error" && response.error?.code === "core:ipc_timeout") {
          reject(new DaemonError("core:ipc_timeout", response.error.message));
          return;
        }
        resolve(response);
      };
      socket.once("error", (error) => { if (!settled) { settled = true; cancelTimeout?.(); reject(error); } });
      socket.on("data", (chunk) => { for (const frame of decoder.push(chunk)) { if ("event" in frame) options.on_progress?.(frame.progress); else if ("outcome" in frame && frame.request_id === requestId) finish(frame); } });
      const cancel = (): void => { cancelRequested = true; if (!settled && requestSent) socket.write(encodeUceFrame({ protocol_version: UCE_PROTOCOL_VERSION, request_id: `${requestId}:cancel`, call: "core:cancel", deadline_at: new Date(Date.now() + 1_000).toISOString(), cancellation_id: `${cancellationId}:request`, payload: { cancellation_id: cancellationId } }, max)); };
      socket.once("connect", () => { requestSent = true; socket.write(encodeUceFrame({ protocol_version: UCE_PROTOCOL_VERSION, request_id: requestId, call, deadline_at: deadline, cancellation_id: cancellationId, payload }, max)); if (cancelRequested) cancel(); });
      if (options.signal && !options.signal.aborted) options.signal.addEventListener("abort", cancel, { once: true });
      cancelTimeout = scheduleAt(Date.now() + (this.options.request_timeout_ms ?? 30_000), () => { if (settled) return; cancel(); settled = true; socket.destroy(); reject(new DaemonError("core:ipc_timeout", `UCE request exceeded its ${this.options.request_timeout_ms ?? 30_000}ms deadline.`)); });
    });
  }
}
