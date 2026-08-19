// Runs the existing in-process `createJavascriptTypescriptWorker` logic
// (whole-project TypeScript program build + checking) inside a real
// `node:worker_threads` worker, so the daemon's own event loop is never
// blocked by analysis. This file is the worker thread's *entry point*: it is
// loaded via `new Worker(new URL(...))` (see `thread-transport.ts`), not
// imported directly by any other module, and must therefore ship as compiled
// `dist/worker-thread.js` reachable at runtime (this package's `tsconfig.json`
// already includes all of `src/**/*.ts` in its build).
//
// Wire protocol: the parent posts `{ id, kind: "invoke" | "cancel" | "reset",
// payload }`; this thread replies with exactly one `{ id, kind: "result",
// result }` or `{ id, kind: "error", error: { name, message } }` per message,
// matching `thread-transport.ts`'s `id`-keyed multiplexing (mirrors
// `packages/storage/src/sqlite.ts`'s `SqliteWorkerAdapter` request/response
// shape). Every message and response here is plain JSON-able data --
// `PluginWorkerRequestEnvelope`/`PluginWorkerResponseEnvelope` payloads,
// which is exactly what the in-process `WorkerTransport` already exchanges --
// so nothing non-cloneable (functions, class instances) needs to cross the
// thread boundary. `JavascriptTypescriptWorkerDescriptor.on_analysis_build`
// and `on_analysis_cache_load` are the two exceptions: both are test-only
// instrumentation *functions* and are therefore never passed through
// `workerData` (see `thread-transport.ts`). `analysis_cache_dir`/
// `analysis_cache_max_entries`, by contrast, are plain data (a string and a
// number) and cross the boundary like every other descriptor field -- they
// are what let a scan's fresh, one-thread-per-scan worker (see this file's
// own header comment) still hit a durable, on-disk analysis cache instead of
// forcing a fresh whole-project build every single scan.
import { parentPort, workerData } from "node:worker_threads";
import type { PluginWorkerRequestEnvelope } from "@urdira/plugin-sdk";
import { createJavascriptTypescriptWorker, type JavascriptTypescriptWorkerDescriptor } from "./worker.js";

interface ThreadRequestMessage {
  readonly id: number;
  readonly kind: "invoke" | "cancel" | "reset";
  readonly payload?: unknown;
}

interface ThreadResponseMessage {
  readonly id: number;
  readonly kind: "result" | "error";
  readonly result?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

function errorDetails(error: unknown): { readonly name: string; readonly message: string } {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

const port = parentPort;
if (!port) throw new Error("The JavaScript/TypeScript worker thread entry must be run inside a node:worker_threads worker.");

// `workerData` carries only the plain-data fields of
// `JavascriptTypescriptWorkerDescriptor` (digests); `on_analysis_build`,
// `on_analysis_cache_load`, and `on_analysis_incremental` are all functions
// and cannot cross the thread boundary via structured clone, so a
// thread-based transport never supports those test-only hooks.
const descriptor = (workerData ?? {}) as Omit<JavascriptTypescriptWorkerDescriptor, "on_analysis_build" | "on_analysis_cache_load" | "on_analysis_incremental">;
const worker = createJavascriptTypescriptWorker(descriptor);

port.on("message", (message: ThreadRequestMessage) => {
  void (async (): Promise<void> => {
    try {
      let result: unknown;
      if (message.kind === "invoke") result = await worker.invoke(message.payload as PluginWorkerRequestEnvelope);
      else if (message.kind === "cancel") result = await worker.cancel(message.payload as { readonly cancellation_id: string });
      else result = await worker.reset();
      port.postMessage({ id: message.id, kind: "result", result } satisfies ThreadResponseMessage);
    } catch (error) {
      port.postMessage({ id: message.id, kind: "error", error: errorDetails(error) } satisfies ThreadResponseMessage);
    }
  })();
});
