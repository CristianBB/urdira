// v4 sibling of `index-pack-export-worker-thread.ts`: runs `exportV4IndexPack`
// (`@urdira/engine`'s `index-pack.ts`) inside a real `node:worker_threads`
// worker, so the RPC handler's caller (`core:index_pack_export`,
// `packages/daemon/src/runtime.ts`) never blocks its own event loop on the
// export's file I/O (streaming the whole `structural/` directory through
// gzip can be tens to hundreds of MB even for a modest workspace).
//
// Unlike the v3 export, `exportV4IndexPack` needs no `DurableStorage`/
// `WorkspaceDatabase` at all -- it opens its own short-lived, read-only
// connection directly against `databasePath` (`openSqliteDatabase` inside
// `index-pack.ts`) purely to read `merkle_roots`/`snapshots` metadata, then
// streams `workspace.sqlite` and every file under `structuralRoot`/
// `sidecarRoot` byte-for-byte. So this worker's job description carries
// already-resolved absolute paths (computed on the main thread via
// `structuralStoreDirFor`/`sidecarScanDirFor`, cheap pure functions) rather
// than a `data_root` + `createDurableStorage` bootstrap like the v3 worker.
//
// Wire protocol: identical shape to `index-pack-export-worker-thread.ts` --
// the parent posts `workerData` once; this thread replies with exactly one
// `{ kind: "result", result }` or `{ kind: "error", error: { name, message, code } }`.
import { parentPort, workerData } from "node:worker_threads";
import { exportV4IndexPack, type V4IndexPackManifest } from "@urdira/engine";

interface IndexPackExportV4WorkerJob {
  readonly database_path: string;
  readonly structural_root: string;
  readonly sidecar_root: string;
  readonly workspace_id: string;
  readonly out_path: string;
  readonly require_git_clean?: boolean;
  readonly canonical_root?: string;
}

interface IndexPackExportV4Result {
  readonly pack_path: string;
  readonly manifest: V4IndexPackManifest;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: IndexPackExportV4Result; }
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
if (!port) throw new Error("The v4 index pack export worker thread entry must be run inside a node:worker_threads worker.");

const job = workerData as IndexPackExportV4WorkerJob;

void (async (): Promise<void> => {
  try {
    const { packPath, manifest } = await exportV4IndexPack({
      databasePath: job.database_path,
      structuralRoot: job.structural_root,
      sidecarRoot: job.sidecar_root,
      workspaceId: job.workspace_id,
      outputPath: job.out_path,
      ...(job.require_git_clean ? { requireGitClean: true } : {}),
      ...(job.canonical_root === undefined ? {} : { canonicalRoot: job.canonical_root }),
    });
    port.postMessage({ kind: "result", result: { pack_path: packPath, manifest } } satisfies WorkerReplyMessage);
  } catch (error) {
    port.postMessage({ kind: "error", error: errorDetails(error) } satisfies WorkerReplyMessage);
  }
})();
