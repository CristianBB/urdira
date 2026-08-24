// A one-shot `node:worker_threads` transport for `exportIndexPack`
// (`@urdira/engine`'s `index-pack.ts`), so the daemon's `core:index_pack_export`
// RPC runs the export's synchronous bulk row reads off the main event loop
// entirely (see `index-pack-export-worker-thread.ts` for why they are
// synchronous). Structurally mirrors `lexical-thread.ts`, minus the abort
// path: an export holds no write locks, so nothing needs cooperative
// cancellation -- a caller that stops caring simply ignores the result.
import { Worker } from "node:worker_threads";
import type { ExportIndexPackResult } from "@urdira/engine";

export interface IndexPackExportThreadJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly out_path: string;
  readonly require_git_clean?: boolean;
  readonly canonical_root?: string;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: ExportIndexPackResult; }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name?: string; readonly message: string; readonly code?: string }; }
type WorkerReplyMessage = WorkerResultMessage | WorkerErrorMessage;

/** Resolves the compiled worker entry the same self-reference way as `lexical-thread.ts`'s `workerUrl` (see that doc comment for the dist-vs-src rationale). */
function workerUrl(): URL {
  const indexUrl = import.meta.resolve("@urdira/daemon");
  return new URL("index-pack-export-worker-thread.js", indexUrl);
}

function threadError(error: WorkerErrorMessage["error"]): Error {
  const built = new Error(error.message);
  built.name = error.name ?? "Error";
  if (error.code !== undefined) (built as Error & { code?: string }).code = error.code;
  return built;
}

export function runIndexPackExportInThread(job: IndexPackExportThreadJob): Promise<ExportIndexPackResult> {
  const worker = new Worker(workerUrl(), { workerData: job });
  let settled = false;
  return new Promise<ExportIndexPackResult>((resolve, reject) => {
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };
    worker.on("message", (message: WorkerReplyMessage) => {
      settle(() => { if (message.kind === "error") reject(threadError(message.error)); else resolve(message.result); });
      void worker.terminate();
    });
    worker.on("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    worker.on("exit", (code) => settle(() => reject(new Error(`Index pack export worker thread exited with code ${code} before producing a result.`))));
  });
}
