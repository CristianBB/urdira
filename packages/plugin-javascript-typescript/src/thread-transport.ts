// A `WorkerTransport` (same interface `createJavascriptTypescriptWorker`
// implements in-process, `@urdira/plugin-sdk`) backed by a real
// `node:worker_threads` worker running `worker-thread.ts`'s compiled output.
// This is a direct worker_threads transport, not a `SupervisedPluginRuntime`
// integration (`@urdira/plugin-sdk`'s pooled/quarantined worker supervisor):
// a full scan creates exactly one thread and terminates it in the caller's
// existing `finally { await worker.terminate(); }` (see
// `apps/urdira/src/index.ts`), so none of the supervisor's cross-request
// pooling, quarantine, or request-identity machinery applies yet. Reusing a
// pooled worker across scans (rather than one thread per scan) is the
// natural Phase 5 hook, once `SupervisedPluginRuntime` is wired up.
import { Worker } from "node:worker_threads";
import type { PluginWorkerRequestEnvelope, WorkerTransport } from "@urdira/plugin-sdk";
import { createJavascriptTypescriptWorker } from "./worker.js";

export interface JavascriptTypescriptThreadDescriptor {
  readonly compatibility_declaration_digest?: string;
  readonly registry_contribution_digest?: string;
  readonly analysis_digest?: string;
  readonly analysis_configuration_digest?: string;
  readonly cas_root?: string;
  readonly source_load_concurrency?: number;
  readonly source_load_max_in_flight_bytes?: number;
  readonly analysis_cache_dir?: string;
  readonly analysis_cache_max_entries?: number;
  readonly native_batch_transport?: "response" | "host";
}

interface ThreadResponseMessage {
  readonly id: number;
  readonly kind: "result" | "error";
  readonly result?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly retry_in_process: () => Promise<unknown>;
}

/**
 * Resolves the compiled worker-thread entry point the SAME way
 * `apps/urdira/src/index.ts`'s `javascriptTypescriptWorkerAssetBytes` already
 * resolves this package's sibling `dist/worker.js`: `import.meta.resolve`
 * against this package's own published name. This is a Node *self-reference*
 * resolution (a package resolving its own name via its `package.json`
 * `exports` field), which works identically whether the resolving module is
 * itself running from `dist` (the built app) or from `src` (vitest, which
 * runs test files -- and the packages they import -- directly from
 * TypeScript source): either way, resolution walks up to this package's own
 * `package.json` and follows its `exports["."]` to `dist/index.js`, then
 * `worker-thread.js` resolves as an actual sibling file in that same `dist`
 * directory. That requires `dist/worker-thread.js` to already exist, which
 * `pnpm test`/`pnpm --filter @urdira/plugin-javascript-typescript build`
 * guarantees before either vitest or the built app ever runs this.
 */
function workerThreadUrl(): URL {
  const indexUrl = import.meta.resolve("@urdira/plugin-javascript-typescript");
  return new URL("worker-thread.js", indexUrl);
}

export function createJavascriptTypescriptThreadTransport(descriptor: JavascriptTypescriptThreadDescriptor = {}): WorkerTransport {
  const worker = new Worker(workerThreadUrl(), { workerData: descriptor });
  let nextId = 1;
  let closed = false;
  // macOS can report `spawn EBADF` while the process is under heavy file and
  // thread pressure. The worker thread is then permanently unusable, but the
  // language plugin itself is still valid. Keep the same transport contract
  // and continue in-process so one transient OS resource failure cannot leave
  // a workspace stuck in indexing (or make the pool reuse a dead worker).
  let inProcessFallback: WorkerTransport | undefined;
  const pending = new Map<number, PendingRequest>();

  const failAllPending = (error: Error): void => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  worker.on("message", (message: ThreadResponseMessage) => {
    const entry = pending.get(message.id);
    if (!entry) return;
      pending.delete(message.id);
      if (message.kind === "error") {
        const messageText = message.error?.message ?? "JavaScript/TypeScript worker thread failed.";
        // A worker can survive long enough to serialize an OS-level spawn
        // failure through the protocol instead of emitting it on Worker's
        // `error` event. Treat both forms identically so the request is
        // retried on the same in-process recovery transport.
        if (!closed && messageText.includes("spawn EBADF")) {
          inProcessFallback ??= createJavascriptTypescriptWorker(descriptor);
          void entry.retry_in_process().then(entry.resolve, entry.reject);
        } else {
          entry.reject(new Error(`${message.error?.name ?? "Error"}: ${messageText}`));
        }
      } else {
      entry.resolve(message.result);
    }
  });
  worker.on("error", (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const errno = normalized as NodeJS.ErrnoException;
    if (!closed && (errno.code === "EBADF" || normalized.message.includes("spawn EBADF"))) {
      inProcessFallback ??= createJavascriptTypescriptWorker(descriptor);
      const toRetry = [...pending.values()];
      pending.clear();
      for (const request of toRetry) void request.retry_in_process().then(request.resolve, request.reject);
      return;
    }
    closed = true;
    failAllPending(normalized);
  });
  worker.on("exit", (code) => {
    if (code !== 0 && inProcessFallback === undefined) {
      closed = true;
      failAllPending(new Error(`JavaScript/TypeScript worker thread exited with code ${code}.`));
    }
  });

  const invokeFallback = (kind: "invoke" | "cancel" | "reset", payload?: unknown): Promise<unknown> => {
    const fallback = inProcessFallback;
    if (fallback === undefined) return Promise.reject(new Error("JavaScript/TypeScript worker thread fallback is unavailable."));
    if (kind === "invoke") return fallback.invoke(payload as PluginWorkerRequestEnvelope);
    if (kind === "cancel") return fallback.cancel(payload as { readonly cancellation_id: string });
    return fallback.reset();
  };

  function send(kind: "invoke" | "cancel" | "reset", payload?: unknown): Promise<unknown> {
    if (closed) return Promise.reject(new Error("JavaScript/TypeScript worker thread is terminated."));
    if (inProcessFallback !== undefined) return invokeFallback(kind, payload);
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, retry_in_process: () => invokeFallback(kind, payload) });
      worker.postMessage({ id, kind, payload }, transferableBuffers(payload));
    });
  }

  return {
    is_healthy: () => !closed,
    async invoke(request: PluginWorkerRequestEnvelope): Promise<unknown> {
      return send("invoke", request);
    },
    async cancel(input: { readonly cancellation_id: string }): Promise<void> {
      await send("cancel", input);
    },
    async reset(): Promise<unknown> {
      return send("reset");
    },
    async terminate(): Promise<void> {
      if (closed) return;
      closed = true;
      failAllPending(new Error("JavaScript/TypeScript worker thread is terminated."));
      await Promise.all([
        worker.terminate(),
        inProcessFallback?.terminate() ?? Promise.resolve(),
      ]);
    },
  } as WorkerTransport & { readonly is_healthy: () => boolean };
}

/** Collects complete, private ArrayBuffers owned by a one-shot request. */
function transferableBuffers(value: unknown): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<object>();
  const add = (current: unknown): void => {
    if (ArrayBuffer.isView(current)) {
      if (current.byteOffset === 0 && current.byteLength === current.buffer.byteLength && current.buffer instanceof ArrayBuffer) buffers.push(current.buffer);
      return;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) { for (const item of current) add(item); return; }
    for (const item of Object.values(current)) add(item);
  };
  add(value);
  return [...new Set(buffers)];
}
