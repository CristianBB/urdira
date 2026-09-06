// v4 sibling of `index-pack-export-thread.ts`: a one-shot `node:worker_threads`
// transport for `exportV4IndexPack` (`@urdira/engine`'s `index-pack.ts`).
// Structurally identical to the v3 runner (same message shape, same
// terminate-on-settle contract, no abort path -- an export holds no write
// locks) -- see that file's doc comment for the full rationale.
import { Worker } from "node:worker_threads";
import type { V4IndexPackManifest } from "@urdira/engine";

export interface IndexPackExportV4ThreadJob {
  readonly database_path: string;
  readonly structural_root: string;
  readonly sidecar_root: string;
  readonly workspace_id: string;
  readonly out_path: string;
  readonly require_git_clean?: boolean;
  readonly canonical_root?: string;
}

export interface IndexPackExportV4ThreadResult {
  readonly pack_path: string;
  readonly manifest: V4IndexPackManifest;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: IndexPackExportV4ThreadResult; }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name?: string; readonly message: string; readonly code?: string }; }
type WorkerReplyMessage = WorkerResultMessage | WorkerErrorMessage;

/** Resolves the compiled worker entry the same self-reference way as `index-pack-export-thread.ts`'s `workerUrl` (see that doc comment for the dist-vs-src rationale). */
function workerUrl(): URL {
  const indexUrl = import.meta.resolve("@urdira/daemon");
  return new URL("index-pack-export-v4-worker-thread.js", indexUrl);
}

function threadError(error: WorkerErrorMessage["error"]): Error {
  const built = new Error(error.message);
  built.name = error.name ?? "Error";
  if (error.code !== undefined) (built as Error & { code?: string }).code = error.code;
  return built;
}

export function runIndexPackExportV4InThread(job: IndexPackExportV4ThreadJob): Promise<IndexPackExportV4ThreadResult> {
  const worker = new Worker(workerUrl(), { workerData: job });
  let settled = false;
  return new Promise<IndexPackExportV4ThreadResult>((resolve, reject) => {
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
    worker.on("exit", (code) => settle(() => reject(new Error(`v4 index pack export worker thread exited with code ${code} before producing a result.`))));
  });
}
