// A one-shot `node:worker_threads` transport for `reconcileLexicalProjection`
// (`@urdira/engine`'s `lexical-reconciler.ts`), so the daemon's post-ready
// lexical maintenance job runs off the main event loop entirely instead of
// only yielding between documents (see `lexical-reconciler.ts`'s
// `yieldToEventLoop` doc comment for the multi-minute stall this replaces).
// Structurally this mirrors `packages/plugin-javascript-typescript/src/thread-transport.ts`
// (a real worker thread running compiled `dist` output, resolved the same
// self-reference way), but is one-shot rather than a persistent
// invoke/cancel/reset transport: a lexical worker runs exactly one
// reconcile pass and is terminated, matching `submitLexicalMaintenance`'s
// existing per-run `openWorkspace`/`close` lifecycle in
// `packages/daemon/src/runtime.ts`.
import { Worker } from "node:worker_threads";
import type { ReconcileLexicalProjectionResult } from "@urdira/engine";

export interface LexicalThreadJob {
  readonly data_root: string;
  readonly workspace_id: string;
  readonly max_document_bytes?: number;
}

export interface LexicalThreadRun {
  /** Settles with the worker's `reconcileLexicalProjection` result (or an aborted one -- see `abort` below), or rejects on a genuine worker failure. */
  readonly result: Promise<ReconcileLexicalProjectionResult>;
  /**
   * Requests cooperative, in-worker cancellation (posts `{ kind: "abort" }`;
   * the worker's own `should_abort` polling -- see `lexical-worker-thread.ts` --
   * stops it before its next document and it posts back its own accurate,
   * partial `{ ..., aborted: true }` result through the normal `result`
   * settlement path). If the worker does not respond within the grace
   * period below (e.g. it is wedged inside one document's own synchronous
   * trigram computation), it is hard-terminated and `result` resolves with a
   * synthetic `{ aborted: true }` result instead of rejecting -- a
   * hard-terminate following an explicit abort request is an expected,
   * successful cancellation outcome, not a failure, so callers (`submitLexicalMaintenance`
   * in `packages/daemon/src/runtime.ts`) never log it as one. Idempotent:
   * a second call while the first is still pending, or after `result` has
   * already settled, does nothing.
   */
  abort(): void;
}

interface WorkerResultMessage { readonly kind: "result"; readonly result: ReconcileLexicalProjectionResult; }
interface WorkerErrorMessage { readonly kind: "error"; readonly error: { readonly name?: string; readonly message: string; readonly code?: string }; }
type WorkerReplyMessage = WorkerResultMessage | WorkerErrorMessage;

// How long `abort()` waits for the worker to cooperatively stop and post its
// own result before this transport gives up and hard-terminates it. Well
// under the workspace database's own `busy_timeout_ms` (5s default, see
// `packages/storage/src/sqlite.ts`) so that a wedged lexical worker can
// never itself be the reason a concurrent scan's publish transaction times
// out waiting for this worker's write lock -- the entire point of aborting
// on a new scan in the first place (see `packages/daemon/src/runtime.ts`'s
// `scheduleWorkspaceScan`).
const ABORT_GRACE_MS = 2_000;

/**
 * Resolves the compiled worker-thread entry point the SAME way
 * `packages/plugin-javascript-typescript/src/thread-transport.ts`'s
 * `workerThreadUrl` resolves its own sibling: `import.meta.resolve` against
 * this package's own published name, which works identically whether the
 * resolving module is itself running from `dist` (the built daemon) or from
 * `src` (vitest, which runs test files -- and the packages they import --
 * directly from TypeScript source). That requires `dist/lexical-worker-thread.js`
 * to already exist, which `pnpm test`'s `pnpm exec tsc --build packages/daemon`
 * step guarantees before vitest ever runs this.
 */
function workerUrl(): URL {
  const indexUrl = import.meta.resolve("@urdira/daemon");
  return new URL("lexical-worker-thread.js", indexUrl);
}

function threadError(error: WorkerErrorMessage["error"]): Error {
  const built = new Error(error.message);
  built.name = error.name ?? "Error";
  if (error.code !== undefined) (built as Error & { code?: string }).code = error.code;
  return built;
}

export function runLexicalReconcileInThread(job: LexicalThreadJob): LexicalThreadRun {
  const worker = new Worker(workerUrl(), { workerData: job });
  let settled = false;
  let abortRequested = false;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAbortTimer = (): void => { if (abortTimer) { clearTimeout(abortTimer); abortTimer = undefined; } };

  const result = new Promise<ReconcileLexicalProjectionResult>((resolve, reject) => {
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearAbortTimer();
      run();
    };
    worker.on("message", (message: WorkerReplyMessage) => {
      settle(() => { if (message.kind === "error") reject(threadError(message.error)); else resolve(message.result); });
      void worker.terminate();
    });
    worker.on("error", (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    worker.on("exit", (code) => settle(() => {
      if (abortRequested) {
        // See `abort`'s doc comment: an unanswered abort followed by exit is
        // a successful cancellation, not a failure.
        resolve({ generation: 0, closed: 0, inserted: 0, skipped_oversized: 0, skipped_undecodable: 0, marker_written: false, aborted: true });
        return;
      }
      reject(new Error(`Lexical maintenance worker thread exited with code ${code} before producing a result.`));
    }));
  });

  return {
    result,
    abort(): void {
      if (settled || abortRequested) return;
      abortRequested = true;
      worker.postMessage({ kind: "abort" });
      abortTimer = setTimeout(() => { if (!settled) void worker.terminate(); }, ABORT_GRACE_MS);
      abortTimer.unref?.();
    },
  };
}
