// Runs `exportIndexPack` (`@urdira/engine`'s `index-pack.ts`) inside a real
// `node:worker_threads` worker. The export's bulk row reads are deliberately
// SYNCHRONOUS on their own thread (a private read-only `DatabaseSync`
// connection -- see `exportIndexPack`'s `rawDatabase` comment for the
// measured structured-clone cost that design removes), so running it on the
// daemon's main event loop would stall every status/query RPC for the whole
// export. This file is the worker thread's *entry point*: it is loaded via
// `new Worker(new URL(...))` (see `index-pack-export-thread.ts`), not
// imported directly by any other module, and must ship as compiled
// `dist/index-pack-export-worker-thread.js` -- mirrors
// `lexical-worker-thread.ts` exactly.
//
// Wire protocol: the parent posts `workerData` once (the job description);
// this thread replies with exactly one `{ kind: "result", result }` or
// `{ kind: "error", error: { name, message, code } }`. No abort message: an
// export takes no write locks (read-only connection, output file on local
// disk), so there is nothing a cooperative abort would protect.
import { parentPort, workerData } from "node:worker_threads";
import { exportIndexPack, type ExportIndexPackResult } from "@urdira/engine";
import { createDurableStorage } from "@urdira/storage";

interface IndexPackExportWorkerJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly out_path: string;
  readonly require_git_clean?: boolean;
  readonly canonical_root?: string;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: ExportIndexPackResult; }
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
if (!port) throw new Error("The index pack export worker thread entry must be run inside a node:worker_threads worker.");

const job = workerData as IndexPackExportWorkerJob;

void (async (): Promise<void> => {
  let storage: Awaited<ReturnType<typeof createDurableStorage>> | undefined;
  try {
    // `skip_startup_recovery: true`: same rationale as `lexical-worker-thread.ts`
    // -- the daemon that spawned this worker already ran the recovery sweep.
    storage = await createDurableStorage({ rootDir: job.data_root, skip_startup_recovery: true });
    const database = await storage.openWorkspace(job.workspace_id);
    const result = await exportIndexPack({
      database,
      workspace_id: job.workspace_id,
      out_path: job.out_path,
      ...(job.require_git_clean ? { require_git_clean: true } : {}),
      ...(job.canonical_root === undefined ? {} : { canonical_root: job.canonical_root }),
    });
    port.postMessage({ kind: "result", result } satisfies WorkerReplyMessage);
  } catch (error) {
    port.postMessage({ kind: "error", error: errorDetails(error) } satisfies WorkerReplyMessage);
  } finally {
    await storage?.close().catch(() => undefined);
  }
})();
