// Runs `reconcileLexicalProjection` (`@urdira/engine`'s `lexical-reconciler.ts`)
// inside a real `node:worker_threads` worker, so the daemon's own event loop
// is never blocked by its per-document trigram computation (see
// `lexical-reconciler.ts`'s `yieldToEventLoop` doc comment for the measured
// multi-minute stall this replaces). This file is the worker thread's
// *entry point*: it is loaded via `new Worker(new URL(...))` (see
// `lexical-thread.ts`), not imported directly by any other module, and must
// therefore ship as compiled `dist/lexical-worker-thread.js` reachable at
// runtime (this package's `tsconfig.json` already includes all of
// `src/**/*.ts` in its build) -- mirrors
// `packages/plugin-javascript-typescript/src/worker-thread.ts` exactly.
//
// Wire protocol: the parent posts `workerData` once (the job description,
// see `LexicalThreadJob` in `lexical-thread.ts`) and may later post
// `{ kind: "abort" }` at most once; this thread replies with exactly one
// `{ kind: "result", result }` or `{ kind: "error", error: { name, message,
// code } }`, matching `lexical-thread.ts`'s single-shot expectations
// (mirrors `packages/plugin-javascript-typescript/src/worker-thread.ts`'s
// per-message reply shape, collapsed to one reply per worker lifetime since
// a lexical worker only ever runs exactly one job).
import { parentPort, workerData } from "node:worker_threads";
import { reconcileLexicalProjection, type ReconcileLexicalProjectionResult } from "@urdira/engine";
import { createDurableStorage } from "@urdira/storage";

interface LexicalWorkerJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly max_document_bytes?: number;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: ReconcileLexicalProjectionResult; }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name: string; readonly message: string; readonly code?: string }; }
type WorkerReplyMessage = WorkerResultMessage | WorkerErrorMessage;

function errorDetails(error: unknown): WorkerErrorMessage["error"] {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(code === undefined ? {} : { code }),
  };
}

const port = parentPort;
if (!port) throw new Error("The lexical maintenance worker thread entry must be run inside a node:worker_threads worker.");

const job = workerData as LexicalWorkerJob;

// Set by an `{ kind: "abort" }` message from `lexical-thread.ts`'s
// `LexicalThreadRun.abort()`; polled by `reconcileLexicalProjection`'s
// `should_abort` between documents (see that function's doc comment for
// exactly what an abort does and does not discard).
let abortRequested = false;
port.on("message", (message: { readonly kind?: string }) => {
  if (message?.kind === "abort") abortRequested = true;
});

void (async (): Promise<void> => {
  let storage: Awaited<ReturnType<typeof createDurableStorage>> | undefined;
  try {
    // `skip_startup_recovery: true` -- see `DurableStorageOptions`'s doc
    // comment (`packages/storage/src/storage.ts`) for the full rationale:
    // the daemon process that spawned this worker already ran the full
    // multi-workspace recovery sweep once at its own startup and stays
    // alive for this worker's entire lifetime, so repeating that sweep here
    // (which would open and close every OTHER registered workspace's
    // database sequentially, just to launch one workspace's lexical
    // maintenance job) is both redundant and, on an installation with many
    // registered workspaces, far more expensive than the job itself.
    storage = await createDurableStorage({ rootDir: job.data_root, skip_startup_recovery: true });
    const database = await storage.openWorkspace(job.workspace_id);
    const result = await reconcileLexicalProjection({
      database,
      workspace_id: job.workspace_id,
      content: storage.cas,
      ...(job.max_document_bytes === undefined ? {} : { max_document_bytes: job.max_document_bytes }),
      should_abort: () => abortRequested,
    });
    port.postMessage({ kind: "result", result } satisfies WorkerReplyMessage);
  } catch (error) {
    port.postMessage({ kind: "error", error: errorDetails(error) } satisfies WorkerReplyMessage);
  } finally {
    // Closes every workspace this `DurableStorage` opened (just the one
    // above) plus the installation catalog -- see `DurableStorage.close()`.
    await storage?.close().catch(() => undefined);
  }
})();
