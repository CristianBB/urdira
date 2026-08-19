// Runs `reconcileSemanticProjection` (`@urdira/engine`'s `semantic-reconciler.ts`)
// inside a real `node:worker_threads` worker, so the daemon's own event loop
// is never blocked by ONNX tensor prep/inference (see `semantic-thread.ts`'s
// header comment for the measured cross-workspace query-latency contention
// this replaces). This file is the worker thread's *entry point*: it is
// loaded via `new Worker(new URL(...))` (see `semantic-thread.ts`), not
// imported directly by any other module, and must therefore ship as compiled
// `dist/semantic-worker-thread.js` reachable at runtime (this package's
// `tsconfig.json` already includes all of `src/**/*.ts` in its build) --
// mirrors `lexical-worker-thread.ts` exactly.
//
// Wire protocol: the parent posts `workerData` once (the job description,
// see `SemanticThreadJob` in `semantic-thread.ts`) and may later post
// `{ kind: "abort" }` at most once; this thread replies with exactly one
// `{ kind: "result", result }` or `{ kind: "error", error: { name, message,
// code } }`, matching `semantic-thread.ts`'s single-shot expectations
// (mirrors `lexical-worker-thread.ts`'s per-message reply shape, collapsed
// to one reply per worker lifetime since a semantic worker only ever runs
// exactly one job).
//
// STRICTLY OFFLINE (USER DECISION, 2026-08-13, see `semantic-provider-runtime.ts`'s
// own header comment): this worker builds its provider via `buildSemanticProvider`,
// which for a `"neural"` descriptor ALWAYS forces `allow_download: false` --
// a worker thread must never download a model. Model provisioning happens
// exactly once, earlier, at CONFIGURE time (`core:workspace_add`/
// `core:workspace_configure`/`core:configuration_set`, see `runtime.ts`'s
// `ensureAndActivateSemanticProvider`), on the daemon's own main thread, long
// before any maintenance job (threaded or not) ever runs. If the model is
// genuinely absent offline, `buildSemanticProvider` rejects and this
// worker's own `catch` below posts that rejection back as a normal
// `{ kind: "error", ... }` reply -- `runtime.ts`'s `submitSemanticMaintenance`
// only ever takes the threaded path once a provider is already active (see
// its own doc comment), so in practice this rejection path here is a
// defensive backstop, not an expected outcome.
import { parentPort, workerData } from "node:worker_threads";
import { reconcileSemanticProjection, type ReconcileSemanticProjectionResult } from "@urdira/engine";
import { createDurableStorage } from "@urdira/storage";
import { buildSemanticProvider, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";

interface SemanticWorkerJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly descriptor: SemanticProviderDescriptor;
  readonly max_document_bytes?: number;
  readonly embed_batch_size?: number;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: ReconcileSemanticProjectionResult; }
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
if (!port) throw new Error("The semantic maintenance worker thread entry must be run inside a node:worker_threads worker.");

const job = workerData as SemanticWorkerJob;

// Set by an `{ kind: "abort" }` message from `semantic-thread.ts`'s
// `SemanticThreadRun.abort()`; polled by `reconcileSemanticProjection`'s
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
    // database sequentially, just to launch one workspace's semantic
    // maintenance job) is both redundant and, on an installation with many
    // registered workspaces, far more expensive than the job itself.
    storage = await createDurableStorage({ rootDir: job.data_root, skip_startup_recovery: true });
    const database = await storage.openWorkspace(job.workspace_id);
    // See this file's own header comment: `buildSemanticProvider` forces
    // `allow_download: false` for a `"neural"` descriptor unconditionally --
    // this worker never downloads anything, ever.
    const provider = await buildSemanticProvider(job.descriptor);
    const result = await reconcileSemanticProjection({
      database,
      workspace_id: job.workspace_id,
      content: storage.cas,
      provider,
      ...(job.max_document_bytes === undefined ? {} : { max_document_bytes: job.max_document_bytes }),
      ...(job.embed_batch_size === undefined ? {} : { embed_batch_size: job.embed_batch_size }),
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
